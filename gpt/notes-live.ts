import { applyNotesLivePatch, type NotesLivePatch } from "../notes-live-patch.js";
import {
    GPT_LIVE_REASONING_EFFORT,
    GPT_MINI_MODEL,
    GPT_REQUEST_TIMEOUT_MS,
    countTokens,
} from "./model-config.js";
import { openai } from "./provider.js";

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
