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
1. allowed_keys — the EXACT list of snake_case field keys you are allowed to return.
2. current_values — already-recorded values for each field (may be empty strings).
3. transcript_segment — a corrected segment of a meeting transcript.

KEY RULES:
- You MUST use ONLY keys from allowed_keys. Do not invent, rename, or reformat any key.
- Keys are SEMANTIC LABELS, not literal phrases. People do not say field names.
  Examples of how people express information:
  • "date_of_birth" → "I was born on the 3rd of March 1985" or "I'm 38 years old"
  • "chief_complaint" → "the reason I came in today is..." or "I've been having chest pain"
  • "medications" → "I'm currently on metformin and lisinopril"
  • "occupation" → "I work as a..." or "I'm a nurse at RPA"
  • "address" → "I live at 14 Smith Street, Penrith"

EXTRACTION RULES:
- Return a SPARSE object — only include fields where you found new or updated information.
- Do NOT return a field if the current_value is already correct and complete.
- Do NOT guess or infer beyond what is explicitly stated or strongly implied in the transcript.
- Do NOT populate a field from vague, ambiguous, or off-topic speech.
- If a returned value would be worse than the existing current_value, omit that field.

Return ONLY a pure JSON object: {"parsedAttributes": {"snake_case_key": "value", ...}}
Only keys from allowed_keys. No markdown, no code fences, no extra keys.`;


const FINAL_SYS_TXT = `\
You are a final verification agent for structured form extraction in an Australian professional context \
(finance, healthcare, social work, HR).

You are given:
1. allowed_keys — the EXACT list of snake_case field keys you must return. Every key must appear in output.
2. current_values — current extracted values from incremental passes.
3. full_transcript — the complete meeting transcript (may be truncated in the middle for length).

YOUR TASK: Do a careful final pass over the FULL transcript and produce the most accurate, \
complete value for every field in allowed_keys.

KEY RULES:
- You MUST return EVERY key in allowed_keys — no omissions.
- Use ONLY keys from allowed_keys. Do not invent, rename, or reformat any key.
- Keys are SEMANTIC LABELS. Extract from natural language, not literal key name matches.
  Important: the start of the transcript often contains critical details (name, DOB, address)
  that are not repeated — read it carefully.

EXTRACTION RULES:
- Do NOT guess. Only fill a field if the information is explicitly stated or strongly implied.
- Do NOT infer from vague or ambiguous speech.
- If a current_value is already correct and complete, return it unchanged.
- If the transcript contains a correction, more complete, or more specific value, use that.
- Prefer specific values: "metformin 500mg twice daily" over "medication".
- If absolutely no information exists in the transcript for a field, return exactly: "N/A"
- Do NOT return empty string — use "N/A" for unknown fields.

Return ONLY a pure JSON object: {"finalAttributes": {"snake_case_key": "value", ...}}
Every key in allowed_keys must appear. No markdown, no code fences, no extra keys.`;

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

/**
 * Canonical key format: lowercase snake_case.
 * "Date of Birth" → "date_of_birth", "chief-complaint" → "chief_complaint"
 * Applied to all GPT output keys before merging into state.
 */
function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

/**
 * Extract the flat list of allowed snake_case keys from a FieldDef template.
 * This is passed to GPT so it knows the exact allowed key set.
 */
function allowedKeySet(template: FieldDef[]): string[] {
    return template.map((f) => normalizeKey(f.field_name));
}

/**
 * Filter and normalize GPT output keys.
 * - Normalizes each returned key to snake_case
 * - Drops any key not in the allowed set (with a warning)
 * - Drops empty / "N/A" values
 */
function filterAndNormalizeOutput(
    raw: Record<string, string>,
    allowed: Set<string>,
    context: string
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [rawKey, val] of Object.entries(raw)) {
        const key = normalizeKey(rawKey);
        if (!allowed.has(key)) {
            console.warn(`[${context}] Dropping unknown key "${rawKey}" (normalized: "${key}")`);
            continue;
        }
        if (val && val !== "N/A" && val.trim() !== "") {
            result[key] = val;
        }
    }
    return result;
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
 * No keyword gate — field names are semantic labels, not literal phrases.
 * GPT is given the exact allowed key list to prevent key format drift.
 */
export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (correctedText.trim().length < 20 || template.length === 0) {
        return {};
    }

    const allowed = allowedKeySet(template);
    const allowedSet = new Set(allowed);

    // Normalize current attribute keys before sending so GPT sees canonical keys
    const normalizedCurrent: Record<string, string> = {};
    for (const [k, v] of Object.entries(currAttributes)) {
        normalizedCurrent[normalizeKey(k)] = v;
    }

    // Token budget: enough for a complete sparse JSON response
    const maxOutputTokens = Math.max(512, template.length * 60);

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: EXTRACT_SYS_TXT },
            {
                role: "user",
                content: JSON.stringify({
                    allowed_keys: allowed,
                    current_values: normalizedCurrent,
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
        const raw = parsed.parsedAttributes ?? {};
        const cleaned = filterAndNormalizeOutput(raw, allowedSet, "extract");
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
 * GPT is given the exact allowed key list to prevent key format drift.
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

    const allowed = allowedKeySet(template);
    const allowedSet = new Set(allowed);

    // Keep up to ~6000 chars using start+end strategy so nothing critical is lost.
    // Critically: the start is preserved for names/DOB/address stated early.
    const truncated = truncateTranscript(fullTranscript, 6000);

    // Normalize candidate attribute keys before sending
    const normalizedCandidates: Record<string, string> = {};
    for (const [k, v] of Object.entries(candidateAttributes)) {
        normalizedCandidates[normalizeKey(k)] = v;
    }

    // Token budget: every field must have a value in the dense response
    const maxOutputTokens = Math.max(1024, template.length * 80);

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: FINAL_SYS_TXT },
                {
                    role: "user",
                    content: JSON.stringify({
                        allowed_keys: allowed,
                        current_values: normalizedCandidates,
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
        const raw = parsed.finalAttributes ?? {};

        // Start from normalized candidates so no existing values are lost
        const merged = { ...normalizedCandidates };
        let updatedCount = 0;

        for (const [rawKey, value] of Object.entries(raw)) {
            const key = normalizeKey(rawKey);
            if (!allowedSet.has(key)) {
                console.warn(`[final] Dropping unknown key "${rawKey}" (normalized: "${key}")`);
                continue;
            }
            if (value && value !== "N/A" && value.trim() !== "") {
                if (merged[key] !== value) {
                    merged[key] = value;
                    updatedCount++;
                }
            }
            // "N/A" → leave the existing candidate value intact rather than blanking it
        }

        console.log(`[final] gpt-4o pass complete. Updated ${updatedCount} fields.`);
        return merged;
    } catch (err) {
        console.error("[final] Error:", err);
        return candidateAttributes;
    }
}