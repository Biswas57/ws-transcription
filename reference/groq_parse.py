import json
import os
from typing import List, Dict, Any
from groq import Groq
from pydantic import BaseModel

# Create a global Groq client and usage counter.
client = Groq(
    api_key=os.getenv("GROQ_API_KEY")
)
# --------------------
# 1) Pydantic Models
# --------------------
class TranscriptionRevisionResponse(BaseModel):
    """Model for step 2 - Correcting or refining the transcription."""
    correctedText: str

class AttributeExtractionResponse(BaseModel):
    """
    Model for step 3 & 4 - Parsing the text to find values for each template attribute.
    The 'parsedAttributes' field is a dictionary of { attribute_name: extracted_value }.
    """
    parsedAttributes: Dict[str, str]
    
class FinalAttributeExtractionResponse(BaseModel):
    """
    Model for final attribute selection.
    The 'finalAttributes' field is a dictionary of { attribute_name: final_selected_value }.
    """
    finalAttributes: Dict[str, str]

# --------------------
# 2) Step 2: Revise Transcribed Text
# --------------------
def reviseTranscription(rawText: str) -> str:
    """
    Takes the raw transcribed text (possibly with errors) and uses GPT to refine it.
    Returns the corrected transcription.
    """
    systemMessage = """
You are a transcription editor working in a professional, Australian context where meetings often involve topics 
in finance, healthcare, or social work and human resources. The user has provided transcribed text that may contain errors. 
Your job is to correct these errors for clarity and accuracy while preserving the original meaning 
and the formal tone expected in these settings. Return the corrected text as a JSON object with the key "correctedText". 
Do not include any markdown formatting, code fences, or extra characters; return pure JSON.
"""
    completion = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": systemMessage},
            {"role": "user", "content": rawText},
        ],
        max_tokens=100,
        temperature=0.0,
    )
    response_text = completion.choices[0].message.content
    try:
        parsed_response = TranscriptionRevisionResponse.parse_raw(response_text)
    except Exception as e:
        print("Error parsing JSON in reviseTranscription:", e)
        parsed_response = TranscriptionRevisionResponse(correctedText=response_text)
    return parsed_response.correctedText

# --------------------
# 3) Step 3: Extract/Revise Attributes into JSON
# --------------------
def extractAttributesFromText(correctedText: str, currentAttributes: dict, templateAttributes: List[str]) -> Dict[str, str]:
    """
    Takes the refined transcription, the current recorded attributes, and a list of attribute names.
    Uses GPT to compare the values found in the corrected transcription with the current recorded values.
    If the transcription contains a more accurate or contextually appropriate value for an attribute, it should replace the current value.
    Returns a dictionary of { attribute: value } as a JSON object with the key "parsedAttributes".
    """
    systemMessage = f"""
You are an attribute extraction assistant specialized for an Australian environment.
This tool is used primarily in Finance, Healthcare, Social Work, and Human Resource contexts.
You are provided with:
1. A corrected transcription of a meeting.
2. A list of attributes to extract.
3. The current recorded attribute values.
For each attribute:
- If the transcription contains a value that is more accurate or contextually appropriate than the current recorded value, return the new value.
- If the current recorded value is more suitable, retain it.
- If no relevant value is found in the transcription, do not include that attribute in your result.
Return your result as a pure JSON object with the key "parsedAttributes" mapping each attribute to its final selected value.
Do not include any markdown formatting, code fences, or extra characters.
Attributes to find: {templateAttributes}
Current Recorded Attributes: {json.dumps(currentAttributes, indent=2)}
"""
    completion = client.chat.completions.create(
        model="llama-3.3-70b-versatile", 
        messages=[
            {"role": "system", "content": systemMessage},
            {"role": "user", "content": correctedText},
        ],
        max_tokens=200,
        temperature=0.0,
    )
    response_text = completion.choices[0].message.content
    try:
        parsed_response = AttributeExtractionResponse.parse_raw(response_text)
    except Exception as e:
        print("Error parsing JSON in extractAttributesFromText:", e)
        parsed_response = AttributeExtractionResponse(parsedAttributes={})
    return parsed_response.parsedAttributes

# --------------------
# 4) Final Attribute Extraction (Asynchronous)
# --------------------
async def parseFinalAttributes(fullTranscript: str, candidateAttributes: list[dict]) -> dict:
    """
    Given the full transcript and a list of candidate attribute dictionaries extracted over multiple rounds,
    use the OpenAI API to determine the most appropriate value for each attribute based on the transcript context.
    Returns a dictionary mapping each attribute name to its final selected value.
    """
    system_message = f"""
You are an attribute extraction revision assistant designed to verify and correct structured data extracted from spoken text. 
You are provided with a complete transcript of a meeting (or conversation between a professional and a client) and 
a list of candidate attribute dictionaries representing form fields and their current extracted values.

Your task is to carefully review the transcript and determine the final, most appropriate value for each attribute. For each field:
- If the current value is correct, keep it.
- If it is incorrect, inconsistent, or incomplete, provide the most correct value.
- If no valid information exists in the transcript for a field, return 'N/A'.

Return your result as a pure JSON object with a single key "finalAttributes" mapping each field name to its final verified value.
Do not include any markdown formatting, code fences, or extra characters.

Transcript:
{fullTranscript}

Candidate Attributes:
{json.dumps(candidateAttributes, indent=2)}
"""
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": system_message}
                ],
                temperature=0.0,
                max_tokens=1000
            )
        )
        response_text = response.choices[0].message.content
        parsed_response = FinalAttributeExtractionResponse.parse_raw(response_text)
        verified_attributes = parsed_response.finalAttributes
        return verified_attributes
    except json.JSONDecodeError as e:
        print("JSON decode error during final sweep:", e)
    except Exception as e:
        print("Error during final sweep with OpenAI API:", e)
    fallback_attributes = {attr["field_name"]: attr["current_value"] for attr in candidateAttributes}
    return fallback_attributes

# --------------------
# 5) Orchestrator: Steps 2–6
# --------------------
def parseTranscribedText(transcribedText: str, currentAttributes: dict, templateAttributes: List[str]):
    """
    High-level function that:
    (1) Revises the transcription (Step 2).
    (2) Extracts attribute values into a JSON structure (Steps 3 & 4).
    (3) Returns the final JSON object with the found attributes (Step 5).
    (4) Revise final full transcript (Step 6) if needed.
    In your actual flow, you might convert this JSON to PDF.
    """
    # Step 2: Revise the transcription.
    correctedText = reviseTranscription(transcribedText)
    
    # Step 3 & 4: Extract attributes.
    parsedAttributes = extractAttributesFromText(correctedText, currentAttributes, templateAttributes)
    
    return correctedText, parsedAttributes
