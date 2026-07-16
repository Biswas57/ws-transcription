import {
    GPT_FLOW_CONFIG,
    NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT,
    countTokens,
    notesFinalOutputBudget,
    truncateTranscriptPreservingEdges,
} from "./model-config.js";
import { parseJsonObjectText, readExactStringKey } from "./json-parsing.js";
import { runOpenAIResponsesJson } from "./provider.js";
import { formatSafeJsonKeys, recordUsageEvent, safeErrorInfo } from "../safe-log.js";

export const NOTES_FINAL_SYS_TXT = `\
You are a senior professional note editor working in an Australian context.

INPUTS:
1. note_style — the requested note style or context
2. sections — optional requested top-level section headings
3. current_notes — the canonical accumulated notes, including prior segments, live updates, and possible user edits
4. available_transcript — the available revised transcript, which may be incomplete or truncated

OBJECTIVE:
Produce one polished, accurate, coherent final note that preserves the useful substance of the session.

EDITORIAL PRIORITIES:
1. Source fidelity and factual accuracy
2. Preservation of useful canonical content and user edits
3. Requested section coverage
4. Clear organisation
5. Removal of duplication and live-note artefacts
6. Concise professional presentation

INTERNAL EDITING WORKFLOW — DO NOT OUTPUT:
1. Inventory the useful facts, concepts, decisions, actions, examples, questions, and context in both sources.
2. Identify corrections, contradictions, duplication, fragments, and temporary live-note structure.
3. Resolve source conflicts using the rules below.
4. Organise the material according to requested sections or an inferred structure.
5. Edit for clarity, concision, and professional readability.
6. Verify that important details were not lost and that no unsupported claims were introduced.

SOURCE ROLES:
- current_notes is the canonical accumulated draft and primary continuity source.
- available_transcript is evidence used to verify, correct, expand, and complete the draft.
- available_transcript may not contain the whole session.
- Do not remove useful current_notes content solely because it is absent from available_transcript.
- A clear transcript correction overrides an outdated note.
- A useful current_notes detail should remain when it is uncontradicted and may come from an earlier segment not visible in the transcript window.
- User edits are not separately labelled; treat all current_notes content as canonical unless clearly incorrect, duplicated, superseded, irrelevant, or an obvious live-generation artefact.
- Do not mention source truncation, current_notes, or available_transcript in the final notes.

PRESERVE:
- Important facts and explanations
- Decisions and conclusions
- Actions, owners, deadlines, and dependencies
- Requirements, constraints, blockers, risks, warnings, and obligations
- Questions that genuinely remain unresolved
- Definitions, process steps, caveats, and representative examples
- Dates, times, amounts, measurements, names, product names, IDs, commands, workflow names, case names, cluster identifiers, and technical terminology
- Meaningful side segments, announcements, and tangents when they remain useful

REMOVE OR REPAIR:
- Duplicate sections and repeated bullets
- Transcript stutters, filler, false starts, and conversational clutter
- Temporary headings such as "Live updates" or "Main points so far"
- Partial fragments that do not communicate useful meaning
- Broken headings produced by chunked live generation
- Unsupported claims and obvious hallucinations
- Outdated values that were clearly corrected later
- Excessive examples when one or two representative examples are sufficient

CONFLICT AND UNCERTAINTY RULES:
- Prefer a clearly stated correction or later confirmed fact.
- If sources differ and no resolution is supported, preserve the uncertainty rather than choosing arbitrarily.
- Correct transcription mistakes only when the intended wording is clear from context.
- Preserve uncertain terms as uncertain instead of guessing.
- Do not add outside knowledge.
- Do not invent explanations, diagnoses, motives, conclusions, or missing steps.

STRUCTURE:
- Use a # document title only when the main topic is clear and the title improves reviewability.
- Otherwise begin with ## sections.
- Remove temporary live sections by integrating their useful content elsewhere.
- Use a concise neutral section such as "Additional Notes" only when useful content does not fit naturally elsewhere.
- Merge overlapping sections.
- Keep related information together.
- Use numbered lists only for genuinely ordered procedures.

REQUESTED SECTIONS:
- If sections are supplied, include every requested section as a ## heading.
- Preserve the requested wording where practical.
- Use requested sections as the stable top-level structure.
- Add extra sections only when important content does not fit any requested section.
- For a requested section with no relevant content, use exactly:

## Requested Section

- No relevant notes captured.

- If sections are empty, infer the clearest structure from the material.

QUESTIONS:
- Include "Open Questions / Verify" only when genuine unresolved items remain.
- If a question is answered elsewhere, integrate the answer and remove it from open questions.
- Keep verification items concise and actionable.
- Keep rhetorical, conceptual, or philosophical questions with their relevant topic rather than treating them as verification tasks.

STYLE GUIDANCE:
- clinical: observations, relevant history, risks, actions, follow-up, and professional clinical context
- meeting: decisions, actions, owners, blockers, dependencies, dates, and unresolved items
- study: concepts, definitions, mechanisms, examples, caveats, and revision-oriented structure
- general: clear structured notes optimised for later review
- technical support or process training: exact product terms, workflow names, escalation paths, tools, commands, IDs, evidence locations, and operational caveats

Treat note_style as guidance, not permission to invent content or force an unsuitable template.

MARKDOWN:
- Use ## for major sections.
- Use ### for useful subtopics.
- Use - bullets for most content.
- Use numbered lists only for ordered steps.
- Use **bold** sparingly for key labels, deadlines, warnings, or facts.
- Do not add a Quick Checklist unless explicitly requested or the material is clearly procedural and action-oriented.
- Final notes may be shorter than live notes when duplication and clutter are removed without losing important meaning.

EMPTY INPUT:
If neither source contains substantive information, use:
## Notes

- No substantive notes captured.

OUTPUT:
Return only valid JSON in exactly this shape:

{"notesMarkdown":"<final polished markdown>"}

OUTPUT CONSTRAINTS:
- No markdown fences around the JSON.
- No commentary.
- No additional keys.`;

export const NOTES_FINAL_RESPONSE_SCHEMA = {
    name: "notes_final_response",
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            notesMarkdown: { type: "string" },
        },
        required: ["notesMarkdown"],
    },
} as const;

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
    const maxOutputTokens = notesFinalOutputBudget(inputTokens);
    const config = GPT_FLOW_CONFIG.notesFinal;
    recordUsageEvent("notes_final_start", {
        flow: "notes-final",
        provider: "responses",
        model: config.model,
        reasoningEffort: config.reasoning,
        transcriptChars: fullTranscript.length,
        truncatedChars: truncated.length,
        currentNotesChars: currentNotes.length,
        sectionsCount: sections.length,
        inputTokens,
        maxOutputTokens,
        truncated: wasTruncated,
    });
    console.log(
        `[notes-final] Context — ` +
        `model: ${config.model}, ` +
        `limit: ${NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT}, ` +
        `transcriptBefore: ${fullTranscript.length}, ` +
        `transcriptAfter: ${truncated.length}, ` +
        `notesChars: ${currentNotes.length}, ` +
        `truncated: ${wasTruncated}, ` +
        `inputTokens: ${inputTokens}, ` +
        `maxOutputTokens: ${maxOutputTokens}`
    );

    try {
        const response = await runOpenAIResponsesJson({
            label: "notes-final",
            model: config.model,
            reasoningEffort: config.reasoning,
            instructions: NOTES_FINAL_SYS_TXT,
            input: JSON.stringify({
                note_style: noteStyle,
                sections: sections.length > 0 ? sections : undefined,
                current_notes: currentNotes,
                available_transcript: truncated,
            }),
            maxOutputTokens,
            jsonSchema: NOTES_FINAL_RESPONSE_SCHEMA,
            metadata: {
                transcriptChars: fullTranscript.length,
                truncatedChars: truncated.length,
                currentNotesChars: currentNotes.length,
                sectionsCount: sections.length,
                truncated: wasTruncated,
            },
        });

        if (response.status === "incomplete") {
            recordUsageEvent("notes_final_failed", {
                flow: "notes-final",
                reason: "incomplete",
                transcriptChars: fullTranscript.length,
                currentNotesChars: currentNotes.length,
                outputChars: response.outputText.length,
                durationMs: response.durationMs,
                incompleteReason: response.incompleteReason ?? undefined,
            });
            console.warn(
                `[notes-final] Incomplete response, returning current notes — ` +
                `outputChars: ${response.outputText.length}, ` +
                `reason: ${response.incompleteReason ?? "unknown"}, ` +
                `duration: ${response.durationMs}ms`
            );
            return currentNotes;
        }

        const content = response.outputText;
        if (!content) {
            recordUsageEvent("notes_final_failed", {
                flow: "notes-final",
                reason: "empty-output",
                transcriptChars: fullTranscript.length,
                currentNotesChars: currentNotes.length,
                outputChars: 0,
            });
            console.warn("[notes-final] Empty response, returning current notes");
            return currentNotes;
        }

        const parsed = parseJsonObjectText(content);
        if (!parsed.ok) {
            recordUsageEvent("notes_final_failed", {
                flow: "notes-final",
                reason: "schema-failed",
                transcriptChars: fullTranscript.length,
                currentNotesChars: currentNotes.length,
                outputChars: content.length,
            });
            console.warn(
                `[notes-final] Unexpected response keys, returning current — ` +
                `jsonKeys: ${formatSafeJsonKeys([])}`
            );
            return currentNotes;
        }

        const parsedNotes = readExactStringKey(parsed.value, "notesMarkdown");
        if (!parsedNotes.ok && parsedNotes.stage === "unexpected-key") {
            recordUsageEvent("notes_final_failed", {
                flow: "notes-final",
                reason: "schema-failed",
                transcriptChars: fullTranscript.length,
                currentNotesChars: currentNotes.length,
                outputChars: content.length,
            });
            console.warn(
                `[notes-final] Unexpected response keys, returning current — ` +
                `jsonKeys: ${formatSafeJsonKeys(parsedNotes.keys)}`
            );
            return currentNotes;
        }

        if (!parsedNotes.ok) {
            recordUsageEvent("notes_final_failed", {
                flow: "notes-final",
                reason: "missing-key",
                transcriptChars: fullTranscript.length,
                currentNotesChars: currentNotes.length,
                outputChars: content.length,
            });
            console.warn("[notes-final] Missing notesMarkdown key, returning current");
            return currentNotes;
        }
        const finalized = parsedNotes.value;
        console.log(`[notes-final] ${config.model} pass complete: ${finalized.length} chars`);
        recordUsageEvent("notes_final_complete", {
            flow: "notes-final",
            provider: "responses",
            model: config.model,
            reasoningEffort: config.reasoning,
            transcriptChars: fullTranscript.length,
            truncatedChars: truncated.length,
            currentNotesChars: currentNotes.length,
            outputChars: finalized.length,
            durationMs: response.durationMs,
            inputTokens: response.usage.inputTokens,
            cachedInputTokens: response.usage.cachedInputTokens,
            outputTokens: response.usage.outputTokens,
            reasoningTokens: response.usage.reasoningTokens,
            totalTokens: response.usage.totalTokens,
        });
        return finalized;
    } catch (err) {
        recordUsageEvent("notes_final_failed", {
            flow: "notes-final",
            reason: "exception",
            transcriptChars: fullTranscript.length,
            currentNotesChars: currentNotes.length,
        });
        console.error(`[notes-final] Error — ${safeErrorInfo(err)}`);
        return currentNotes;
    }
}
