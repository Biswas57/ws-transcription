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
You are a professional notes transformation editor in an Australian context.

You are given:
1. note_style - the style/context of notes (clinical, meeting, study, general, or similar)
2. current_visible_notes - the current visible notes markdown supplied by the app

YOUR TASK:
Transform current visible notes only.
Produce a condensed summary, not a cleaned-up rewrite and not a reorganised version.
Make the notes shorter, cleaner, and easier to review while preserving the existing structure only where it helps reviewability.

SOURCE-OF-TRUTH RULES:
- Use only current_visible_notes.
- Do not use audio, raw transcript, hidden prior notes, backend session state, database state, or outside knowledge.
- Do not invent information.
- If current_visible_notes contain uncertainty, resolve it only when the answer is clearly present elsewhere in current_visible_notes.

SUMMARISE REQUIREMENTS:
- Preserve existing structure where it improves reviewability.
- Do not reorganise into a totally new structure unless the existing structure is clearly weak, duplicated, or overly granular.
- Do not behave like Reorganise; the output should be a condensed review summary, not the same detail in a new order.
- For medium or long notes, produce a visibly shorter review version unless the notes are already extremely compact.
- Long notes should usually be meaningfully shorter; do not force an exact percentage.
- If the source is long or repetitive, aim roughly for 50-75% of the original length where useful, but accuracy and reviewability are more important than hitting a fixed ratio.
- For medium or long notes, reduce both wording and structure: merge related sections, reduce low-value headings and subheadings where safe, and avoid preserving a one-to-one outline of the source.
- The result should be clearly different from a reorganised version of the same notes: shorter wording, fewer repeated bullets, and fewer low-level subheadings where the source is long.
- Dedupe repeated notes.
- Remove repeated examples, repeated explanation, repeated framing, transcript-like wording, and overly granular supporting detail.
- Merge small or overlapping bullets where meaning is preserved.
- Compress overexplained concepts.
- Do not preserve every bullet; preserve the important meaning.
- Prefer shorter wording.
- Compress supporting detail while preserving decisions, actions, owners, deadlines, risks, blockers, obligations, constraints, open questions, safety-critical facts, explicit user-provided constraints, key facts, dates, numbers, names, definitions, caveats, commands, IDs, technical terms, product names, and representative examples.
- Clean phrasing.
- Keep already clear and concise sections mostly unchanged.
- For long notes, merge clearly related or lower-priority headings when doing so preserves the key meaning and makes the result easier to review.
- For dense process, RCA, incident-review, support, or training notes, group repeated procedural details under fewer headings. Keep the governing rule, exception, owner/action, constraint, risk, deadline, and open question, but remove repeated step-by-step explanation and repeated examples.
- When there are many procedural bullets saying similar things, preserve the rule once and merge the rest into a shorter summary.
- Preserve representative examples that explain or anchor a concept, but shorten long examples to their key point.
- Remove irrelevant examples and obvious clutter.
- Compress tangents, side segments, announcements, or off-topic-but-useful content more than the main content unless they are central to the note purpose.
- Keep useful unresolved questions under "Open Questions / Verify".
- If a question is answered elsewhere in current_visible_notes, integrate the answer into the relevant section and do not keep it as open.
- Omit "Open Questions / Verify" if nothing unresolved remains.
- Do not add a Quick Checklist unless explicitly requested in the notes.
- Do not blindly shorten notes.
- Compression should be adaptive: longer notes can be compressed more, while already concise notes should stay mostly intact.
- If the notes are already concise and cohesive, make minimal changes.

MARKDOWN REQUIREMENTS:
- Use # for document title when appropriate.
- Use ## for major sections.
- Use ### for subtopics.
- Use bullets for most notes.
- Use ordered lists only for genuine ordered lists or process steps.
- Preserve technical acronyms, commands, IDs, dates, names, and product terms.

OUTPUT FORMAT:
Return only valid JSON:
{"summaryMarkdown":"<summarised notes markdown>"}

No markdown fences.
No commentary.
No extra keys.
Do not return notesMarkdown, markdown, summary, outputMarkdown, or any other key.`;

export const NOTES_REORGANISE_SYS_TXT = `\
You are a professional notes transformation editor in an Australian context.

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
- If current_visible_notes contain uncertainty, resolve it only when the answer is clearly present elsewhere in current_visible_notes.

REORGANISE REQUIREMENTS:
- Preserve roughly 90-100% of useful detail.
- Reorganise content into clearer sections and topics.
- Use provided target sections when supplied.
- If no target sections are supplied, infer a clean structure from the actual content.
- Requested sections are the priority over existing headings.
- Preserve requested section wording where possible.
- Each requested section should appear as a ## heading.
- Use ### for inferred subtopics.
- If a requested section has no relevant content, output this exact style:

## Requested Section

- No relevant notes captured.

- Extra sections are allowed only when important content does not fit requested sections.
- Preserve relevant examples and move them under the right concept.
- Preserve more useful detail and examples than Summarise would.
- Slightly compress long useful examples only where needed.
- Merge duplicate sections.
- Lightly dedupe repeated bullets.
- Lightly clean obvious clutter.
- Correct obvious transcription errors and broken headings only when context makes the correction clear.
- Do not aggressively summarise.
- Preserve meaningful tangents, side segments, announcements, or off-topic-but-useful content under a concise appropriate section when useful.
- Do not add a Quick Checklist unless explicitly requested in the notes.
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
- Preserve technical acronyms, commands, IDs, dates, names, and product terms.

OUTPUT FORMAT:
Return only valid JSON:
{"reorganisedMarkdown":"<reorganised notes markdown>"}

No markdown fences.
No commentary.
No extra keys.
Do not return notesMarkdown, markdown, summary, outputMarkdown, or any other key.`;

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
