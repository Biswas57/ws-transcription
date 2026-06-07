import {
    GPT_FINAL_MODEL,
    GPT_FINAL_REASONING_EFFORT,
    NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT,
    countTokens,
    notesFinalOutputBudget,
    truncateTranscriptPreservingEdges,
} from "./model-config.js";
import { extractJsonObjectText } from "./json-parsing.js";
import { runOpenAIResponsesJson } from "./provider.js";
import { safeErrorInfo } from "../safe-log.js";

const NOTES_FINAL_SYS_TXT = `\
You are a professional note editor in an Australian context.

You are given:
1. note_style - the style/context of notes
2. sections - optional requested section headings
3. current_notes - the canonical draft notes accumulated during the session, including live append updates, previous recording segments, and possible manual edits
4. available_transcript - the available revised transcript for final review, which may be incomplete or truncated for long sessions

YOUR TASK:
Produce a final polished version of the notes.

GENERAL PRINCIPLES:
- Be context-adaptive. Infer the useful note structure from the actual content.
- Do not overfit to a specific content type such as a lecture, video, meeting, support call, or training session.
- Treat note_style as a useful hint, not an absolute rule.
- Do not invent information not present in current_notes or available_transcript.
- Preserve important content before optimising for neatness.

CURRENT_NOTES ROLE:
Treat current_notes as the canonical draft and the main source of accumulated note content.
current_notes may contain:
- prior notes from earlier recording segments
- manual edits or corrections
- append-only live updates
- temporary sections such as "Live updates", "Main points so far", or "Additional notes"
- duplicated bullets caused by live recording
- rough or partially organised material

available_transcript is used to verify, correct, expand, and improve current_notes.
Do not assume available_transcript contains the whole session if it is truncated or partial.
If current_notes contains useful content not visible in available_transcript, preserve it unless it is clearly contradicted, irrelevant, duplicated, or appears to be an artefact.
Manual edits are not separately marked as immutable; treat them as part of current_notes with the same weight as other canonical note content.

FINAL EDITING REQUIREMENTS:
- Produce polished, useful, structured notes.
- Use a # title only when the main topic is clear and a title would improve review. Otherwise start with ## sections.
- Remove temporary live-update sections by integrating their content into relevant final sections.
- Do not keep a "Live updates" section in the final notes.
- If useful content does not fit elsewhere, create a concise neutral section such as "Additional notes".
- Merge duplicate sections and repeated bullets.
- Repair broken or fragmented headings caused by live chunking.
- Normalise headings into clear professional labels.
- Preserve important facts, decisions, actions, examples, caveats, risks, requirements, process steps, definitions, and open issues.
- Preserve numbers, measurements, dates, names, product names, technical terms, workflow names, case names, cluster identifiers, IDs, commands, and proper nouns accurately.
- Preserve representative examples when they help explain a concept or support later recall. Usually one or two representative examples per major concept is enough unless the examples are core to understanding.
- Remove transcript-like phrasing, filler, and conversational clutter.
- Correct obvious transcription errors only when context makes the correction clear.
- If a term is uncertain, keep it uncertain rather than guessing.
- Capture meaningful side segments, tangents, announcements, or off-topic-but-useful content concisely and separately when they would otherwise clutter the main notes.

QUESTIONS AND UNCERTAINTIES:
- Only include "Open Questions / Verify" when there are genuine unresolved questions, uncertainties, or items requiring external confirmation.
- If a question or uncertainty is answered elsewhere in current_notes or available_transcript, integrate the answer into the relevant section and do not keep it as open.
- If all questions are answered, omit "Open Questions / Verify" entirely.
- Keep verification items concise and actionable.
- Preserve rhetorical or philosophical questions as part of the relevant content if they are part of the material, not as verification items.

REQUESTED SECTIONS:
- If sections are provided, include every requested section as a ## heading.
- Use the requested section names as stable top-level headings where possible.
- If a requested section has no relevant content, use:

## Requested Section

- No relevant notes captured.

- If sections are empty, infer a clean structure appropriate to the content.
- Only include additional headings that are useful for the actual content.

STYLE GUIDANCE:
- clinical: professional clinical note style, observations, risks, actions, follow-up, and relevant context.
- meeting: decisions, actions, owners, blockers, dates, dependencies, and unresolved questions.
- study: concepts, definitions, process steps, examples, caveats, and review-oriented structure.
- general: clear structured notes optimised for later review.
- technical support/process training: preserve exact workflow names, escalation paths, IDs, product terms, tools, commands, evidence locations, and operational caveats.

MARKDOWN REQUIREMENTS:
- Use ## for major sections.
- Use ### for subtopics.
- Use - bullets for most notes.
- Use numbered lists only for genuinely ordered procedures.
- Use **bold** sparingly for key facts, labels, deadlines, or warnings.
- Do not add a Quick Checklist unless the user explicitly requested one or the content is clearly procedural and action-oriented.
- Keep the notes concise, structured, and useful for later review.
- Final notes may be shorter than live notes if dedupe, cleanup, and organisation preserve the important meaning.

OUTPUT FORMAT:
Return ONLY valid JSON:
{"notesMarkdown": "<final polished notes as a markdown string>"}

No markdown fences, no commentary, no extra keys.`;

const NOTES_FINAL_RESPONSE_SCHEMA = {
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
        const response = await runOpenAIResponsesJson({
            label: "notes-final",
            model: GPT_FINAL_MODEL,
            reasoningEffort: GPT_FINAL_REASONING_EFFORT,
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
            console.warn("[notes-final] Empty response, returning current notes");
            return currentNotes;
        }

        const parsed = JSON.parse(extractJsonObjectText(content)) as { notesMarkdown?: string };
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
