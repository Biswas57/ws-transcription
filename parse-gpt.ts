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
    // Skip revision for very short text - not worth the API cost
    if (rawText.trim().length < 20) {
        return rawText;
    }

    // Skip revision if text looks already clean (no obvious transcription errors)
    const hasTypicalTranscriptionErrors = /\b(um|uh|er|ah)\b|[.]{2,}|\s{2,}|[^\w\s.,!?-]/i.test(rawText);
    if (!hasTypicalTranscriptionErrors && rawText.length < 100) {
        console.log("Text appears clean, skipping revision to save costs");
        return rawText;
    }

    const tokenCount = tokenCounter4o.encode(rawText).length;
    const batchModel = tokenCount < 20 ? "gpt-4o-mini" : "gpt-4o-mini"; // Always use mini for revision

    const completion = await openai.chat.completions.create({
        model: batchModel,
        messages: [
            { role: "system", content: REVISE_SYS_TXT },
            { role: "user", content: rawText },
        ],
        max_tokens: Math.min(200, Math.ceil(rawText.length * 1.2)), // Dynamic token limit
        response_format: { type: "json_object" },
        temperature: 0.0,
    });

    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;

    if (!content) {
        console.warn("OpenAI revision returned empty content, using original");
        return rawText;
    }

    try {
        const parsed = JSON.parse(content) as { correctedText: string };
        return parsed.correctedText || rawText;
    } catch {
        console.warn("Failed to parse revision JSON, using original text");
        return rawText;
    }
}

// Extract or revise attributes based on corrected text & current attrs
export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    // Skip extraction if text is too short or template is empty
    if (correctedText.trim().length < 10 || template.length === 0) {
        return {};
    }

    // Quick keyword check - only extract if relevant keywords found
    const templateKeywords = template.map(t => t.field_name.toLowerCase());
    const textLower = correctedText.toLowerCase();
    const hasRelevantKeywords = templateKeywords.some(keyword =>
        textLower.includes(keyword) ||
        textLower.includes(keyword.replace(/[_-]/g, ' '))
    );

    if (!hasRelevantKeywords && Object.keys(currAttributes).length > 0) {
        console.log("No relevant keywords found, skipping extraction");
        return {};
    }

    const tokenCount = tokenCounter4o.encode(correctedText).length;
    const batchModel = "gpt-4o-mini"; // Always use mini for extraction

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
        max_tokens: Math.min(250, template.length * 30), // Dynamic token allocation
        response_format: { type: "json_object" },
        temperature: 0.0,
    });

    const choice = completion.choices?.[0];
    const message = choice?.message;
    const content = message?.content;

    if (!content) {
        console.warn("Empty response from attribute extraction");
        return {};
    }

    try {
        const parsed = JSON.parse(content) as { parsedAttributes: Record<string, string> };
        const cleaned = Object.fromEntries(
            Object.entries(parsed.parsedAttributes || {}).filter(([, v]) => v !== "" && v !== "N/A" && v?.trim())
        );

        console.log(`Extracted ${Object.keys(cleaned).length} attributes from ${correctedText.length} chars`);
        return cleaned;
    } catch (error) {
        console.warn("Failed to parse attribute extraction JSON:", error);
        return {};
    }
}

export async function parseFinalAttributes(
    fullTranscript: string,
    template: FieldDef[],
    candidateAttributes: Record<string, string>
): Promise<Record<string, string>> {
    // Skip final parsing if transcript is too short or no candidates
    if (fullTranscript.trim().length < 50) {
        console.log("Transcript too short for final parsing");
        return candidateAttributes;
    }

    // Only use expensive GPT-4 for final parsing if we have substantial content
    const shouldUseGPT4 = fullTranscript.length > 500 && Object.keys(candidateAttributes).length > 0;
    const model = shouldUseGPT4 ? "gpt-4o" : "gpt-4o-mini";

    // Optimize token usage by limiting context
    const maxTokens = Math.min(
        tokenCounter.encode(fullTranscript).length + 500,
        shouldUseGPT4 ? 4000 : 2000  // Lower limits for mini model
    );

    try {
        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: FINAL_SYS_TXT },
                {
                    role: "user", content: JSON.stringify({
                        template: template,
                        attributes: candidateAttributes,
                        text: fullTranscript.slice(-2000) // Use only last 2000 chars for context
                    })
                }
            ],
            temperature: 0.0,
            response_format: { type: "json_object" },
            max_tokens: maxTokens,
        });

        const choice = completion.choices?.[0];
        const message = choice?.message;
        const content = message?.content;

        if (!content) {
            console.warn("Empty response from final attributes parsing");
            return candidateAttributes;
        }

        const parsed = JSON.parse(content) as { finalAttributes: Record<string, string> };
        const merged = { ...candidateAttributes };

        let updatedCount = 0;
        for (const [attr, val] of Object.entries(parsed.finalAttributes || {})) {
            if (val && val !== "N/A" && val.trim() && val !== merged[attr]) {
                merged[attr] = val;
                updatedCount++;
            }
        }

        console.log(`Final parsing complete using ${model}. Updated ${updatedCount} attributes.`);
        return merged;

    } catch (err) {
        console.error("Error during final attribute extraction:", err);
        return candidateAttributes; // Graceful fallback
    }
}