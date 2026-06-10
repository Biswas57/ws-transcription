import { applyNotesLivePatch, type NotesLivePatch } from "../notes-live-patch.js";
import {
    GPT_LIVE_REASONING_EFFORT,
    GPT_MINI_MODEL,
    GPT_REQUEST_TIMEOUT_MS,
    countTokens,
    getNotesLiveProviderMode,
} from "./model-config.js";
import { buildNotesLiveCurrentContext } from "./notes-live-context.js";
import { openai, runOpenAIResponsesJson } from "./provider.js";
import { recordUsageEvent, safeErrorInfo, safeUsageMetadata } from "../safe-log.js";

type NotesLiveFallbackCategory =
    | "provider_error"
    | "incomplete_response"
    | "empty_output"
    | "parse_failed"
    | "schema_failed";

export const NOTES_INCREMENTAL_SYS_TXT = `\
You are a live note-taking scribe in an Australian context.

You are given:
1. note_style - the style/context of notes (clinical, meeting, study, general, or similar)
2. sections - optional preferred section headings to organise notes under (may be empty)
3. current_notes - the full canonical notes accumulated so far, including prior recording segments and possible manual edits
4. transcript_segment - the latest revised transcript segment to incorporate

YOUR TASK:
Read current_notes for context and transcript_segment for new information.
Return small append-only updates for information from transcript_segment that is missing from current_notes.

LIVE NOTE PURPOSE:
The notes should feel useful while recording, not just after finalisation.
Create useful structure once enough signal exists, usually within the first 2-4 updates.
Do not leave all content under a generic "Live updates" heading once the topic is clear.
As the session develops, prefer content-specific headings over generic headings.
Prefer headings based on the actual content, such as themes, phases, concepts, decisions, process areas, or discussion topics.
If current_notes is empty or has no useful structure yet, create a small provisional structure using concise ## headings in fallbackAppendMarkdown.
Prefer 2-5 useful sections over one long generic bullet list.
Use provisional headings when needed; final notes can improve them later.

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
- New facts, decisions, actions, owners, blockers, process steps, examples, caveats, dates/times, requirements, definitions, and important details.
- New questions, uncertainties, risks, or items needing verification.
- Corrections or clarifications to earlier notes, but append them as corrections/clarifications rather than editing old content.
- Technical acronyms, product names, case names, cluster identifiers, IDs, workflow names, and proper nouns exactly where possible.
- Representative examples when they explain or anchor a concept.
- Meaningful tangents, side segments, announcements, or off-topic-but-useful content, kept concise and separate when they would otherwise clutter the main notes.
- If a term is uncertain, keep it uncertain rather than inventing a correction.

DUPLICATE CONTROL:
- Only append details that are not already captured in current_notes.
- If transcript_segment repeats something already present, omit it.
- If transcript_segment expands an existing point with a genuinely new detail, append only the new detail.
- Duplicates may still happen occasionally; final notes will dedupe later.

TARGET HEADING RULES:
- Prefer an existing ## or ### heading from current_notes when it fits.
- targetHeading must be the existing heading text only, without leading ## or ###.
- targetLevel should be 2 for ## headings and 3 for ### headings.
- Prefer exact existing heading text.
- If sections were provided and matching headings already exist in current_notes, prefer those stable top-level sections.
- If sections were provided but the new content clearly does not fit any section yet, do not force it into the wrong section.
- Use a neutral temporary section sparingly only when needed.
- When transcript_segment introduces a clear new major topic, create or use an appropriate ## heading.
- After the first few updates, avoid continuing under one broad or generic section when clearer topic sections are available.
- If no existing heading fits and creating a new heading would make the notes clearer, use fallbackAppendMarkdown with a concise new ## heading and bullets.
- If current_notes is empty or only has a generic live-update section, use fallbackAppendMarkdown to create the first useful provisional ## sections.
- Do not create a # document title in live updates.

APPEND MARKDOWN RULES:
- appendMarkdown must be a small markdown fragment, not a full document.
- Use - bullets for most live notes.
- Use nested bullets with two leading spaces when useful.
- Use ## headings in fallbackAppendMarkdown only when needed to create useful structure.
- Use ### subheadings only when they make the appended content clearer.
- Avoid fenced code blocks unless transcript_segment clearly contains an exact command/log snippet that must be preserved.
- Use **bold** sparingly for key terms only when helpful.
- Keep appendMarkdown concise but not lossy.

STYLE GUIDANCE:
- clinical: concise professional clinical-style observations, risks, actions, and follow-up items.
- meeting: decisions, actions, owners, blockers, dates, and unresolved questions.
- study: concepts, definitions, process steps, examples, caveats, and review-oriented notes.
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
        return { updates: [], parseFailed: true };
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
    category: NotesLiveFallbackCategory;
    outputChars?: number;
    durationMs?: number;
    incompleteReason?: string | null;
};

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
    provider: "chat" | "responses",
    fallbackUsed: boolean,
    extra: { outputChars?: number; durationMs?: number; totalTokens?: number; reasoningTokens?: number } = {}
): void {
    console.log(
        `[notes-incremental-patch] Patch received — ` +
        `provider: ${provider}, ` +
        `fallbackUsed: ${fallbackUsed}, ` +
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
        fallbackUsed,
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
    provider: "chat" | "responses",
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

function logNotesLiveFallback(
    failure: NotesLivePatchFailure,
    request: NotesLivePatchRequest,
    errorInfo?: string
): void {
    const parts = [
        `[notes-incremental-patch] Falling back to chat`,
        `category: ${failure.category}`,
        `transcriptChars: ${request.transcriptChars}`,
        `currentNotesChars: ${request.currentNotesChars}`,
    ];

    if (typeof failure.outputChars === "number") parts.push(`outputChars: ${failure.outputChars}`);
    if (typeof failure.durationMs === "number") parts.push(`duration: ${failure.durationMs}ms`);
    if (failure.incompleteReason) parts.push(`incompleteReason: ${failure.incompleteReason}`);
    if (errorInfo) parts.push(`error: ${errorInfo}`);

    console.warn(parts.join(" — "));
    recordUsageEvent("notes_live_patch_fallback", {
        flow: "notes-live-patch",
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
    if (transcriptSegment.trim().length < 20) return { updates: [] };

    const request = buildNotesLivePatchRequest(
        transcriptSegment,
        currentNotes,
        noteStyle,
        sections
    );
    const provider = getNotesLiveProviderMode();
    logNotesLiveProviderSelected(provider, request);

    if (provider === "responses") {
        try {
            const result = await generateNotesIncrementalPatchResponses(request);
            if (!result.patch.parseFailed) return result.patch;
            logNotesLiveFallback(result.failure ?? { category: "parse_failed" }, request);
        } catch (err) {
            logNotesLiveFallback({ category: "provider_error" }, request, safeErrorInfo(err));
        }

        return generateNotesIncrementalPatchChat(request, true);
    }

    return generateNotesIncrementalPatchChat(request, false);
}

async function generateNotesIncrementalPatchChat(
    request: NotesLivePatchRequest,
    fallbackUsed: boolean
): Promise<NotesLivePatch> {
    const startedAt = Date.now();
    const completion = await openai.chat.completions.create({
        model: GPT_MINI_MODEL,
        store: false,
        messages: [
            { role: "system", content: NOTES_INCREMENTAL_SYS_TXT },
            { role: "user", content: request.input },
        ],
        max_completion_tokens: request.maxOutputTokens,
        response_format: { type: "json_object" },
        reasoning_effort: GPT_LIVE_REASONING_EFFORT,
    }, { timeout: GPT_REQUEST_TIMEOUT_MS });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
        console.warn("[notes-incremental-patch] Empty response, returning empty patch");
        recordUsageEvent("notes_live_patch_complete", {
            flow: "notes-live-patch",
            provider: "chat",
            fallbackUsed,
            parseFailed: false,
            transcriptChars: request.transcriptChars,
            currentNotesChars: request.currentNotesChars,
            currentNotesContextChars: request.currentNotesContextChars,
            contextCompacted: request.contextCompacted,
            contextSavedChars: request.contextSavedChars,
            headingCount: request.headingCount,
            estimatedInputTokens: request.inputTokens,
            maxOutputTokens: request.maxOutputTokens,
            outputChars: 0,
            durationMs: Date.now() - startedAt,
        });
        return { updates: [] };
    }

    const patch = parseNotesLivePatchContent(content);
    const usage = safeUsageMetadata(completion.usage);
    logNotesLivePatchReceived(patch, request, "chat", fallbackUsed, {
        outputChars: content.length,
        durationMs: Date.now() - startedAt,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
    });
    return patch;
}

async function generateNotesIncrementalPatchResponses(
    request: NotesLivePatchRequest
): Promise<{ patch: NotesLivePatch; failure?: NotesLivePatchFailure }> {
    const response = await runOpenAIResponsesJson({
        label: "notes-incremental-patch",
        model: GPT_MINI_MODEL,
        reasoningEffort: GPT_LIVE_REASONING_EFFORT,
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
            patch: { updates: [], parseFailed: true },
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
            patch: { updates: [], parseFailed: true },
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
            patch: { updates: [], parseFailed: true },
            failure: {
                category: "schema_failed",
                outputChars: response.outputText.length,
                durationMs: response.durationMs,
            },
        };
    }

    logNotesLivePatchReceived(patch, request, "responses", false, {
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
