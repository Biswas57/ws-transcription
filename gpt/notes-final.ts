import {
    GPT_FINAL_MODEL,
    GPT_FINAL_REASONING_EFFORT,
    NOTES_FINAL_MAX_OUTPUT_TOKENS,
    NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT,
    countTokens,
    truncateTranscriptPreservingEdges,
} from "./model-config.js";
import { extractJsonObjectText } from "./json-parsing.js";
import { runOpenAIResponsesJson } from "./provider.js";
import { safeErrorInfo } from "../safe-log.js";

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
