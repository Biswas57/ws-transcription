import { FieldDef } from "./interfaces";
import { encoding_for_model } from "@dqbd/tiktoken"
import { OpenAI } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const tokenCounter4o = encoding_for_model("gpt-4o-mini");
const tokenCounter = encoding_for_model("gpt-4.1");

const REVISE_SYS_TXT =
    `You are a transcription editor working in a professional, Australian context where meetings often involve topics 
        in finance, healthcare, or social work and human resources. The user has provided transcribed text that may contain errors. 
        Your job is to correct these errors for clarity and accuracy while preserving the original meaning 
        and the formal tone expected in these settings. Return the corrected text as a JSON object with the key "correctedText". 
        Do not include any markdown formatting, code fences, or extra characters; return pure JSON.
        `;


const EXTRACT_SYS_TXT =
    `You are an attribute extraction agent specialized for an Australian environment.
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
        `;

const FINAL_SYS_TXT =
    `You are an attribute extraction revision assistant designed to verify and correct structured data extracted from spoken text.
        You are provided with a complete transcript of a meeting(or conversation between a professional and a client) and
        a list of candidate attribute dictionaries representing form fields and their current extracted values.You will additionally
        be given a list of the attributes and their corresponding form content.

    Your task is to carefully review the given transcript and determine the final, most appropriate value for each attribute.For each field:
        - If the current value is correct, keep it.
        - If it is incorrect, inconsistent, or incomplete, provide the most correct value.
        - If no valid information exists in the transcript for a field, return 'N/A'.

        Return your result as a pure JSON object with a single key "finalAttributes" mapping each field name to its final verified value.
        Do not include any markdown formatting, code fences, or extra characters.`;

// Revise transcription text for accuracy/clarity
export async function reviseTranscription(rawText: string): Promise<string> {
    const tokenCount = tokenCounter4o.encode(rawText).length
    const batchModel = tokenCount < 20 ? "gpt-4.1-nano" : "gpt-4o-mini"

    const completion = await openai.chat.completions.create({
        model: batchModel,
        messages: [
            { role: "system", content: REVISE_SYS_TXT },
            { role: "user", content: rawText },
        ],
        max_tokens: 200,
        response_format: { type: "json_object" },
        temperature: 0.0,
    });

    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;

    if (!content) {
        throw new Error(`OpenAI response was empty or malformed: ${content}`);
    }

    try {
        const parsed = JSON.parse(content) as { correctedText: string };
        return parsed.correctedText;
    } catch {
        return content;
    }
}

// Extract or revise attributes based on corrected text & current attrs
export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    const tokenCount = tokenCounter4o.encode(correctedText).length;
    const batchModel = tokenCount < 20 ? "gpt-4.1-nano" : "gpt-4o-mini";

    const completion = await openai.chat.completions.create({
        model: batchModel,
        messages: [
            { role: "system", content: EXTRACT_SYS_TXT },
            {
                role: "user", content: JSON.stringify({
                    template: template,
                    attributes: currAttributes,
                    text: correctedText
                })
            },
        ],
        max_tokens: 250,
        response_format: { type: "json_object" },
        temperature: 0.0,
    });
    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;

    if (!content) {
        throw new Error(`OpenAI response was empty or malformed: ${content} `);
    }

    try {
        const parsed = JSON.parse(content) as { parsedAttributes: Record<string, string> };
        const cleaned = Object.fromEntries(
            Object.entries(parsed.parsedAttributes).filter(([, v]) => v !== "" && v !== "N/A")
        );

        return cleaned;
    } catch {
        return currAttributes;
    }
}

export async function parseFinalAttributes(
    fullTranscript: string,
    template: FieldDef[],
    candidateAttributes: Record<string, string>
): Promise<Record<string, string>> {
    const neededTokens = Math.min(tokenCounter.encode(fullTranscript).length + 500, 8000);

    // Call the OpenAI chat completion API
    const completion = await openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
            { role: "system", content: FINAL_SYS_TXT },
            {
                role: "user", content: JSON.stringify({
                    template: template,
                    attributes: candidateAttributes,
                    text: fullTranscript
                })
            }
        ],
        temperature: 0.0,
        response_format: { type: "json_object" },
        max_tokens: neededTokens,
    });

    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;

    if (!content) {
        throw new Error(`OpenAI response was empty or malformed: ${content} `);
    }

    try {
        // Parse the JSON response
        const parsed = JSON.parse(content) as { finalAttributes: Record<string, string> };
        const merged = { ...candidateAttributes };

        for (const [attr, val] of Object.entries(parsed.finalAttributes)) {
            if (val && val !== "N/A") merged[attr] = val;
        }

        console.log("Final sweep completed. Verified attributes:", merged);
        return merged;
    } catch (err) {
        console.error("Error during final attribute extraction:", err);
        // return the candidate fields to their current_values
        return candidateAttributes;
    }
}