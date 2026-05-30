import { FieldDef } from "./types.js";
import { get_encoding } from "@dqbd/tiktoken";
import { OpenAI } from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GPT_MINI_MODEL = "gpt-5.4-mini";
const GPT_FULL_MODEL = "gpt-5.5";
const GPT_REASONING_EFFORT = "low" as const;
// Forms extract discrete fields, so keep a conservative final transcript window.
const FORM_FINAL_TRANSCRIPT_CHAR_LIMIT = 6000;
// T-005 (Phase 1): Notes summarise whole sessions, so the final pass needs to see
// the entire revised transcript. The 120-minute session cap (MAX_NOTES_SESSION_MS)
// bounds a single session's dense-speech transcript to roughly ~110k chars, so this
// window is sized to cover a full capped session without dropping the middle.
// Sessions that approach the cap still log `truncated: true`; if the cap is ever
// raised/removed, switch to rolling checkpoint digests (T-005 Phase 2 / Option B).
const NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT = 130000;
// Final notes are roughly the size of the notes document, not the transcript, so
// cap the requested output regardless of how large the input transcript grows.
const NOTES_FINAL_MAX_OUTPUT_TOKENS = 16000;
// The bundled tiktoken version in this repo does not recognize GPT-5.5 aliases yet.
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
- Only fill a field if the transcript clearly answers that exact field.
- If information appears to belong to a missing, locked, or excluded field, ignore it rather than forcing it into another available field.
- Do NOT use a semantically nearby allowed key as a fallback.
- A street address must not be placed into living_situation. living_situation means household arrangement, such as lives alone, with parents, with spouse, supported accommodation, homeless, etc.
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
- Only fill or update a field if the transcript clearly answers that exact field.
- If information appears to belong to a missing, locked, or excluded field, ignore it rather than forcing it into another available field.
- Do NOT use a semantically nearby allowed key as a fallback.
- A street address must not be placed into living_situation. living_situation means household arrangement, such as lives alone, with parents, with spouse, supported accommodation, homeless, etc.
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
1. note_style - the style/context of notes (clinical, meeting, study, general)
2. sections - optional section headings to organise notes under (may be empty)
3. current_notes - the notes accumulated so far (may be empty on first chunk)
4. transcript_segment - a new revised transcript segment to incorporate

YOUR TASK:
- Update current_notes with the new transcript_segment.
- current_notes may include prior notes and user edits from earlier recording segments; preserve them unless the new transcript clearly corrects or expands them.
- Capture new facts, decisions, actions, process steps, caveats, and important details.
- Do not produce a transcript.
- Do not duplicate information already captured.
- If new information expands an existing point, merge it into the relevant existing bullet or section.
- Do not remove existing content unless correcting an obvious transcription error, duplicate, or broken heading.
- If sections are provided, use them as stable top-level ## headings.
- If sections are empty, infer clear professional headings.
- Use ### subheadings for component-specific or topic-specific material where helpful.
- Never create broken or partial headings from transcript fragments.
- Normalise obvious fragmented headings.
  Example: use "Disk / SSD / HDD - Information to capture and perform", not separate headings like "Disk (HDD" and "SSD)".
- Preserve technical acronyms and names exactly where possible.
- If a term is uncertain, keep it as uncertain rather than inventing a correction.
- Use clear professional markdown: ## headings, ### subheadings, - bullets, **bold** for key facts.
- Be concise but not lossy.

Style guidance:
- clinical: professional clinical note style.
- meeting: decisions, actions, owners, blockers.
- study: concepts, definitions, process steps, examples.
- general: clear structured notes.

Return ONLY valid JSON: {"notesMarkdown": "<full updated notes as a markdown string>"}
No markdown fences, no extra keys.`;

const NOTES_FINAL_SYS_TXT = `\
You are a professional note editor in an Australian context \
(clinical, meetings, social work, HR).

You are given:
1. note_style - the style/context of notes
2. sections - optional section headings
3. current_notes - draft notes accumulated during the session
4. available_transcript - the available revised transcript for final review, which may be truncated for long sessions

YOUR TASK:
Produce a final polished version of the notes.

Treat current_notes as a draft, not as a fixed structure.
current_notes may include prior notes and user edits from earlier recording segments; preserve them unless available_transcript clearly corrects or expands them.
Use available_transcript to verify, fill gaps, correct mistakes, and improve organisation.

Editing requirements:
- Merge duplicate sections and repeated bullets.
- Repair broken or fragmented headings caused by live chunking.
- Normalise headings into clear professional labels.
- Preserve all important facts, decisions, actions, examples, caveats, and process steps.
- Remove transcript-like phrasing and filler.
- Correct obvious transcription errors only when context makes the correction clear.
- Do not invent information not present in current_notes or available_transcript.
- If a term is uncertain, include it under "Open questions / verify" rather than guessing.
- If sections are provided, include every requested section as a ## heading.
- Add "N/A" only for requested sections with no relevant content.
- If sections are empty, infer a clean structure appropriate to the content.

Only include headings that are useful for the actual content.
Only include "Open questions / verify" when there are genuine uncertainties.
Use a "Quick checklist" for procedural content when it would help the user act on the notes.

Markdown requirements:
- Use ## for major sections.
- Use ### for subtopics.
- Use - bullets for most notes.
- Use numbered lists only for ordered procedures.
- Use **bold** sparingly for key facts.
- Avoid markdown tables unless explicitly requested.
- Keep the notes concise, structured, and useful for later review.

Return ONLY valid JSON: {"notesMarkdown": "<final polished notes as a markdown string>"}
No markdown fences, no extra keys.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
    return tokenCounter.encode(text).length;
}

// Preserves the beginning and end for final passes, but may drop middle content.
// With the T-005 Phase 1 window this only triggers for sessions near the 120-min
// cap; rolling checkpoint digests (T-005 Phase 2 / Option B) would remove the drop.
function truncateTranscriptPreservingEdges(text: string, maxChars: number): string {
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
    const truncated = truncateTranscriptPreservingEdges(fullTranscript, FORM_FINAL_TRANSCRIPT_CHAR_LIMIT);

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

    const truncated = truncateTranscriptPreservingEdges(fullTranscript, NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT);
    const wasTruncated = fullTranscript.length > NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT;
    const inputTokens = countTokens(truncated) + countTokens(currentNotes);
    // Output ≈ notes size, so cap it; without a ceiling a large transcript would
    // request a wastefully large (and possibly out-of-range) completion budget.
    const maxOutputTokens = Math.min(
        Math.max(1024, Math.ceil(inputTokens * 1.2)),
        NOTES_FINAL_MAX_OUTPUT_TOKENS
    );
    console.log(
        `[notes-final] Context — ` +
        `model: ${GPT_FULL_MODEL}, ` +
        `limit: ${NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT}, ` +
        `transcriptBefore: ${fullTranscript.length}, ` +
        `transcriptAfter: ${truncated.length}, ` +
        `notesChars: ${currentNotes.length}, ` +
        `truncated: ${wasTruncated}, ` +
        `inputTokens: ${inputTokens}, ` +
        `maxOutputTokens: ${maxOutputTokens}`
    );

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
                        available_transcript: truncated,
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
