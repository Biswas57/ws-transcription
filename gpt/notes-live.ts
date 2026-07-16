import { applyNotesLivePatch, type NotesLivePatch } from "../notes-live-patch.js";
import {
    GPT_FLOW_CONFIG,
    countTokens,
} from "./model-config.js";
import { buildNotesLiveCurrentContext } from "./notes-live-context.js";
import { runOpenAIResponsesJson } from "./provider.js";
import { recordUsageEvent, safeErrorInfo } from "../safe-log.js";

type NotesLiveFailureCategory =
    | "provider_error"
    | "incomplete_response"
    | "empty_output"
    | "parse_failed"
    | "schema_invalid";

export const NOTES_INCREMENTAL_SYS_TXT = `\
You are a conservative live note-taking scribe working in an Australian context.

INPUTS:
1. note_style — the requested note style or context
2. sections — optional preferred section headings
3. current_notes — the complete canonical notes accumulated so far
4. transcript_segment — the latest revised transcript segment

OBJECTIVE:
Return only small append-only note updates containing meaningful information from transcript_segment that is not already captured in current_notes.

The output is a delta, not a replacement document.

INTERNAL WORKFLOW — DO NOT OUTPUT:
1. Identify atomic new facts, ideas, decisions, actions, examples, questions, corrections, and context in transcript_segment.
2. Compare each candidate against current_notes.
3. Remove repeated or low-value candidates.
4. Route each remaining candidate to an appropriate existing heading.
5. Use fallbackAppendMarkdown only when a new heading or unmatched structure is genuinely needed.
6. Verify that no existing notes were copied or rewritten.

NON-NEGOTIABLE APPEND-ONLY RULES:
- Do not return the full notes document.
- Do not repeat existing notes.
- Do not rewrite, delete, replace, reorder, deduplicate, summarise, or reformat current_notes.
- Do not polish the whole document.
- Do not output a transcript.
- Do not create a # document title.
- If there is no meaningful new information, return exactly:
{"updates":[],"fallbackAppendMarkdown":""}

WHAT COUNTS AS A MEANINGFUL UPDATE:
- A new fact, concept, definition, explanation, decision, action, owner, blocker, requirement, risk, caveat, date, deadline, number, process step, or representative example
- A useful clarification or correction
- A genuinely unresolved question or verification item
- A meaningful side segment, announcement, or tangent that remains useful
- A new technical term, acronym, product name, command, ID, workflow name, case name, or proper noun

WHAT NOT TO APPEND:
- Information already captured with equivalent meaning
- Pure repetition or restatement
- Filler, greetings, transitions, false starts, or transcript noise
- Speculation not stated by the speaker
- Vague fragments without useful meaning
- A less complete version of an existing point
- Large copied passages from transcript_segment

CORRECTIONS:
- Do not edit the old note in place.
- Append a concise correction or clarification.
- Make the corrected fact explicit enough for finalisation to resolve later.
- Do not create a correction when the supposed change is ambiguous.

STRUCTURE DEVELOPMENT:
- Live notes should become useful during recording.
- Once enough signal exists, usually within the first 2-4 meaningful updates, create a small provisional structure.
- Prefer 2-5 content-specific sections rather than one generic running list.
- Prefer headings based on actual themes, concepts, phases, decisions, process areas, or discussion topics.
- Avoid leaving mature notes under generic headings such as "Live Updates".
- Provisional headings are acceptable; finalisation can refine them later.

EXISTING-HEADING UPDATES:
- Use updates when new material belongs under an existing ## or ### heading.
- targetHeading must contain only the existing heading text.
- Do not include leading ## or ### in targetHeading.
- targetLevel must be 2 for ## or 3 for ###.
- Match existing heading text exactly.
- appendMarkdown must contain only the new fragment, not the heading.
- Prefer requested section headings when they already exist and genuinely fit the content.
- Do not force information into an unsuitable requested section.

NEW-HEADING OR UNMATCHED UPDATES:
- Use fallbackAppendMarkdown when no existing heading fits or when the notes need their first useful structure.
- fallbackAppendMarkdown may contain concise ## headings and bullets.
- Use ### only when it materially improves clarity.
- It may be used alongside updates when one segment contains both existing-topic and new-topic information.
- Do not create a new heading for every small detail.

CONTENT STYLE:
- Use concise bullets rather than paragraphs.
- Use nested bullets with two leading spaces when useful.
- Preserve important details rather than over-compressing them.
- Use **bold** sparingly.
- Avoid fenced code blocks unless an exact command or log fragment must be preserved.
- If a technical term is uncertain, preserve the uncertainty instead of inventing a correction.

STYLE GUIDANCE:
- clinical: concise observations, relevant context, risks, actions, and follow-up
- meeting: decisions, actions, owners, blockers, dependencies, dates, and unresolved items
- study: concepts, definitions, mechanisms, examples, caveats, and review-oriented notes
- general: clear structured notes with useful headings
- technical support or process training: exact products, IDs, commands, tools, escalation paths, workflow steps, and terminology

OUTPUT WHEN UPDATES EXIST:
Return only valid JSON in exactly this shape:

{
  "updates": [
    {
      "targetHeading": "Existing heading text",
      "targetLevel": 2,
      "appendMarkdown": "- New detail"
    }
  ],
  "fallbackAppendMarkdown": ""
}

OUTPUT CONSTRAINTS:
- No markdown fences around the JSON.
- No commentary.
- No additional keys.
- Do not return notesMarkdown.
- Do not return the full document.
- When fallbackAppendMarkdown is unused, return it as an empty string.
- When there are no updates, return exactly {"updates":[],"fallbackAppendMarkdown":""}.`;

export const NOTES_LIVE_PATCH_RESPONSE_SCHEMA = {
    name: "notes_live_patch_response",
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            updates: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        targetHeading: { type: "string" },
                        targetLevel: { type: "number", enum: [2, 3] },
                        appendMarkdown: { type: "string" },
                    },
                    required: ["targetHeading", "targetLevel", "appendMarkdown"],
                },
            },
            fallbackAppendMarkdown: { type: "string" },
        },
        required: ["updates", "fallbackAppendMarkdown"],
    },
} as const;

export function parseNotesLivePatchContent(content: string): NotesLivePatch {
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
        return emptyNotesLivePatch(true);
    }
}

type NotesLivePatchRequest = {
    input: string;
    inputTokens: number;
    maxOutputTokens: number;
    transcriptChars: number;
    currentNotesChars: number;
    currentNotesContextChars: number;
    contextCompacted: boolean;
    contextSavedChars: number;
    headingCount: number;
};

type NotesLivePatchFailure = {
    category: NotesLiveFailureCategory;
    outputChars?: number;
    durationMs?: number;
    incompleteReason?: string | null;
};

function emptyNotesLivePatch(parseFailed = false): NotesLivePatch {
    return parseFailed ? { updates: [], parseFailed: true } : { updates: [] };
}

export function buildNotesLivePatchRequest(
    transcriptSegment: string,
    currentNotes: string,
    noteStyle: string,
    sections: string[]
): NotesLivePatchRequest {
    const transcriptTokens = countTokens(transcriptSegment);
    const currentContext = buildNotesLiveCurrentContext(currentNotes);
    return {
        input: JSON.stringify({
            note_style: noteStyle,
            sections: sections.length > 0 ? sections : undefined,
            current_notes: currentContext.contextMarkdown,
            transcript_segment: transcriptSegment,
        }),
        inputTokens: transcriptTokens + countTokens(currentContext.contextMarkdown),
        maxOutputTokens: Math.min(
            2048,
            Math.max(1024, Math.ceil(transcriptTokens * 1.2) + 512)
        ),
        transcriptChars: transcriptSegment.length,
        currentNotesChars: currentContext.originalChars,
        currentNotesContextChars: currentContext.contextChars,
        contextCompacted: currentContext.compacted,
        contextSavedChars: currentContext.savedChars,
        headingCount: currentContext.headingCount,
    };
}

function logNotesLivePatchReceived(
    patch: NotesLivePatch,
    request: NotesLivePatchRequest,
    provider: "responses",
    extra: { outputChars?: number; durationMs?: number; totalTokens?: number; reasoningTokens?: number } = {}
): void {
    console.log(
        `[notes-incremental-patch] Patch received — ` +
        `provider: ${provider}, ` +
        `updates: ${patch.updates.length}, ` +
        `fallbackChars: ${patch.fallbackAppendMarkdown?.length ?? 0}, ` +
        `transcriptChars: ${request.transcriptChars}, ` +
        `currentNotesChars: ${request.currentNotesChars}, ` +
        `currentNotesContextChars: ${request.currentNotesContextChars}, ` +
        `inputTokens: ${request.inputTokens}, ` +
        `maxOutputTokens: ${request.maxOutputTokens}`
    );
    recordUsageEvent("notes_live_patch_complete", {
        flow: "notes-live-patch",
        provider,
        updates: patch.updates.length,
        fallbackChars: patch.fallbackAppendMarkdown?.length ?? 0,
        transcriptChars: request.transcriptChars,
        currentNotesChars: request.currentNotesChars,
        currentNotesContextChars: request.currentNotesContextChars,
        contextCompacted: request.contextCompacted,
        contextSavedChars: request.contextSavedChars,
        headingCount: request.headingCount,
        estimatedInputTokens: request.inputTokens,
        maxOutputTokens: request.maxOutputTokens,
        outputChars: extra.outputChars,
        durationMs: extra.durationMs,
        totalTokens: extra.totalTokens,
        reasoningTokens: extra.reasoningTokens,
        parseFailed: patch.parseFailed === true,
    });
}

function logNotesLiveProviderSelected(
    provider: "responses",
    request: NotesLivePatchRequest
): void {
    console.log(
        `[notes-incremental-patch] Provider selected — ` +
        `provider: ${provider}, ` +
        `transcriptChars: ${request.transcriptChars}, ` +
        `currentNotesChars: ${request.currentNotesChars}, ` +
        `currentNotesContextChars: ${request.currentNotesContextChars}, ` +
        `inputTokens: ${request.inputTokens}, ` +
        `maxOutputTokens: ${request.maxOutputTokens}`
    );
    recordUsageEvent("notes_live_patch_start", {
        flow: "notes-live-patch",
        provider,
        transcriptChars: request.transcriptChars,
        currentNotesChars: request.currentNotesChars,
        currentNotesContextChars: request.currentNotesContextChars,
        contextCompacted: request.contextCompacted,
        contextSavedChars: request.contextSavedChars,
        headingCount: request.headingCount,
        estimatedInputTokens: request.inputTokens,
        maxOutputTokens: request.maxOutputTokens,
    });
    if (request.contextCompacted) {
        recordUsageEvent("notes-live-context-compacted", {
            flow: "notes-live-patch",
            provider,
            originalChars: request.currentNotesChars,
            contextChars: request.currentNotesContextChars,
            savedChars: request.contextSavedChars,
            headingCount: request.headingCount,
            compacted: true,
        });
    }
}

function logNotesLivePatchFailed(
    failure: NotesLivePatchFailure,
    request: NotesLivePatchRequest,
    errorInfo?: string
): void {
    const parts = [
        `[notes-incremental-patch] Patch failed, preserving current notes`,
        `category: ${failure.category}`,
        `transcriptChars: ${request.transcriptChars}`,
        `currentNotesChars: ${request.currentNotesChars}`,
    ];

    if (typeof failure.outputChars === "number") parts.push(`outputChars: ${failure.outputChars}`);
    if (typeof failure.durationMs === "number") parts.push(`duration: ${failure.durationMs}ms`);
    if (failure.incompleteReason) parts.push(`incompleteReason: ${failure.incompleteReason}`);
    if (errorInfo) parts.push(`error: ${errorInfo}`);

    console.warn(parts.join(" — "));
    recordUsageEvent("notes_live_patch_failed", {
        flow: "notes-live-patch",
        provider: "responses",
        category: failure.category,
        transcriptChars: request.transcriptChars,
        currentNotesChars: request.currentNotesChars,
        currentNotesContextChars: request.currentNotesContextChars,
        contextCompacted: request.contextCompacted,
        contextSavedChars: request.contextSavedChars,
        headingCount: request.headingCount,
        outputChars: failure.outputChars,
        durationMs: failure.durationMs,
        incompleteReason: failure.incompleteReason ?? undefined,
    });
}

/**
 * Generate append-only live note patch instructions.
 * The model receives bounded current-notes context for section choice and
 * duplicate avoidance; the backend still applies patches to full canonical notes.
 */
export async function generateNotesIncrementalPatch(
    transcriptSegment: string,
    currentNotes: string,
    noteStyle: string,
    sections: string[]
): Promise<NotesLivePatch> {
    if (transcriptSegment.trim().length < 20) return emptyNotesLivePatch();

    const request = buildNotesLivePatchRequest(
        transcriptSegment,
        currentNotes,
        noteStyle,
        sections
    );
    const provider = GPT_FLOW_CONFIG.notesLive.api;
    logNotesLiveProviderSelected(provider, request);

    try {
        const result = await generateNotesIncrementalPatchResponses(request);
        if (!result.patch.parseFailed) return result.patch;
        logNotesLivePatchFailed(result.failure ?? { category: "parse_failed" }, request);
    } catch (err) {
        logNotesLivePatchFailed({ category: "provider_error" }, request, safeErrorInfo(err));
    }

    return emptyNotesLivePatch();
}

async function generateNotesIncrementalPatchResponses(
    request: NotesLivePatchRequest
): Promise<{ patch: NotesLivePatch; failure?: NotesLivePatchFailure }> {
    const config = GPT_FLOW_CONFIG.notesLive;
    const response = await runOpenAIResponsesJson({
        label: "notes-incremental-patch",
        model: config.model,
        reasoningEffort: config.reasoning,
        instructions: NOTES_INCREMENTAL_SYS_TXT,
        input: request.input,
        maxOutputTokens: request.maxOutputTokens,
        jsonSchema: NOTES_LIVE_PATCH_RESPONSE_SCHEMA,
        metadata: {
            providerMode: "responses",
            transcriptChars: request.transcriptChars,
            currentNotesChars: request.currentNotesChars,
            currentNotesContextChars: request.currentNotesContextChars,
            contextCompacted: request.contextCompacted,
            contextSavedChars: request.contextSavedChars,
            headingCount: request.headingCount,
            estimatedInputTokens: request.inputTokens,
        },
    });

    if (response.status === "incomplete") {
        return {
            patch: emptyNotesLivePatch(true),
            failure: {
                category: "incomplete_response",
                outputChars: response.outputText.length,
                durationMs: response.durationMs,
                incompleteReason: response.incompleteReason,
            },
        };
    }

    if (!response.outputText) {
        return {
            patch: emptyNotesLivePatch(true),
            failure: {
                category: "empty_output",
                outputChars: 0,
                durationMs: response.durationMs,
            },
        };
    }

    const patch = parseNotesLivePatchContent(response.outputText);
    if (patch.parseFailed) {
        return {
            patch,
            failure: {
                category: "parse_failed",
                outputChars: response.outputText.length,
                durationMs: response.durationMs,
            },
        };
    }

    if (!hasStrictNotesLivePatchShape(response.outputText)) {
        return {
            patch: emptyNotesLivePatch(true),
            failure: {
                category: "schema_invalid",
                outputChars: response.outputText.length,
                durationMs: response.durationMs,
            },
        };
    }

    logNotesLivePatchReceived(patch, request, "responses", {
        outputChars: response.outputText.length,
        durationMs: response.durationMs,
        totalTokens: response.usage.totalTokens,
        reasoningTokens: response.usage.reasoningTokens,
    });
    return { patch };
}

function hasStrictNotesLivePatchShape(content: string): boolean {
    try {
        const parsed = JSON.parse(content) as {
            updates?: unknown;
            fallbackAppendMarkdown?: unknown;
        };

        if (!parsed || typeof parsed !== "object") return false;
        const topLevelKeys = Object.keys(parsed);
        if (topLevelKeys.length !== 2 ||
            !topLevelKeys.includes("updates") ||
            !topLevelKeys.includes("fallbackAppendMarkdown")) return false;
        if (!Array.isArray(parsed.updates)) return false;
        if (typeof parsed.fallbackAppendMarkdown !== "string") return false;

        return parsed.updates.every((entry) => {
            if (!entry || typeof entry !== "object") return false;
            const raw = entry as {
                targetHeading?: unknown;
                targetLevel?: unknown;
                appendMarkdown?: unknown;
            };
            const updateKeys = Object.keys(raw);
            if (updateKeys.length !== 3 ||
                !updateKeys.includes("targetHeading") ||
                !updateKeys.includes("targetLevel") ||
                !updateKeys.includes("appendMarkdown")) return false;
            return typeof raw.targetHeading === "string" &&
                (raw.targetLevel === 2 || raw.targetLevel === 3) &&
                typeof raw.appendMarkdown === "string";
        });
    } catch {
        return false;
    }
}

/**
 * Incrementally update markdown notes with a new transcript segment.
 * Runs on the same cadence as extractAttributesFromText.
 * Uses the configured low-latency live model.
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
