"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviseTranscription = reviseTranscription;
exports.extractAttributesFromText = extractAttributesFromText;
exports.parseFinalAttributes = parseFinalAttributes;
const groq_sdk_1 = require("groq-sdk");
const client = new groq_sdk_1.Groq({
    apiKey: process.env['GROQ_API_KEY'],
});
async function reviseTranscription(rawText) {
    const systemMsg = `You are a transcription editor working in a professional, Australian context where meetings often involve topics 
        in finance, healthcare, or social work and human resources. The user has provided transcribed text that may contain errors. 
        Your job is to correct these errors for clarity and accuracy while preserving the original meaning 
        and the formal tone expected in these settings. Return the corrected text as a JSON object with the key "correctedText". 
        Do not include any markdown formatting, code fences, or extra characters; return pure JSON.
        `;
    const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: systemMsg },
            { role: "user", content: rawText },
        ],
        max_tokens: 200,
        temperature: 0.0,
    });
    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;
    if (!content) {
        throw new Error(`GroqAI response was empty or malformed: ${content}`);
    }
    try {
        const parsed = JSON.parse(content);
        return parsed.correctedText;
    }
    catch {
        return content;
    }
}
// Extract or revise attributes based on corrected text & current attrs
async function extractAttributesFromText(correctedText, template, currAttributes) {
    const systemMsg = `You are an attribute extraction agent specialized for an Australian environment.
        Your work is primarily focused on Finance, Healthcare, Social Work, and Human Resource contexts.
        You are provided with:
        1. The current recorded attribute values.
        2. A list of attributes to extract and the template blocks they belong to.
        3. A corrected transcription of a meeting.

        For each attribute:
        - If the transcription contains a value that is more accurate or contextually appropriate than the current recorded value, return the new value.
        - If the current recorded value is more suitable, retain it.
        - If no relevant value is found in the transcription, do not include that attribute in your result.
        Return your result as a pure JSON object with the key "parsedAttributes" mapping each attribute to its final selected value.
        Do not include any markdown formatting, code fences, or extra characters.
        
        Field Extraction Template:
        ${JSON.stringify(template)}

        Current Recorded Attributes:  
        ${JSON.stringify(currAttributes)}`;
    const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: systemMsg },
            { role: "user", content: correctedText },
        ],
        max_tokens: 200,
        temperature: 0.0,
    });
    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;
    if (!content) {
        throw new Error(`GroqAI response was empty or malformed: ${content}`);
    }
    try {
        const parsed = JSON.parse(content);
        return parsed.parsedAttributes;
    }
    catch {
        return currAttributes;
    }
}
async function parseFinalAttributes(fullTranscript, template, candidateAttributes) {
    // Build the system prompt
    const systemMessage = `You are an attribute extraction revision assistant designed to verify and correct structured data extracted from spoken text.
        You are provided with a complete transcript of a meeting (or conversation between a professional and a client) and
        a list of candidate attribute dictionaries representing form fields and their current extracted values. You will additionally
        be given a list of the attributes and their corresponding form content.

        Your task is to carefully review the given transcript and determine the final, most appropriate value for each attribute. For each field:
        - If the current value is correct, keep it.
        - If it is incorrect, inconsistent, or incomplete, provide the most correct value.
        - If no valid information exists in the transcript for a field, return 'N/A'.

        Return your result as a pure JSON object with a single key "finalAttributes" mapping each field name to its final verified value.
        Do not include any markdown formatting, code fences, or extra characters.

        Form Field Template:
        ${JSON.stringify(template)}

        Candidate Attributes:
        ${JSON.stringify(candidateAttributes, null, 2)}
        `;
    try {
        // Call the GroqAI chat completion API
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: fullTranscript }
            ],
            temperature: 0.0,
            max_tokens: 1000,
        });
        const choice = completion.choices?.[0];
        const message = choice?.message;
        const content = message?.content;
        if (!content) {
            throw new Error(`GroqAI response was empty or malformed: ${content}`);
        }
        // Parse the JSON response
        const parsed = JSON.parse(content);
        console.log("Final sweep completed. Verified attributes:", parsed.finalAttributes);
        return parsed.finalAttributes;
    }
    catch (err) {
        console.error("Error during final attribute extraction:", err);
        // return the candidate fields to their current_values
        return candidateAttributes;
    }
}
