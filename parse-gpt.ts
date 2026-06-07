import { type FieldDef, FORMS_MIN_TRANSCRIPT_CHARS } from "./types.js";
import { get_encoding } from "@dqbd/tiktoken";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import { safeErrorInfo } from "./safe-log.js";
import { applyNotesLivePatch, type NotesLivePatch } from "./notes-live-patch.js";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GPT_MINI_MODEL = "gpt-5.4-mini";
const GPT_FINAL_MODEL = "gpt-5.4";
const GPT_REVISION_REASONING_EFFORT = "none" as const;
const GPT_LIVE_REASONING_EFFORT = "low" as const;
const GPT_FINAL_REASONING_EFFORT = "medium" as const;
const GPT_REQUEST_TIMEOUT_MS = Number(process.env.GPT_REQUEST_TIMEOUT_MS ?? 120_000);
const DEFAULT_REVISION_MIN_CHARS = 15;
const NOTES_REVISION_MIN_CHARS = 40;
const NOTES_REVISION_MIN_WORDS = 8;
const FORMS_REVISION_MIN_CHARS = 25;
// Forms extract discrete fields, so keep a conservative final transcript window.
const FORM_FINAL_TRANSCRIPT_CHAR_LIMIT = 6000;
// T-005 (Phase 1): Notes summarise whole sessions, so the final pass needs to see
// the entire revised transcript. The 60-minute session cap (MAX_NOTES_SESSION_MS)
// bounds a single backend recording session; this window remains intentionally
// generous while rolling checkpoint digests (T-005 Phase 2 / Option B) are deferred.
// Sessions that approach the cap still log `truncated: true`; if the cap is ever
// raised/removed, switch to rolling checkpoint digests.
const NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT = 80000;
// Final notes are roughly the size of the notes document, not the transcript, so
// cap the requested output regardless of how large the input transcript grows.
const NOTES_FINAL_MAX_OUTPUT_TOKENS = 16000;
// The bundled tiktoken version in this repo does not recognize GPT-5.5 aliases yet.
const tokenCounter = get_encoding("o200k_base");

export type GenerateNotesSummaryArgs = {
    notesMarkdown: string;
    noteStyle?: string;
};

export type GenerateNotesReorganisationArgs = {
    notesMarkdown: string;
    noteStyle?: string;
    targetSections?: string[];
};

export type NotesTransformErrorCode =
    | "transform-failed"
    | "transform-output-invalid-json"
    | "transform-output-missing-key"
    | "transform-output-empty"
    | "transform-output-error-like"
    | "transform-output-incomplete"
    | "transform-provider-error"
    | "reorganise-output-too-short";

export type NotesTransformErrorDetails = {
    stage?: string;
    outputChars?: number;
    jsonKeys?: string[];
    expectedKey?: string;
    usedAliasKey?: string;
    incompleteReason?: string;
};

export class NotesTransformError extends Error {
    constructor(
        readonly code: NotesTransformErrorCode,
        message: string,
        readonly details: NotesTransformErrorDetails = {}
    ) {
        super(message);
        this.name = "NotesTransformError";
    }
}

export function isNotesTransformError(err: unknown): err is NotesTransformError {
    return err instanceof NotesTransformError;
}

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
You are a live note-taking scribe in an Australian professional context
(clinical, meetings, social work, HR, technical support, process training, study, and general notes).

You are given:
1. note_style - the style/context of notes (clinical, meeting, study, general, or similar)
2. sections - optional preferred section headings to organise notes under (may be empty)
3. current_notes - the full canonical notes accumulated so far, including prior recording segments and possible user edits
4. transcript_segment - the latest revised transcript segment to incorporate

YOUR TASK:
Read current_notes for context and read transcript_segment for new information.
Return small append-only updates for information from transcript_segment that is missing from current_notes.

CRITICAL LIVE-UPDATE RULES:
- Return append instructions only.
- Do not return the full notes document.
- Do not include existing notes inside appendMarkdown.
- Do not rewrite existing notes.
- Do not delete, replace, reorder, dedupe, summarise, or reformat existing notes.
- Do not produce a transcript.
- Do not polish the whole document.
- Do not create large paragraphs when concise bullets will do.
- If there is no meaningful new information, return exactly {"updates":[]}.

WHAT TO CAPTURE:
- New facts, decisions, actions, owners, blockers, process steps, examples, caveats, dates/times, requirements, and important details.
- New questions, uncertainties, risks, or items needing verification.
- Corrections or clarifications to earlier notes, but append them as corrections/clarifications rather than editing old content.
- Technical acronyms, product names, case names, cluster identifiers, IDs, workflow names, and proper nouns exactly where possible.
- If a term is uncertain, keep it uncertain rather than inventing a correction.

DUPLICATE CONTROL:
- Only append details that are not already captured in current_notes.
- If transcript_segment repeats something already present, omit it.
- If transcript_segment expands an existing point with a genuinely new detail, append only the new detail.
- Duplicates may still happen occasionally; final notes will dedupe later.

TARGET HEADING RULES:
- Prefer an existing ## or ### heading from current_notes.
- targetHeading must be the existing heading text only, without leading ## or ###.
- targetLevel should be 2 for ## headings and 3 for ### headings.
- Prefer exact existing heading text.
- If sections were provided and matching headings already exist in current_notes, prefer those stable top-level sections.
- If no existing heading fits, use fallbackAppendMarkdown instead of inventing many new headings.
- If current_notes is empty or has no usable headings, use fallbackAppendMarkdown.

APPEND MARKDOWN RULES:
- appendMarkdown must be a small markdown fragment, not a full document.
- Use - bullets for most live notes.
- Use nested bullets with two leading spaces when useful.
- Use ### subheadings only when they make the appended content clearer.
- Do not use markdown tables in live updates.
- Avoid fenced code blocks unless transcript_segment clearly contains an exact command/log snippet that must be preserved.
- Use **bold** sparingly for key terms only when helpful.
- Keep appendMarkdown concise but not lossy.

STYLE GUIDANCE:
- clinical: concise professional clinical-style observations, risks, actions, and follow-up items.
- meeting: decisions, actions, owners, blockers, dates, and unresolved questions.
- study: concepts, definitions, process steps, examples, caveats, and checklists.
- general: clear structured notes with useful headings and bullets.
- technical support/process training: preserve product names, IDs, commands, tools, escalation paths, case workflow steps, and exact terminology where possible.

OUTPUT FORMAT:
Return ONLY valid JSON in this shape:
{
  "updates": [
    {
      "targetHeading": "existing heading text",
      "targetLevel": 2,
      "appendMarkdown": "- New detail"
    }
  ],
  "fallbackAppendMarkdown": ""
}

OUTPUT CONSTRAINTS:
- No markdown fences.
- No commentary.
- No extra keys.
- Do not return {"notesMarkdown": "..."}.
- Do not return the full notes document.
- If there are no updates, return exactly {"updates":[]}.`;

const NOTES_FINAL_SYS_TXT = `\
You are a professional note editor in an Australian context
(clinical, meetings, social work, HR, technical support, process training, study, and general notes).

You are given:
1. note_style - the style/context of notes
2. sections - optional requested section headings
3. current_notes - draft notes accumulated during the session, including live append updates, previous recording segments, and possible user edits
4. available_transcript - the available revised transcript for final review, which may be truncated for long sessions

YOUR TASK:
Produce a final polished version of the notes.

CURRENT_NOTES ROLE:
Treat current_notes as the primary draft and the main source of accumulated note content.
current_notes may contain:
- prior notes from earlier recording segments
- user edits or corrections
- append-only live updates
- temporary sections such as "Live updates"
- duplicated bullets caused by live recording
- rough or partially organised material

Preserve important content from current_notes unless available_transcript clearly corrects, expands, or makes it irrelevant.
Use available_transcript to verify, fill gaps, correct mistakes, and improve organisation.
Do not assume available_transcript contains the whole session if it is truncated.

FINAL EDITING REQUIREMENTS:
- Produce polished, useful, structured notes.
- Merge duplicate sections and repeated bullets.
- Integrate temporary "Live updates" content into the relevant final sections.
- Remove the "Live updates" section unless it genuinely remains the best place for otherwise uncategorised useful content.
- Repair broken or fragmented headings caused by live chunking.
- Normalise headings into clear professional labels.
- Preserve all important facts, decisions, actions, examples, caveats, risks, requirements, process steps, and open issues.
- Preserve user edits and manual clarifications unless available_transcript clearly corrects them.
- Remove transcript-like phrasing, filler, and conversational clutter.
- Correct obvious transcription errors only when context makes the correction clear.
- Preserve technical acronyms, product names, workflow names, case names, cluster identifiers, IDs, commands, and proper nouns exactly where possible.
- Do not invent information not present in current_notes or available_transcript.
- If a term is uncertain, include it under "Open questions / verify" rather than guessing.

QUESTIONS AND UNCERTAINTIES:
- Only include "Open questions / verify" when there are genuine unresolved questions, uncertainties, or items requiring external confirmation.
- If a question is answered elsewhere in current_notes or available_transcript, integrate the answer into the relevant section and do not keep it as an open question.
- If all questions are answered, omit the open questions section entirely.
- Keep verification items concise and actionable.

REQUESTED SECTIONS:
- If sections are provided, include every requested section as a ## heading.
- Use the requested section names as stable top-level headings where possible.
- Add "N/A" only for requested sections with no relevant content.
- If sections are empty, infer a clean structure appropriate to the content.
- Only include additional headings that are useful for the actual content.

STYLE GUIDANCE:
- clinical: professional clinical note style, observations, risks, actions, follow-up, and relevant context.
- meeting: decisions, actions, owners, blockers, dates, dependencies, and unresolved questions.
- study: concepts, definitions, process steps, examples, caveats, and review checklists.
- general: clear structured notes optimised for later review.
- technical support/process training: preserve exact workflow names, escalation paths, IDs, product terms, tools, commands, evidence locations, and operational caveats.

MARKDOWN REQUIREMENTS:
- Use ## for major sections.
- Use ### for subtopics.
- Use - bullets for most notes.
- Use numbered lists only for genuinely ordered procedures.
- Use **bold** sparingly for key facts, labels, deadlines, or warnings.
- Use a "Quick checklist" for procedural content when it would help the user act on the notes.
- Avoid markdown tables unless explicitly requested or clearly useful for compact comparison/reference.
- Keep the notes concise, structured, and useful for later review.
- Final notes may be shorter than live notes if summarisation, dedupe, and cleanup preserve the important meaning.

OUTPUT FORMAT:
Return ONLY valid JSON:
{"notesMarkdown": "<final polished notes as a markdown string>"}

No markdown fences, no commentary, no extra keys.`;

const NOTES_SUMMARISE_SYS_TXT = `\
You are a professional notes transformation editor in an Australian context
(clinical, meetings, social work, HR, technical support, process training, study, and general notes).

You are given:
1. note_style - the style/context of notes (clinical, meeting, study, general, or similar)
2. current_visible_notes - the current visible notes markdown supplied by the app

YOUR TASK:
Transform current visible notes only.
Make the notes shorter, cleaner, and easier to review while mostly preserving the existing structure.

SOURCE-OF-TRUTH RULES:
- Use only current_visible_notes.
- Do not use audio, raw transcript, hidden prior notes, backend session state, database state, or outside knowledge.
- Do not invent information.

SUMMARISE REQUIREMENTS:
- Preserve existing structure where possible.
- Do not reorganise into a new structure unless the existing structure is clearly weak or duplicated.
- Dedupe repeated notes.
- Compress overexplained concepts.
- Clean phrasing.
- Keep already clear and concise sections mostly unchanged.
- Merge only extremely weak, duplicated, or clearly overlapping headings.
- Preserve important facts, definitions, actions, caveats, risks, dates, commands, IDs, technical terms, product names, names, and relevant examples.
- Shorten long examples to key points, but do not remove relevant examples entirely.
- Remove irrelevant examples and obvious clutter.
- Keep useful unresolved questions under "Open Questions / Verify".
- If a question is answered elsewhere, integrate the answer into the relevant section and do not keep it as open.
- Omit "Open Questions / Verify" if nothing unresolved remains.
- Do not add a "Quick Checklist" unless explicitly requested in the notes.
- Do not blindly shorten notes; target roughly 60% of the original only where compression is actually useful.
- If the notes are already concise and cohesive, make minimal changes.

MARKDOWN REQUIREMENTS:
- Use # for document title when appropriate.
- Use ## for major sections.
- Use ### for subtopics.
- Use bullets for most notes.
- Use ordered lists only for genuine ordered lists or process steps.
- Avoid markdown tables in v1.
- Preserve technical acronyms, commands, IDs, dates, names, and product terms.

OUTPUT FORMAT:
Return only valid JSON:
{"summaryMarkdown":"<summarised notes markdown>"}

No markdown fences.
No commentary.
No extra keys.
Do not return notesMarkdown, markdown, summary, outputMarkdown, or any other key.`;

const NOTES_REORGANISE_SYS_TXT = `\
You are a professional notes transformation editor in an Australian context
(clinical, meetings, social work, HR, technical support, process training, study, and general notes).

You are given:
1. note_style - the style/context of notes (clinical, meeting, study, general, or similar)
2. target_sections - optional user-requested target sections
3. current_visible_notes - the current visible notes markdown supplied by the app

YOUR TASK:
Transform current visible notes only.
Reorganise content into clearer sections and topics while preserving roughly the same useful detail.

SOURCE-OF-TRUTH RULES:
- Use only current_visible_notes.
- Do not use audio, raw transcript, hidden prior notes, backend session state, database state, or outside knowledge.
- Do not invent content.

REORGANISE REQUIREMENTS:
- Preserve roughly 90-100% of useful detail.
- Reorganise content into clearer sections and topics.
- Use provided target sections when supplied.
- If no target sections are supplied, infer a clean structure.
- Requested sections are the priority over existing headings.
- Preserve requested section wording where possible.
- Each requested section should appear as a ## heading.
- Use ### for inferred subtopics.
- If a requested section has no relevant content, output this exact style:

## Requested Section

- No relevant notes captured.

- Extra sections are allowed only when important content does not fit requested sections.
- Preserve relevant examples and move them under the right concept.
- Slightly compress long useful examples only where needed.
- Merge duplicate sections.
- Lightly dedupe repeated bullets.
- Lightly clean obvious clutter.
- Correct obvious transcription errors and broken headings.
- Do not aggressively summarise.
- Do not output tables in v1.
- Do not add a "Quick Checklist" unless explicitly requested in the notes.
- Put "Open Questions / Verify" near the end if present.
- Put "Actions / Follow-up" near the end if present.
- If uncertain terms remain unresolved, keep them under "Open Questions / Verify".
- If uncertainties are answered elsewhere, integrate them into relevant sections.

MARKDOWN REQUIREMENTS:
- Use # for document title when appropriate.
- Use ## for major sections.
- Use ### for subtopics.
- Use bullets for most notes.
- Use ordered lists only for genuine ordered lists or process steps.
- Avoid markdown tables in v1.
- Preserve technical acronyms, commands, IDs, dates, names, and product terms.

OUTPUT FORMAT:
Return only valid JSON:
{"reorganisedMarkdown":"<reorganised notes markdown>"}

No markdown fences.
No commentary.
No extra keys.
Do not return notesMarkdown, markdown, summary, outputMarkdown, or any other key.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
    return tokenCounter.encode(text).length;
}

// Preserves the beginning and end for final passes, but may drop middle content.
// With the T-005 Phase 1 window this should only trigger for unusually dense
// capped sessions; rolling checkpoint digests would remove the drop.
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

function isMeaningfulFormText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length >= FORMS_MIN_TRANSCRIPT_CHARS && /[A-Za-z0-9$]/.test(trimmed);
}

type RevisionMode = "forms" | "notes";

type RevisionOptions = {
    mode?: RevisionMode;
};

function countWords(text: string): number {
    const trimmed = text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function shouldSkipRevision(rawText: string, mode?: RevisionMode): boolean {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) return true;

    if (mode === "notes") {
        return trimmed.length < NOTES_REVISION_MIN_CHARS ||
            countWords(trimmed) < NOTES_REVISION_MIN_WORDS;
    }

    if (mode === "forms") {
        return trimmed.length < FORMS_REVISION_MIN_CHARS ||
            looksLikeShortFieldValue(trimmed);
    }

    return trimmed.length < DEFAULT_REVISION_MIN_CHARS;
}

function looksLikeShortFieldValue(text: string): boolean {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const wordCount = countWords(trimmed);

    if (wordCount > 4 || trimmed.length > 80) return false;
    if (/^(yes|no|yeah|yep|nope|nah|n\/?a|not applicable|none)$/i.test(trimmed)) return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
    if (/^\+?[\d\s().-]{6,}$/.test(trimmed) && /\d/.test(trimmed)) return true;
    if (/^\$?\d[\d,]*(?:\.\d+)?(?:\s*(?:dollars?|aud|usd))?$/i.test(trimmed)) return true;
    if (/^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(trimmed)) return true;
    if (/^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(trimmed)) return true;
    if (/^\d{1,2}\s+[a-z]+(?:\s+\d{2,4})?$/i.test(trimmed)) return true;
    if (/^[\p{L}'-]+(?:\s+[\p{L}'-]+){0,2}$/u.test(trimmed)) return true;

    const compact = lower.replace(/[\s,.$()+-]/g, "");
    const digitCount = (compact.match(/\d/g) ?? []).length;
    return compact.length > 0 && digitCount / compact.length >= 0.6;
}

function parseNotesLivePatchContent(content: string): NotesLivePatch {
    try {
        const parsed = JSON.parse(content) as {
            updates?: unknown;
            fallbackAppendMarkdown?: unknown;
        };

        const updates = Array.isArray(parsed.updates)
            ? parsed.updates.flatMap((entry): NotesLivePatch["updates"] => {
                if (!entry || typeof entry !== "object") return [];
                const raw = entry as {
                    targetHeading?: unknown;
                    targetLevel?: unknown;
                    appendMarkdown?: unknown;
                };
                return [{
                    targetHeading: typeof raw.targetHeading === "string" ? raw.targetHeading : "",
                    targetLevel: raw.targetLevel === 2 || raw.targetLevel === 3 ? raw.targetLevel : undefined,
                    appendMarkdown: typeof raw.appendMarkdown === "string" ? raw.appendMarkdown : "",
                }];
            })
            : [];

        return {
            updates,
            fallbackAppendMarkdown: typeof parsed.fallbackAppendMarkdown === "string"
                ? parsed.fallbackAppendMarkdown
                : undefined,
        };
    } catch {
        console.warn("[notes-incremental-patch] JSON parse failed, returning empty patch");
        return { updates: [], parseFailed: true };
    }
}

function parseNotesTransformMarkdown(
    content: string,
    key: "summaryMarkdown" | "reorganisedMarkdown",
    aliasKeys: string[] = []
): string {
    const cleanedContent = extractJsonObjectText(content);
    const outputChars = content.length;
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleanedContent);
    } catch {
        throw new NotesTransformError(
            "transform-output-invalid-json",
            "Transform returned invalid JSON.",
            {
                stage: "invalid-json",
                outputChars,
            }
        );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new NotesTransformError(
            "transform-output-invalid-json",
            "Transform returned invalid JSON shape.",
            {
                stage: "invalid-json-shape",
                outputChars,
            }
        );
    }

    const parsedObject = parsed as Record<string, unknown>;
    const jsonKeys = Object.keys(parsedObject);
    let value = parsedObject[key];
    let usedAliasKey: string | undefined;

    if (typeof value !== "string") {
        for (const aliasKey of aliasKeys) {
            if (typeof parsedObject[aliasKey] === "string") {
                value = parsedObject[aliasKey];
                usedAliasKey = aliasKey;
                break;
            }
        }
    }

    if (typeof value !== "string") {
        throw new NotesTransformError(
            "transform-output-missing-key",
            `Transform response missing ${key}.`,
            {
                stage: "missing-key",
                outputChars,
                jsonKeys,
                expectedKey: key,
            }
        );
    }

    const markdown = value.trim();
    if (!markdown) {
        throw new NotesTransformError(
            "transform-output-empty",
            "Transform returned empty markdown.",
            {
                stage: "empty-output",
                outputChars,
                jsonKeys,
                expectedKey: key,
                usedAliasKey,
            }
        );
    }

    if (looksLikeTransformErrorOutput(markdown)) {
        throw new NotesTransformError(
            "transform-output-error-like",
            "Transform returned error-like markdown.",
            {
                stage: "error-like-output",
                outputChars,
                jsonKeys,
                expectedKey: key,
                usedAliasKey,
            }
        );
    }

    if (usedAliasKey) {
        console.warn(
            `[notes-transform] Accepted alias output key — ` +
            `expectedKey: ${key}, aliasKey: ${usedAliasKey}, ` +
            `jsonKeys: ${formatJsonKeys(jsonKeys)}, outputChars: ${outputChars}`
        );
    }

    return markdown;
}

function extractJsonObjectText(content: string): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function looksLikeTransformErrorOutput(markdown: string): boolean {
    const firstLine = markdown.trim().split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";
    return /^(error|sorry|unable to|i cannot|i can't|as an ai)\b/.test(firstLine);
}

function formatNotesTransformError(err: NotesTransformError): string {
    const parts = [
        `code=${err.code}`,
    ];

    if (err.details.stage) parts.push(`stage=${err.details.stage}`);
    if (typeof err.details.outputChars === "number") {
        parts.push(`outputChars=${err.details.outputChars}`);
    }
    if (err.details.expectedKey) parts.push(`expectedKey=${err.details.expectedKey}`);
    if (err.details.usedAliasKey) parts.push(`usedAliasKey=${err.details.usedAliasKey}`);
    if (err.details.incompleteReason) parts.push(`incompleteReason=${safeLogValue(err.details.incompleteReason)}`);
    if (err.details.jsonKeys) parts.push(`jsonKeys=${formatJsonKeys(err.details.jsonKeys)}`);

    return parts.join(" ");
}

function formatJsonKeys(keys: string[]): string {
    if (keys.length === 0) return "[]";
    return `[${keys.map((key) => key.replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join(",")}]`;
}

type ResponsesReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ResponsesJsonCallResult = {
    outputText: string;
    status: string;
    incompleteReason: string | null;
    durationMs: number;
};

async function runOpenAIResponsesJson(args: {
    label: string;
    model: string;
    reasoningEffort: ResponsesReasoningEffort;
    instructions: string;
    input: string;
    maxOutputTokens: number;
    metadata?: Record<string, string | number | boolean | undefined>;
}): Promise<ResponsesJsonCallResult> {
    const startedAt = Date.now();
    const response = await openai.responses.create({
        model: args.model,
        instructions: args.instructions,
        input: args.input,
        reasoning: { effort: args.reasoningEffort },
        max_output_tokens: args.maxOutputTokens,
        text: { format: { type: "json_object" } },
    }, { timeout: GPT_REQUEST_TIMEOUT_MS });

    const durationMs = Date.now() - startedAt;
    const outputText = response.output_text ?? "";
    const status = safeString(response.status) ?? "unknown";
    const incompleteReason = safeString(response.incomplete_details?.reason) ?? null;
    const usage = response.usage;
    const parts = [
        `api: responses`,
        `label: ${safeLogValue(args.label)}`,
        `model: ${safeLogValue(args.model)}`,
        `reasoningEffort: ${safeLogValue(args.reasoningEffort)}`,
        `status: ${status}`,
        `outputChars: ${outputText.length}`,
        `maxOutputTokens: ${args.maxOutputTokens}`,
        `duration: ${durationMs}ms`,
    ];

    if (incompleteReason) parts.push(`incompleteReason: ${incompleteReason}`);
    appendSafeNumber(parts, "inputTokens", usage?.input_tokens);
    appendSafeNumber(parts, "cachedInputTokens", usage?.input_tokens_details?.cached_tokens);
    appendSafeNumber(parts, "outputTokens", usage?.output_tokens);
    appendSafeNumber(parts, "reasoningTokens", usage?.output_tokens_details?.reasoning_tokens);
    appendSafeNumber(parts, "totalTokens", usage?.total_tokens);

    for (const [key, value] of Object.entries(args.metadata ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) {
            parts.push(`${safeLogValue(key)}: ${value}`);
        } else if (typeof value === "boolean") {
            parts.push(`${safeLogValue(key)}: ${value}`);
        } else if (typeof value === "string") {
            parts.push(`${safeLogValue(key)}: ${safeLogValue(value)}`);
        }
    }

    console.log(`[${args.label}] Provider — ${parts.join(", ")}`);

    return {
        outputText,
        status,
        incompleteReason,
        durationMs,
    };
}

function safeString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0
        ? value.replace(/[^A-Za-z0-9_-]/g, "")
        : null;
}

function safeLogValue(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "");
}

function appendSafeNumber(parts: string[], key: string, value: unknown): void {
    if (typeof value === "number" && Number.isFinite(value)) {
        parts.push(`${key}: ${value}`);
    }
}

function notesTransformOutputBudget(inputTokens: number, multiplier: number): number {
    return Math.min(
        NOTES_FINAL_MAX_OUTPUT_TOKENS,
        Math.max(1024, Math.ceil(inputTokens * multiplier) + 512)
    );
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
            console.warn(
                `[${context}] Dropping unknown key — ` +
                `rawKeyChars: ${rawKey.length}, normalizedKeyChars: ${key.length}`
            );
            continue;
        }
        if (val && val !== "N/A" && val.trim() !== "") {
            result[key] = val;
        }
    }
    return result;
}

// ─── Form fill exports (unchanged) ───────────────────────────────────────────

export async function reviseTranscription(rawText: string, options: RevisionOptions = {}): Promise<string> {
    if (shouldSkipRevision(rawText, options.mode)) return rawText;

    const reviseStart = Date.now();
    const inputTokens = countTokens(rawText);
    const maxOutputTokens = Math.min(
        512,
        Math.max(64, Math.ceil(inputTokens * 1.3) + 32)
    );

    try {
        const response = await runOpenAIResponsesJson({
            label: "revise",
            model: GPT_MINI_MODEL,
            reasoningEffort: GPT_REVISION_REASONING_EFFORT,
            instructions: REVISE_SYS_TXT,
            input: rawText,
            maxOutputTokens,
            metadata: {
                inputChars: rawText.length,
                inputTokens,
            },
        });

        if (response.status === "incomplete") {
            console.warn(
                `[revise] Incomplete response, using original — ` +
                `inputChars: ${rawText.length}, ` +
                `outputChars: ${response.outputText.length}, ` +
                `reason: ${response.incompleteReason ?? "unknown"}, ` +
                `duration: ${response.durationMs}ms`
            );
            return rawText;
        }

        const content = response.outputText;
        if (!content) {
            console.warn(`[revise] Empty response, using original — inputChars: ${rawText.length}, duration: ${Date.now() - reviseStart}ms`);
            return rawText;
        }

        const parsed = JSON.parse(content) as { correctedText?: string };
        const revised = parsed.correctedText?.trim();
        if (!revised) {
            console.warn(`[revise] Missing correctedText key, using original — inputChars: ${rawText.length}, duration: ${Date.now() - reviseStart}ms`);
            return rawText;
        }
        console.log(`[revise] ${rawText.length} → ${revised.length} chars`);
        return revised;
    } catch (err) {
        console.warn(
            `[revise] Failed open, using original — ` +
            `inputChars: ${rawText.length}, duration: ${Date.now() - reviseStart}ms, error: ${safeErrorInfo(err)}`
        );
        return rawText;
    }
}

export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (!isMeaningfulFormText(correctedText) || template.length === 0) return {};

    const allowed = allowedKeySet(template);
    const allowedSet = new Set(allowed);

    const normalizedCurrent: Record<string, string> = {};
    for (const [k, v] of Object.entries(currAttributes)) {
        normalizedCurrent[normalizeKey(k)] = v;
    }

    const maxOutputTokens = Math.max(512, template.length * 60);

    try {
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
            reasoning_effort: GPT_LIVE_REASONING_EFFORT,
        }, { timeout: GPT_REQUEST_TIMEOUT_MS });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) { console.warn("[extract] Empty response"); return {}; }

        const parsed = JSON.parse(content) as { parsedAttributes?: Record<string, string> };
        const raw = parsed.parsedAttributes ?? {};
        const cleaned = filterAndNormalizeOutput(raw, allowedSet, "extract");
        console.log(`[extract] Got ${Object.keys(cleaned).length}/${template.length} fields`);
        return cleaned;
    } catch (err) {
        console.warn(`[extract] Failed, returning sparse empty result — error: ${safeErrorInfo(err)}`);
        return {};
    }
}

export async function parseFinalAttributes(
    fullTranscript: string,
    template: FieldDef[],
    candidateAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (!isMeaningfulFormText(fullTranscript)) {
        console.log("[final] Transcript empty/noise, returning candidates as-is");
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
            model: GPT_FINAL_MODEL,
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
            reasoning_effort: GPT_FINAL_REASONING_EFFORT,
            max_completion_tokens: maxOutputTokens,
        }, { timeout: GPT_REQUEST_TIMEOUT_MS });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) { console.warn("[final] Empty response, returning candidates"); return candidateAttributes; }

        const parsed = JSON.parse(content) as { finalAttributes?: Record<string, string> };
        const raw = parsed.finalAttributes ?? {};
        const merged = { ...normalizedCandidates };
        let updatedCount = 0;

        for (const [rawKey, value] of Object.entries(raw)) {
            const key = normalizeKey(rawKey);
            if (!allowedSet.has(key)) {
                console.warn(`[final] Dropping unknown key — rawKeyChars: ${rawKey.length}, normalizedKeyChars: ${key.length}`);
                continue;
            }
            if (value && value !== "N/A" && value.trim() !== "") {
                if (merged[key] !== value) { merged[key] = value; updatedCount++; }
            }
        }

        console.log(`[final] ${GPT_FINAL_MODEL} pass complete. Updated ${updatedCount} fields.`);
        return merged;
    } catch (err) {
        console.error(`[final] Error — ${safeErrorInfo(err)}`);
        return candidateAttributes;
    }
}

// ─── Notes exports (new) ──────────────────────────────────────────────────────

/**
 * Generate append-only live note patch instructions.
 * The model still receives full current notes for section choice and duplicate
 * avoidance, but its output budget is bounded for small patch JSON.
 */
export async function generateNotesIncrementalPatch(
    transcriptSegment: string,
    currentNotes: string,
    noteStyle: string,
    sections: string[]
): Promise<NotesLivePatch> {
    if (transcriptSegment.trim().length < 20) return { updates: [] };

    const transcriptTokens = countTokens(transcriptSegment);
    const inputTokens = transcriptTokens + countTokens(currentNotes);
    const maxOutputTokens = Math.min(
        2048,
        Math.max(1024, Math.ceil(transcriptTokens * 1.2) + 512)
    );

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
        reasoning_effort: GPT_LIVE_REASONING_EFFORT,
    }, { timeout: GPT_REQUEST_TIMEOUT_MS });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
        console.warn("[notes-incremental-patch] Empty response, returning empty patch");
        return { updates: [] };
    }

    const patch = parseNotesLivePatchContent(content);
    console.log(
        `[notes-incremental-patch] Patch received — ` +
        `updates: ${patch.updates.length}, ` +
        `fallbackChars: ${patch.fallbackAppendMarkdown?.length ?? 0}, ` +
        `transcriptChars: ${transcriptSegment.length}, ` +
        `currentNotesChars: ${currentNotes.length}, ` +
        `inputTokens: ${inputTokens}, ` +
        `maxOutputTokens: ${maxOutputTokens}`
    );
    return patch;
}

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
    const patch = await generateNotesIncrementalPatch(
        transcriptSegment,
        currentNotes,
        noteStyle,
        sections
    );
    return applyNotesLivePatch(currentNotes, patch);
}

export async function generateNotesSummary(
    args: GenerateNotesSummaryArgs
): Promise<{ summaryMarkdown: string }> {
    const transformStart = Date.now();
    const notesMarkdown = args.notesMarkdown.trim();
    const inputTokens = countTokens(notesMarkdown);
    const maxOutputTokens = notesTransformOutputBudget(inputTokens, 0.8);

    try {
        const response = await runOpenAIResponsesJson({
            label: "notes-transform-summary",
            model: GPT_FINAL_MODEL,
            reasoningEffort: GPT_FINAL_REASONING_EFFORT,
            instructions: NOTES_SUMMARISE_SYS_TXT,
            input: JSON.stringify({
                note_style: args.noteStyle,
                current_visible_notes: notesMarkdown,
            }),
            maxOutputTokens,
            metadata: {
                inputChars: notesMarkdown.length,
                inputTokens,
            },
        });

        const content = response.outputText;
        if (response.status === "incomplete") {
            throw new NotesTransformError(
                "transform-output-incomplete",
                "Summary transform returned incomplete content.",
                {
                    stage: "incomplete-response",
                    outputChars: content.length,
                    expectedKey: "summaryMarkdown",
                    incompleteReason: response.incompleteReason ?? undefined,
                }
            );
        }

        if (!content) {
            throw new NotesTransformError(
                "transform-output-empty",
                "Summary transform returned empty content.",
                {
                    stage: "empty-response",
                    outputChars: 0,
                    expectedKey: "summaryMarkdown",
                }
            );
        }

        const summaryMarkdown = parseNotesTransformMarkdown(
            content,
            "summaryMarkdown",
            ["notesMarkdown", "markdown", "outputMarkdown"]
        );
        console.log(
            `[notes-transform-summary] Complete — ` +
            `inputChars: ${notesMarkdown.length}, ` +
            `outputChars: ${summaryMarkdown.length}, ` +
            `inputTokens: ${inputTokens}, ` +
            `maxOutputTokens: ${maxOutputTokens}, ` +
            `duration: ${Date.now() - transformStart}ms`
        );
        return { summaryMarkdown };
    } catch (err) {
        if (isNotesTransformError(err)) {
            console.warn(
                `[notes-transform-summary] Invalid output — ` +
                `inputChars: ${notesMarkdown.length}, ` +
                `duration: ${Date.now() - transformStart}ms, ` +
                `${formatNotesTransformError(err)}`
            );
            throw err;
        }

        console.error(
            `[notes-transform-summary] Error — ` +
            `inputChars: ${notesMarkdown.length}, ` +
            `duration: ${Date.now() - transformStart}ms, ` +
            `error: ${safeErrorInfo(err)}`
        );
        throw new NotesTransformError(
            "transform-provider-error",
            "Summary transform failed.",
            {
                stage: "provider-error",
            }
        );
    }
}

export async function generateNotesReorganisation(
    args: GenerateNotesReorganisationArgs
): Promise<{ reorganisedMarkdown: string }> {
    const transformStart = Date.now();
    const notesMarkdown = args.notesMarkdown.trim();
    const targetSections = args.targetSections ?? [];
    const inputTokens = countTokens(notesMarkdown);
    const maxOutputTokens = notesTransformOutputBudget(inputTokens, 1.1);

    try {
        const response = await runOpenAIResponsesJson({
            label: "notes-transform-reorganise",
            model: GPT_FINAL_MODEL,
            reasoningEffort: GPT_FINAL_REASONING_EFFORT,
            instructions: NOTES_REORGANISE_SYS_TXT,
            input: JSON.stringify({
                note_style: args.noteStyle,
                target_sections: targetSections.length > 0 ? targetSections : undefined,
                current_visible_notes: notesMarkdown,
            }),
            maxOutputTokens,
            metadata: {
                inputChars: notesMarkdown.length,
                inputTokens,
                targetSectionCount: targetSections.length,
            },
        });

        const content = response.outputText;
        if (response.status === "incomplete") {
            throw new NotesTransformError(
                "transform-output-incomplete",
                "Reorganise transform returned incomplete content.",
                {
                    stage: "incomplete-response",
                    outputChars: content.length,
                    expectedKey: "reorganisedMarkdown",
                    incompleteReason: response.incompleteReason ?? undefined,
                }
            );
        }

        if (!content) {
            throw new NotesTransformError(
                "transform-output-empty",
                "Reorganise transform returned empty content.",
                {
                    stage: "empty-response",
                    outputChars: 0,
                    expectedKey: "reorganisedMarkdown",
                }
            );
        }

        const reorganisedMarkdown = parseNotesTransformMarkdown(content, "reorganisedMarkdown");
        if (reorganisedMarkdown.length < notesMarkdown.length * 0.5) {
            throw new NotesTransformError(
                "reorganise-output-too-short",
                "Reorganise transform returned unexpectedly short markdown.",
                {
                    stage: "too-short-output",
                    outputChars: reorganisedMarkdown.length,
                    expectedKey: "reorganisedMarkdown",
                }
            );
        }

        console.log(
            `[notes-transform-reorganise] Complete — ` +
            `inputChars: ${notesMarkdown.length}, ` +
            `outputChars: ${reorganisedMarkdown.length}, ` +
            `targetSectionCount: ${targetSections.length}, ` +
            `inputTokens: ${inputTokens}, ` +
            `maxOutputTokens: ${maxOutputTokens}, ` +
            `duration: ${Date.now() - transformStart}ms`
        );
        return { reorganisedMarkdown };
    } catch (err) {
        if (isNotesTransformError(err)) {
            console.warn(
                `[notes-transform-reorganise] Invalid output — ` +
                `inputChars: ${notesMarkdown.length}, ` +
                `targetSectionCount: ${targetSections.length}, ` +
                `duration: ${Date.now() - transformStart}ms, ` +
                `${formatNotesTransformError(err)}`
            );
            throw err;
        }

        console.error(
            `[notes-transform-reorganise] Error — ` +
            `inputChars: ${notesMarkdown.length}, ` +
            `targetSectionCount: ${targetSections.length}, ` +
            `duration: ${Date.now() - transformStart}ms, ` +
            `error: ${safeErrorInfo(err)}`
        );
        throw new NotesTransformError(
            "transform-provider-error",
            "Reorganise transform failed.",
            {
                stage: "provider-error",
            }
        );
    }
}

/**
 * Final polished notes pass over the complete transcript.
 * Runs on stop, same cadence as parseFinalAttributes.
 * Uses the final-quality model/reasoning route.
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
        `model: ${GPT_FINAL_MODEL}, ` +
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
            model: GPT_FINAL_MODEL,
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
            reasoning_effort: GPT_FINAL_REASONING_EFFORT,
            max_completion_tokens: maxOutputTokens,
        }, { timeout: GPT_REQUEST_TIMEOUT_MS });

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
        console.log(`[notes-final] ${GPT_FINAL_MODEL} pass complete: ${finalized.length} chars`);
        return finalized;
    } catch (err) {
        console.error(`[notes-final] Error — ${safeErrorInfo(err)}`);
        return currentNotes;
    }
}
