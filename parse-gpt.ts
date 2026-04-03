import { FieldDef } from "./types.js";
import { get_encoding } from "@dqbd/tiktoken";
import { OpenAI } from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GPT_MINI_MODEL = "gpt-5.4-mini";
const GPT_FULL_MODEL = "gpt-5.4";
const GPT_REASONING_EFFORT = "low" as const;
// The bundled tiktoken version in this repo does not recognize GPT-5.4 aliases yet.
const tokenCounter = get_encoding("o200k_base");

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

const NOTES_INCREMENTAL_SYS_TXT = `\
You are a live note-taking scribe in an Australian professional context \
(clinical, meetings, social work, HR).

You are given:
1. note_style — the style/context of notes (clinical, meeting, study, general)
2. sections — optional section headings to organise notes under (may be empty)
3. current_notes — the notes accumulated so far (may be empty on first chunk)
4. transcript_segment — a new revised transcript segment to incorporate

YOUR TASK:
- Read the new transcript segment carefully.
- Update current_notes by appending new information and/or refining existing content.
- Do NOT remove or overwrite existing content unless correcting an obvious transcription error.
- If sections are provided, organise all content under those headings using ## markdown headings.
- Use clear, professional markdown: ## headings, - bullet points, **bold** for key facts.
- Be concise — notes capture decisions, facts, and key details; they are not a transcript.
- Write in third person or impersonal style appropriate to the note_style.
  clinical: "Patient reports...", "Denies...", "History of..."
  meeting: "Team agreed...", "Action: ...", "Decision: ..."
  study: "Key concept: ...", "Note: ..."
  general: flexible prose with bullet structure

Return ONLY valid JSON: {"notesMarkdown": "<full updated notes as a markdown string>"}
No markdown fences, no extra keys.`;

const NOTES_FINAL_SYS_TXT = `\
You are a professional note editor in an Australian context \
(clinical, meetings, social work, HR).

You are given:
1. note_style — the style/context of notes
2. sections — optional section headings
3. current_notes — notes accumulated during the session
4. full_transcript — the complete revised transcript

YOUR TASK:
- Produce a final, polished version of the notes.
- Fill any gaps missed during live note-taking by re-reading the full transcript.
- Correct errors or inconsistencies.
- If sections are provided, ensure every section heading is present.
  Add "N/A" under any section with no relevant content.
- Maintain professional tone and clear markdown structure.
- Do NOT invent information not present in the transcript.

Return ONLY valid JSON: {"notesMarkdown": "<final polished notes as a markdown string>"}
No markdown fences, no extra keys.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
    return tokenCounter.encode(text).length;
}

// Truncate transcript intelligently — keep start and end, drop middle if needed
function truncateTranscript(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const half = Math.floor(maxChars / 2);
    const start = text.slice(0, half);
    const end = text.slice(-half);
    return `${start}\n\n[... middle section omitted for length ...]\n\n${end}`;
}

function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

function allowedKeySet(template: FieldDef[]): string[] {
    return template.map((f) => normalizeKey(f.field_name));
}

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

// ─── Form fill exports (unchanged) ───────────────────────────────────────────

export async function reviseTranscription(rawText: string): Promise<string> {
    if (rawText.trim().length < 15) return rawText;

    const inputTokens = countTokens(rawText);
    const maxOutputTokens = Math.max(256, Math.ceil(inputTokens * 1.3));

    const completion = await openai.chat.completions.create({
        model: GPT_MINI_MODEL,
        messages: [
            { role: "system", content: REVISE_SYS_TXT },
            { role: "user", content: rawText },
        ],
        max_completion_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        reasoning_effort: GPT_REASONING_EFFORT,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) { console.warn("[revise] Empty response, using original"); return rawText; }

    try {
        const parsed = JSON.parse(content) as { correctedText?: string };
        const revised = parsed.correctedText?.trim();
        if (!revised) { console.warn("[revise] Missing correctedText key, using original"); return rawText; }
        console.log(`[revise] ${rawText.length} → ${revised.length} chars`);
        return revised;
    } catch {
        console.warn("[revise] JSON parse failed, using original");
        return rawText;
    }
}

export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (correctedText.trim().length < 20 || template.length === 0) return {};

    const allowed = allowedKeySet(template);
    const allowedSet = new Set(allowed);

    const normalizedCurrent: Record<string, string> = {};
    for (const [k, v] of Object.entries(currAttributes)) {
        normalizedCurrent[normalizeKey(k)] = v;
    }

    const maxOutputTokens = Math.max(512, template.length * 60);

    const completion = await openai.chat.completions.create({
        model: GPT_MINI_MODEL,
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
        max_completion_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        reasoning_effort: GPT_REASONING_EFFORT,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) { console.warn("[extract] Empty response"); return {}; }

    try {
        const parsed = JSON.parse(content) as { parsedAttributes?: Record<string, string> };
        const raw = parsed.parsedAttributes ?? {};
        const cleaned = filterAndNormalizeOutput(raw, allowedSet, "extract");
        console.log(`[extract] Got ${Object.keys(cleaned).length}/${template.length} fields`);
        return cleaned;
    } catch (err) {
        console.warn("[extract] JSON parse failed:", err);
        return {};
    }
}

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
    const truncated = truncateTranscript(fullTranscript, 6000);

    const normalizedCandidates: Record<string, string> = {};
    for (const [k, v] of Object.entries(candidateAttributes)) {
        normalizedCandidates[normalizeKey(k)] = v;
    }

    const maxOutputTokens = Math.max(1024, template.length * 80);

    try {
        const completion = await openai.chat.completions.create({
            model: GPT_FULL_MODEL,
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
            response_format: { type: "json_object" },
            reasoning_effort: GPT_REASONING_EFFORT,
            max_completion_tokens: maxOutputTokens,
        });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) { console.warn("[final] Empty response, returning candidates"); return candidateAttributes; }

        const parsed = JSON.parse(content) as { finalAttributes?: Record<string, string> };
        const raw = parsed.finalAttributes ?? {};
        const merged = { ...normalizedCandidates };
        let updatedCount = 0;

        for (const [rawKey, value] of Object.entries(raw)) {
            const key = normalizeKey(rawKey);
            if (!allowedSet.has(key)) {
                console.warn(`[final] Dropping unknown key "${rawKey}"`);
                continue;
            }
            if (value && value !== "N/A" && value.trim() !== "") {
                if (merged[key] !== value) { merged[key] = value; updatedCount++; }
            }
        }

        console.log(`[final] ${GPT_FULL_MODEL} pass complete. Updated ${updatedCount} fields.`);
        return merged;
    } catch (err) {
        console.error("[final] Error:", err);
        return candidateAttributes;
    }
}

// ─── Notes exports (new) ──────────────────────────────────────────────────────

/**
 * Incrementally update markdown notes with a new transcript segment.
 * Runs on the same cadence as extractAttributesFromText.
 * Uses gpt-5.4-mini for speed — this is a live/streaming operation.
 */
export async function generateNotesIncremental(
    transcriptSegment: string,
    currentNotes: string,
    noteStyle: string,
    sections: string[]
): Promise<string> {
    if (transcriptSegment.trim().length < 20) return currentNotes;

    const inputTokens = countTokens(transcriptSegment) + countTokens(currentNotes);
    // Notes output can be longer than input since we're accumulating
    const maxOutputTokens = Math.max(1024, Math.ceil(inputTokens * 1.5));

    const completion = await openai.chat.completions.create({
        model: GPT_MINI_MODEL,
        messages: [
            { role: "system", content: NOTES_INCREMENTAL_SYS_TXT },
            {
                role: "user",
                content: JSON.stringify({
                    note_style: noteStyle,
                    sections: sections.length > 0 ? sections : undefined,
                    current_notes: currentNotes || "",
                    transcript_segment: transcriptSegment,
                }),
            },
        ],
        max_completion_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        reasoning_effort: GPT_REASONING_EFFORT,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
        console.warn("[notes-incremental] Empty response, keeping current notes");
        return currentNotes;
    }

    try {
        const parsed = JSON.parse(content) as { notesMarkdown?: string };
        const updated = parsed.notesMarkdown?.trim();
        if (!updated) {
            console.warn("[notes-incremental] Missing notesMarkdown key, keeping current");
            return currentNotes;
        }
        console.log(`[notes-incremental] Notes updated: ${currentNotes.length} → ${updated.length} chars`);
        return updated;
    } catch {
        console.warn("[notes-incremental] JSON parse failed, keeping current notes");
        return currentNotes;
    }
}

/**
 * Final polished notes pass over the complete transcript.
 * Runs on stop, same cadence as parseFinalAttributes.
 * Uses gpt-5.4 for maximum quality.
 */
export async function finalizeNotes(
    fullTranscript: string,
    currentNotes: string,
    noteStyle: string,
    sections: string[]
): Promise<string> {
    if (fullTranscript.trim().length < 30) {
        console.log("[notes-final] Transcript too short, returning current notes");
        return currentNotes;
    }

    const truncated = truncateTranscript(fullTranscript, 6000);
    const inputTokens = countTokens(truncated) + countTokens(currentNotes);
    const maxOutputTokens = Math.max(1024, Math.ceil(inputTokens * 1.2));

    try {
        const completion = await openai.chat.completions.create({
            model: GPT_FULL_MODEL,
            messages: [
                { role: "system", content: NOTES_FINAL_SYS_TXT },
                {
                    role: "user",
                    content: JSON.stringify({
                        note_style: noteStyle,
                        sections: sections.length > 0 ? sections : undefined,
                        current_notes: currentNotes,
                        full_transcript: truncated,
                    }),
                },
            ],
            response_format: { type: "json_object" },
            reasoning_effort: GPT_REASONING_EFFORT,
            max_completion_tokens: maxOutputTokens,
        });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) {
            console.warn("[notes-final] Empty response, returning current notes");
            return currentNotes;
        }

        const parsed = JSON.parse(content) as { notesMarkdown?: string };
        const finalized = parsed.notesMarkdown?.trim();
        if (!finalized) {
            console.warn("[notes-final] Missing notesMarkdown key, returning current");
            return currentNotes;
        }
        console.log(`[notes-final] ${GPT_FULL_MODEL} pass complete: ${finalized.length} chars`);
        return finalized;
    } catch (err) {
        console.error("[notes-final] Error:", err);
        return currentNotes;
    }
}
