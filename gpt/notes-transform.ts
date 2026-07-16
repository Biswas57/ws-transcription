import {
    GPT_FLOW_CONFIG,
    NOTES_REORGANISE_OUTPUT_TOKEN_MULTIPLIER,
    NOTES_SUMMARY_OUTPUT_TOKEN_MULTIPLIER,
    countTokens,
    notesTransformOutputBudget,
} from "./model-config.js";
import { parseJsonObjectText, readExactStringKey } from "./json-parsing.js";
import { runOpenAIResponsesJson } from "./provider.js";
import {
    formatSafeJsonKeys,
    recordUsageEvent,
    safeErrorInfo,
    safeLogValue,
} from "../safe-log.js";

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
    | "transform-output-unexpected-key"
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

export const NOTES_SUMMARISE_SYS_TXT = `\
You are a professional notes summarisation editor working in an Australian context.

INPUTS:
1. note_style — the note style or context
2. current_visible_notes — the complete visible markdown to summarise

OBJECTIVE:
Produce a shorter review-oriented version of current_visible_notes while preserving its most important meaning.

This is a summarisation task, not a full rewrite and not a reorganisation-only task.

SOURCE OF TRUTH:
- Use only current_visible_notes.
- Do not use audio, transcripts, hidden notes, database state, session history, or outside knowledge.
- Do not invent information.
- Resolve uncertainty only when the answer is explicitly present elsewhere in current_visible_notes.

INTERNAL WORKFLOW — DO NOT OUTPUT:
1. Identify the document's purpose and major topics.
2. Mark information that must be retained.
3. Remove duplication, filler, repeated explanation, and low-value detail.
4. Merge overlapping points and sections.
5. Produce a visibly shorter but faithful review version.
6. Verify that critical facts and obligations remain accurate.

RETENTION PRIORITY:
Always preserve when present:
- Decisions and conclusions
- Actions, owners, deadlines, and follow-up
- Risks, blockers, warnings, obligations, and safety-critical information
- Requirements, constraints, exceptions, and dependencies
- Open questions and unresolved verification items
- Important facts, dates, numbers, names, amounts, and measurements
- Definitions, caveats, commands, IDs, product names, and technical terms

Preserve selectively:
- Core explanations and reasoning
- Representative examples that materially aid understanding
- Important side segments or announcements
- Context needed to interpret a decision, risk, or action

Compress or remove:
- Repetition
- Transcript-like wording
- Repeated framing
- Overexplained concepts
- Redundant headings
- Multiple examples proving the same point
- Low-value procedural detail
- Off-topic content that does not remain useful

COMPRESSION RULES:
- Medium and long notes should become visibly shorter.
- Already concise notes should receive only minimal changes.
- Do not target an exact percentage at the expense of accuracy.
- Reduce both wording and unnecessary structural depth.
- Merge small or overlapping sections when meaning remains clear.
- Do not preserve every source bullet.
- Keep the governing rule, exception, owner, action, constraint, risk, deadline, and unresolved issue while compressing repeated supporting detail.
- For long procedures, incident reviews, support notes, or training notes, retain the essential sequence and operational caveats without repeating every explanation.
- Shorten long examples to their key point unless the detail is central.

STRUCTURE:
- Preserve the existing organisation when it supports quick review.
- Simplify weak, duplicated, or overly granular structure.
- Do not create a completely different taxonomy unless necessary for clarity.
- Use # for a document title when appropriate.
- Use ## for major sections and ### only when useful.
- Use bullets for most notes.
- Use numbered lists only for genuine sequences.

QUESTIONS:
- Keep unresolved items under "Open Questions / Verify".
- If an answer exists elsewhere in the notes, integrate it and remove the question.
- Omit the section entirely when nothing remains unresolved.

STYLE:
- Treat note_style as a guide to emphasis and presentation.
- Do not let note_style introduce unsupported content.
- Preserve Australian spelling where applicable.
- Preserve exact acronyms, commands, IDs, names, dates, and product terminology.
- Do not add a Quick Checklist unless explicitly requested in the source notes.

OUTPUT:
Return only valid JSON in exactly this shape:

{"summaryMarkdown":"<summarised markdown>"}

OUTPUT CONSTRAINTS:
- No markdown fences around the JSON.
- No commentary.
- No additional keys.
- Do not return notesMarkdown, markdown, summary, or outputMarkdown.`;

export const NOTES_REORGANISE_SYS_TXT = `\
You are a professional notes-organisation editor working in an Australian context.

INPUTS:
1. note_style — the note style or context
2. target_sections — optional user-requested top-level sections
3. current_visible_notes — the complete visible markdown to reorganise

OBJECTIVE:
Reorganise current_visible_notes into a clearer structure while preserving nearly all useful detail.

This is a reorganisation task, not an aggressive summarisation task.

SOURCE OF TRUTH:
- Use only current_visible_notes.
- Do not use audio, transcripts, hidden notes, database state, session history, or outside knowledge.
- Do not invent content.
- Resolve uncertainty only when the answer is explicitly present elsewhere in current_visible_notes.

INTERNAL WORKFLOW — DO NOT OUTPUT:
1. Inventory all useful details and existing topics.
2. Identify duplicate headings, misplaced bullets, broken hierarchy, and unclear grouping.
3. Design the target structure using target_sections when provided.
4. Move each useful detail to its best location.
5. Lightly deduplicate and clean phrasing.
6. Verify that important content was not lost or materially compressed.

PRESERVATION RULES:
- Preserve nearly all useful facts, explanations, decisions, actions, examples, caveats, and context.
- Preserve names, dates, numbers, IDs, commands, technical terms, product names, obligations, risks, deadlines, and open questions.
- Preserve more detail than a summary would.
- Prefer moving and grouping content over rewriting it.
- Slightly shorten only clear repetition, clutter, or excessively long examples.
- Do not remove information merely because it is secondary.
- Keep meaningful tangents, announcements, and side segments under an appropriate concise section.
- Correct obvious transcription errors or broken headings only when the intended wording is clear.
- Keep unresolved uncertain terms uncertain.

TARGET SECTIONS:
- When target_sections are provided, use each one as a ## heading.
- Preserve requested wording where practical.
- Requested sections take priority over existing headings.
- Place content under the requested section that best matches its meaning.
- Do not force content into an unsuitable requested section.
- Add an extra section only when important content does not fit any requested section.
- For a requested section with no relevant content, use exactly:

## Requested Section

- No relevant notes captured.

- When target_sections are empty, infer the clearest structure from the content.

ORGANISATION RULES:
- Merge duplicate or overlapping sections.
- Group related concepts and examples together.
- Repair broken heading hierarchy.
- Use ### for useful subtopics.
- Place "Actions / Follow-up" near the end when present.
- Place "Open Questions / Verify" near the end when present.
- If a question is answered elsewhere, integrate the answer and remove it from open questions.
- Do not add a Quick Checklist unless explicitly requested in the source notes.

MARKDOWN:
- Use # for a document title when appropriate.
- Use ## for major sections.
- Use ### for meaningful subtopics.
- Use bullets for most notes.
- Use ordered lists only for genuine sequences or procedures.
- Preserve exact technical terminology and identifiers.

OUTPUT:
Return only valid JSON in exactly this shape:

{"reorganisedMarkdown":"<reorganised markdown>"}

OUTPUT CONSTRAINTS:
- No markdown fences around the JSON.
- No commentary.
- No additional keys.
- Do not return notesMarkdown, markdown, summary, or outputMarkdown.`;

export const NOTES_SUMMARY_RESPONSE_SCHEMA = {
    name: "notes_summary_response",
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            summaryMarkdown: { type: "string" },
        },
        required: ["summaryMarkdown"],
    },
} as const;

export const NOTES_REORGANISE_RESPONSE_SCHEMA = {
    name: "notes_reorganise_response",
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            reorganisedMarkdown: { type: "string" },
        },
        required: ["reorganisedMarkdown"],
    },
} as const;

export function parseNotesTransformMarkdown(
    content: string,
    key: "summaryMarkdown" | "reorganisedMarkdown"
): string {
    const outputChars = content.length;
    const parsed = parseJsonObjectText(content);

    if (!parsed.ok && parsed.stage === "invalid-json") {
        throw new NotesTransformError(
            "transform-output-invalid-json",
            "Transform returned invalid JSON.",
            {
                stage: "invalid-json",
                outputChars,
            }
        );
    }

    if (!parsed.ok) {
        throw new NotesTransformError(
            "transform-output-invalid-json",
            "Transform returned invalid JSON shape.",
            {
                stage: "invalid-json-shape",
                outputChars,
            }
        );
    }

    const keyResult = readExactStringKey(parsed.value, key);
    if (!keyResult.ok && keyResult.stage === "missing-key") {
        throw new NotesTransformError(
            "transform-output-missing-key",
            `Transform response missing ${key}.`,
            {
                stage: "missing-key",
                outputChars,
                jsonKeys: keyResult.keys,
                expectedKey: key,
            }
        );
    }

    if (!keyResult.ok && keyResult.stage === "unexpected-key") {
        throw new NotesTransformError(
            "transform-output-unexpected-key",
            "Transform response included unexpected keys.",
            {
                stage: "unexpected-key",
                outputChars,
                jsonKeys: keyResult.keys,
                expectedKey: key,
            }
        );
    }

    if (!keyResult.ok) {
        throw new NotesTransformError(
            "transform-output-empty",
            "Transform returned empty markdown.",
            {
                stage: "empty-output",
                outputChars,
                jsonKeys: keyResult.keys,
                expectedKey: key,
            }
        );
    }

    const markdown = keyResult.value;
    if (looksLikeTransformErrorOutput(markdown)) {
        throw new NotesTransformError(
            "transform-output-error-like",
            "Transform returned error-like markdown.",
            {
                stage: "error-like-output",
                outputChars,
                jsonKeys: keyResult.keys,
                expectedKey: key,
            }
        );
    }

    return markdown;
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
    if (err.details.incompleteReason) parts.push(`incompleteReason=${safeLogValue(err.details.incompleteReason)}`);
    if (err.details.jsonKeys) parts.push(`jsonKeys=${formatSafeJsonKeys(err.details.jsonKeys)}`);

    return parts.join(" ");
}

export async function generateNotesSummary(
    args: GenerateNotesSummaryArgs
): Promise<{ summaryMarkdown: string }> {
    const transformStart = Date.now();
    const notesMarkdown = args.notesMarkdown.trim();
    const inputTokens = countTokens(notesMarkdown);
    const maxOutputTokens = notesTransformOutputBudget(inputTokens, NOTES_SUMMARY_OUTPUT_TOKEN_MULTIPLIER);
    const config = GPT_FLOW_CONFIG.summarise;
    recordUsageEvent("notes_transform_start", {
        flow: "summarise",
        provider: "responses",
        model: config.model,
        reasoningEffort: config.reasoning,
        inputChars: notesMarkdown.length,
        inputTokens,
        maxOutputTokens,
    });

    try {
        const response = await runOpenAIResponsesJson({
            label: "notes-transform-summary",
            model: config.model,
            reasoningEffort: config.reasoning,
            instructions: NOTES_SUMMARISE_SYS_TXT,
            input: JSON.stringify({
                note_style: args.noteStyle,
                current_visible_notes: notesMarkdown,
            }),
            maxOutputTokens,
            jsonSchema: NOTES_SUMMARY_RESPONSE_SCHEMA,
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

        const summaryMarkdown = parseNotesTransformMarkdown(content, "summaryMarkdown");
        console.log(
            `[notes-transform-summary] Complete — ` +
            `inputChars: ${notesMarkdown.length}, ` +
            `outputChars: ${summaryMarkdown.length}, ` +
            `inputTokens: ${inputTokens}, ` +
            `maxOutputTokens: ${maxOutputTokens}, ` +
            `duration: ${Date.now() - transformStart}ms`
        );
        recordUsageEvent("notes_transform_complete", {
            flow: "summarise",
            provider: "responses",
            model: config.model,
            reasoningEffort: config.reasoning,
            inputChars: notesMarkdown.length,
            outputChars: summaryMarkdown.length,
            inputTokens,
            maxOutputTokens,
            durationMs: Date.now() - transformStart,
            responseInputTokens: response.usage.inputTokens,
            responseOutputTokens: response.usage.outputTokens,
            responseReasoningTokens: response.usage.reasoningTokens,
            responseTotalTokens: response.usage.totalTokens,
        });
        return { summaryMarkdown };
    } catch (err) {
        if (isNotesTransformError(err)) {
            recordUsageEvent("notes_transform_failed", {
                flow: "summarise",
                code: err.code,
                stage: err.details.stage,
                inputChars: notesMarkdown.length,
                outputChars: err.details.outputChars,
                durationMs: Date.now() - transformStart,
            });
            console.warn(
                `[notes-transform-summary] Invalid output — ` +
                `inputChars: ${notesMarkdown.length}, ` +
                `duration: ${Date.now() - transformStart}ms, ` +
                `${formatNotesTransformError(err)}`
            );
            throw err;
        }

        recordUsageEvent("notes_transform_failed", {
            flow: "summarise",
            code: "transform-provider-error",
            stage: "provider-error",
            inputChars: notesMarkdown.length,
            durationMs: Date.now() - transformStart,
        });
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
    const maxOutputTokens = notesTransformOutputBudget(inputTokens, NOTES_REORGANISE_OUTPUT_TOKEN_MULTIPLIER);
    const config = GPT_FLOW_CONFIG.reorganise;
    recordUsageEvent("notes_transform_start", {
        flow: "reorganise",
        provider: "responses",
        model: config.model,
        reasoningEffort: config.reasoning,
        inputChars: notesMarkdown.length,
        inputTokens,
        targetSectionCount: targetSections.length,
        maxOutputTokens,
    });

    try {
        const response = await runOpenAIResponsesJson({
            label: "notes-transform-reorganise",
            model: config.model,
            reasoningEffort: config.reasoning,
            instructions: NOTES_REORGANISE_SYS_TXT,
            input: JSON.stringify({
                note_style: args.noteStyle,
                target_sections: targetSections.length > 0 ? targetSections : undefined,
                current_visible_notes: notesMarkdown,
            }),
            maxOutputTokens,
            jsonSchema: NOTES_REORGANISE_RESPONSE_SCHEMA,
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
        recordUsageEvent("notes_transform_complete", {
            flow: "reorganise",
            provider: "responses",
            model: config.model,
            reasoningEffort: config.reasoning,
            inputChars: notesMarkdown.length,
            outputChars: reorganisedMarkdown.length,
            inputTokens,
            maxOutputTokens,
            targetSectionCount: targetSections.length,
            durationMs: Date.now() - transformStart,
            responseInputTokens: response.usage.inputTokens,
            responseOutputTokens: response.usage.outputTokens,
            responseReasoningTokens: response.usage.reasoningTokens,
            responseTotalTokens: response.usage.totalTokens,
        });
        return { reorganisedMarkdown };
    } catch (err) {
        if (isNotesTransformError(err)) {
            recordUsageEvent("notes_transform_failed", {
                flow: "reorganise",
                code: err.code,
                stage: err.details.stage,
                inputChars: notesMarkdown.length,
                outputChars: err.details.outputChars,
                targetSectionCount: targetSections.length,
                durationMs: Date.now() - transformStart,
            });
            console.warn(
                `[notes-transform-reorganise] Invalid output — ` +
                `inputChars: ${notesMarkdown.length}, ` +
                `targetSectionCount: ${targetSections.length}, ` +
                `duration: ${Date.now() - transformStart}ms, ` +
                `${formatNotesTransformError(err)}`
            );
            throw err;
        }

        recordUsageEvent("notes_transform_failed", {
            flow: "reorganise",
            code: "transform-provider-error",
            stage: "provider-error",
            inputChars: notesMarkdown.length,
            targetSectionCount: targetSections.length,
            durationMs: Date.now() - transformStart,
        });
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
