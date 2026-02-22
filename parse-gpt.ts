import { FieldDef } from "./util.js";
import { encoding_for_model } from "@dqbd/tiktoken";
import { OpenAI } from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const tokenCounter = encoding_for_model("gpt-4o");

// ─── Prompts ──────────────────────────────────────────────────────────────────

const REVISE_SYS_TXT = `\
You are a transcription editor working in a professional Australian context. \
Meetings involve finance, healthcare, social work, and human resources. \
Whisper transcriptions often mishear: Australian names and suburbs, medical terms, \
medication names, legal terminology, financial jargon, and acronyms.

Your job:
- Fix spelling, grammar, and word substitution errors caused by speech-to-text mishearing.
- Preserve the original meaning, speaker intent, and all factual content exactly.
- Do NOT summarise, paraphrase, or remove any content.
- Do NOT add information not present in the original.

Return ONLY a pure JSON object: {"correctedText": "<corrected transcript>"}
No markdown, no code fences, no extra keys.`;


const EXTRACT_SYS_TXT = `\
You are a structured data extraction agent working in an Australian professional context \
(finance, healthcare, social work, HR).

You are given:
1. A list of form fields to extract, grouped by block.
2. The currently recorded values for each field (may be empty strings).
3. A segment of a corrected meeting transcript.

IMPORTANT: Field names are SEMANTIC LABELS, not literal phrases. \
People do not say field names — they express the information naturally. Examples:
- "date_of_birth" → someone says "I was born on the 3rd of March 1985" or "I'm 38"
- "chief_complaint" → someone says "the reason I came in today is..." or "I've been having..."
- "medications" → someone says "I'm currently on metformin and lisinopril"
- "occupation" → someone says "I work as a..." or "I'm a nurse"

For each field:
- Extract the value if the transcript contains relevant information, even if expressed indirectly.
- If the existing recorded value is already correct and complete, you may omit that field.
- If the transcript contains a correction or more complete value, return the updated value.
- Only omit a field if you are confident the transcript contains no relevant information for it.

Return ONLY a pure JSON object: {"parsedAttributes": {"field_name": "value", ...}}
Only include fields where you found or confirmed a value. No markdown, no code fences.`;


const FINAL_SYS_TXT = `\
You are a final verification agent for structured form extraction in an Australian professional context \
(finance, healthcare, social work, HR).

You are given:
1. The complete meeting transcript.
2. The current extracted values for each form field (result of incremental extraction).
3. The list of form fields grouped by block.

Your task: Do a careful final pass over the FULL transcript and produce the most accurate, \
complete value for every field.

Rules:
- Read the ENTIRE transcript — important details often appear early and are not repeated.
- Field names are SEMANTIC LABELS. Extract from natural language, not literal field name matches.
- If a value is already correct and complete, keep it.
- If a value is wrong, incomplete, or contradicted by later speech, correct it.
- If no information exists in the transcript for a field, return exactly: "N/A"
- Prefer specific, complete values over vague ones (e.g. "metformin 500mg daily" over "medication").

Return ONLY a pure JSON object: {"finalAttributes": {"field_name": "value", ...}}
Every field in the template must appear in the result. No markdown, no code fences.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
    return tokenCounter.encode(text).length;
}

// Truncate transcript intelligently — keep start and end, drop middle if needed
// This preserves names/DOB (usually early) and most recent info (usually late).
function truncateTranscript(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const half = Math.floor(maxChars / 2);
    const start = text.slice(0, half);
    const end = text.slice(-half);
    return `${start}\n\n[... middle section omitted for length ...]\n\n${end}`;
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Revise a raw Whisper transcription for accuracy.
 * Always runs — skipping based on surface heuristics causes missed corrections
 * on proper nouns, medical terms, and Australian place names.
 */
export async function reviseTranscription(rawText: string): Promise<string> {
    // Only skip truly trivial inputs
    if (rawText.trim().length < 15) {
        return rawText;
    }

    const inputTokens = countTokens(rawText);
    // Output can be slightly longer than input due to corrections adding clarity
    const maxOutputTokens = Math.max(256, Math.ceil(inputTokens * 1.3));

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: REVISE_SYS_TXT },
            { role: "user", content: rawText },
        ],
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        temperature: 0.0,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
        console.warn("[revise] Empty response, using original");
        return rawText;
    }

    try {
        const parsed = JSON.parse(content) as { correctedText?: string };
        const revised = parsed.correctedText?.trim();
        if (!revised) {
            console.warn("[revise] Missing correctedText key, using original");
            return rawText;
        }
        console.log(`[revise] ${rawText.length} → ${revised.length} chars`);
        return revised;
    } catch {
        console.warn("[revise] JSON parse failed, using original");
        return rawText;
    }
}

/**
 * Incrementally extract attributes from a transcript segment.
 * Removed keyword skip — field names are semantic, not literal phrases.
 */
export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (correctedText.trim().length < 20 || template.length === 0) {
        return {};
    }

    // Token budget: enough for a complete JSON response with all fields
    const maxOutputTokens = Math.max(512, template.length * 60);

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: EXTRACT_SYS_TXT },
            {
                role: "user",
                content: JSON.stringify({
                    template,
                    current_values: currAttributes,
                    transcript_segment: correctedText,
                }),
            },
        ],
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        temperature: 0.0,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
        console.warn("[extract] Empty response");
        return {};
    }

    try {
        const parsed = JSON.parse(content) as { parsedAttributes?: Record<string, string> };
        const result = parsed.parsedAttributes ?? {};
        const cleaned = Object.fromEntries(
            Object.entries(result).filter(([, v]) => v && v !== "N/A" && v.trim() !== "")
        );
        console.log(`[extract] Got ${Object.keys(cleaned).length}/${template.length} fields from ${correctedText.length} chars`);
        return cleaned;
    } catch (err) {
        console.warn("[extract] JSON parse failed:", err);
        return {};
    }
}

/**
 * Final verification pass over the complete transcript.
 * Uses gpt-4o for highest accuracy. Keeps start+end of long transcripts
 * so early details (name, DOB) aren't discarded.
 */
export async function parseFinalAttributes(
    fullTranscript: string,
    template: FieldDef[],
    candidateAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (fullTranscript.trim().length < 30) {
        console.log("[final] Transcript too short, returning candidates as-is");
        return candidateAttributes;
    }

    // Keep up to ~6000 chars using start+end strategy so nothing critical is lost
    const truncated = truncateTranscript(fullTranscript, 6000);

    // Token budget: all fields need a value in the response
    const maxOutputTokens = Math.max(1024, template.length * 80);

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: FINAL_SYS_TXT },
                {
                    role: "user",
                    content: JSON.stringify({
                        template,
                        current_values: candidateAttributes,
                        full_transcript: truncated,
                    }),
                },
            ],
            temperature: 0.0,
            response_format: { type: "json_object" },
            max_tokens: maxOutputTokens,
        });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) {
            console.warn("[final] Empty response, returning candidates");
            return candidateAttributes;
        }

        const parsed = JSON.parse(content) as { finalAttributes?: Record<string, string> };
        const finalAttrs = parsed.finalAttributes ?? {};

        const merged = { ...candidateAttributes };
        let updatedCount = 0;

        for (const [field, value] of Object.entries(finalAttrs)) {
            if (value && value !== "N/A" && value.trim() !== "") {
                if (merged[field] !== value) {
                    merged[field] = value;
                    updatedCount++;
                }
            }
            // If "N/A", leave the existing candidate value intact rather than blanking it
        }

        console.log(`[final] gpt-4o pass complete. Updated ${updatedCount} fields.`);
        return merged;
    } catch (err) {
        console.error("[final] Error:", err);
        return candidateAttributes;
    }
}