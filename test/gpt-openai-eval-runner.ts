import {
    EXTRACT_SYS_TXT as FORMS_LIVE_SYS_TXT,
    FINAL_SYS_TXT as FORMS_FINAL_SYS_TXT,
    finalAttributesResponseSchema,
    liveAttributesResponseSchema,
} from "../gpt/forms.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { extractJsonObjectText, isRecord } from "../gpt/json-parsing.js";
import {
    countTokens,
    notesFinalOutputBudget,
    notesTransformOutputBudget,
    NOTES_REORGANISE_OUTPUT_TOKEN_MULTIPLIER,
    NOTES_SUMMARY_OUTPUT_TOKEN_MULTIPLIER,
    GPT_REQUEST_TIMEOUT_MS,
} from "../gpt/model-config.js";
import {
    NOTES_FINAL_RESPONSE_SCHEMA,
    NOTES_FINAL_SYS_TXT,
} from "../gpt/notes-final.js";
import {
    NOTES_INCREMENTAL_SYS_TXT,
    NOTES_LIVE_PATCH_RESPONSE_SCHEMA,
    parseNotesLivePatchContent,
} from "../gpt/notes-live.js";
import {
    NOTES_REORGANISE_RESPONSE_SCHEMA,
    NOTES_REORGANISE_SYS_TXT,
    NOTES_SUMMARISE_SYS_TXT,
    NOTES_SUMMARY_RESPONSE_SCHEMA,
    parseNotesTransformMarkdown,
} from "../gpt/notes-transform.js";
import {
    type ResponsesJsonCallResult,
    openai,
    runOpenAIResponsesJson,
} from "../gpt/provider.js";
import { safeUsageMetadata, type SafeUsageMetadata } from "../safe-log.js";
import { applyNotesLivePatch, type NotesLivePatch } from "../notes-live-patch.js";
import { normalizeMarkdownHeading } from "../notes-live-patch.js";
import {
    compressionRatio,
    containsAllConcepts,
    containsForbiddenConcepts,
    countMarkdownBullets,
    countMarkdownHeadings,
    extractOpenQuestions,
} from "./gpt-quality-eval-helpers.js";
import {
    formsLiveFixtures,
    formsFinalFixtures,
    notesFinalFixtures,
    notesLiveFixtures,
    notesTransformFixtures,
} from "./fixtures/gpt-evals/index.js";
import {
    gptReasoningExperiments,
    type GptEvalFlow,
    type GptEvalVariant,
} from "./fixtures/gpt-evals/reasoning-experiments.js";
import type {
    FormsFinalEvalFixture,
    FormsLiveEvalFixture,
    NotesFinalEvalFixture,
    NotesLiveEvalFixture,
    NotesTransformEvalFixture,
} from "./fixtures/gpt-evals/types.js";

export const supportedOpenAIEvalFlows = [
    "forms-live-extraction",
    "notes-live-patch",
    "forms-final",
    "notes-final",
    "summarise",
    "reorganise",
] as const;

export type SupportedOpenAIEvalFlow = typeof supportedOpenAIEvalFlows[number];

export type OpenAIEvalCase = {
    experimentName: string;
    flow: SupportedOpenAIEvalFlow;
    fixtureName: string;
    fixture:
    | FormsFinalEvalFixture
    | FormsLiveEvalFixture
    | NotesFinalEvalFixture
    | NotesLiveEvalFixture
    | NotesTransformEvalFixture;
    variantName: string;
    variant: GptEvalVariant;
};

export type OpenAIEvalFormsMetrics = {
    expectedFieldMatchCount: number;
    expectedFieldMismatchCount: number;
    unknownEmptyCorrectCount: number;
    unknownEmptyMismatchCount: number;
    notApplicableCorrectCount: number;
    notApplicableMismatchCount: number;
    inventedValueCount: number;
};

export type OpenAIEvalNotesLiveMetrics = {
    updateCount: number;
    fallbackUsed: boolean;
    patchChars: number;
    appliedChanged: boolean;
    rejectedBySafetyFilter: boolean;
};

export type OpenAIEvalResult = {
    fixtureName: string;
    flow: SupportedOpenAIEvalFlow;
    variantName: string;
    model: string;
    reasoningEffort?: string;
    passed: boolean;
    parseSuccess: boolean;
    status?: string;
    incompleteReason?: string | null;
    durationMs: number;
    outputChars: number;
    compressionRatio?: number;
    headingCount?: number;
    bulletCount?: number;
    suspiciouslyShort?: boolean;
    missingRequiredConcepts: string[];
    forbiddenConceptsFound: string[];
    expectedOpenQuestionsMissing?: string[];
    expectedSectionHintsMissing?: string[];
    forms?: OpenAIEvalFormsMetrics;
    notesLive?: OpenAIEvalNotesLiveMetrics;
    usage?: SafeUsageMetadata;
    notes: string[];
};

export type StaticOpenAIEvalOutput =
    | { parsedAttributes: Record<string, string> }
    | { liveAttributeUpdates: FormsLiveAttributeUpdate[] }
    | { finalAttributes: Record<string, string> }
    | { notesLivePatch: NotesLivePatch }
    | { notesMarkdown: string }
    | { summaryMarkdown: string }
    | { reorganisedMarkdown: string };

export type FormsLiveAttributeUpdate = {
    fieldKey: string;
    value: string;
};

type EvalRequest = {
    label: string;
    instructions: string;
    input: string;
    maxOutputTokens: number;
    jsonSchema: Parameters<typeof runOpenAIResponsesJson>[0]["jsonSchema"];
};

const FORMS_LIVE_RESPONSES_UPDATES_SYS_TXT = `${FORMS_LIVE_SYS_TXT}

STRICT EVAL OUTPUT OVERRIDE:
For this Responses strict-schema eval, return ONLY this sparse shape:
{"updates":[{"fieldKey":"allowed_key","value":"new or corrected value"}]}

Rules:
- Use only allowed_keys as fieldKey.
- Include only fields with new or corrected information from transcript_segment.
- Do not include unknown, unmentioned, vague, side-topic, or already-complete fields.
- If a correction is spoken, include only the corrected value.
- If a field is explicitly not applicable, use "N/A".
- If there are no safe updates, return {"updates":[]}.`;

const supportedFlowSet = new Set<GptEvalFlow>(supportedOpenAIEvalFlows);
type OpenAIEvalsEnv = Partial<Record<
    | "OPENAI_EVALS"
    | "OPENAI_API_KEY"
    | "OPENAI_EVALS_WRITE_OUTPUTS"
    | "OPENAI_EVALS_OUTPUT_DIR"
    | "OPENAI_EVAL_FLOWS",
    string | undefined
>>;

export function shouldSkipOpenAIEvals(
    env: OpenAIEvalsEnv = {
        OPENAI_EVALS: process.env.OPENAI_EVALS,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
): string | null {
    if (env.OPENAI_EVALS !== "1") return "OPENAI_EVALS is not set to 1";
    if (!env.OPENAI_API_KEY) return "OPENAI_API_KEY is not set";
    return null;
}

export function shouldWriteOpenAIEvalOutputs(
    env: OpenAIEvalsEnv = {
        OPENAI_EVALS_WRITE_OUTPUTS: process.env.OPENAI_EVALS_WRITE_OUTPUTS,
    }
): boolean {
    return env.OPENAI_EVALS_WRITE_OUTPUTS === "1";
}

export function openAIEvalOutputDir(
    env: OpenAIEvalsEnv = {
        OPENAI_EVALS_OUTPUT_DIR: process.env.OPENAI_EVALS_OUTPUT_DIR,
    }
): string {
    return env.OPENAI_EVALS_OUTPUT_DIR?.trim() || "/tmp/formify-gpt-eval-outputs";
}

export function selectOpenAIEvalCases(
    env: OpenAIEvalsEnv = {
        OPENAI_EVAL_FLOWS: process.env.OPENAI_EVAL_FLOWS,
    }
): OpenAIEvalCase[] {
    const cases: OpenAIEvalCase[] = [];
    const selectedFlows = selectedOpenAIEvalFlows(env);

    for (const experiment of gptReasoningExperiments) {
        if (!supportedFlowSet.has(experiment.flow)) continue;
        const flow = experiment.flow as SupportedOpenAIEvalFlow;
        if (selectedFlows && !selectedFlows.has(flow)) continue;

        const variants = experiment.variants.filter((variant) => shouldSelectVariant(flow, variant));

        for (const fixtureName of experiment.linkedFixtures) {
            const fixture = findFixtureForFlow(flow, fixtureName);
            if (!fixture) continue;

            for (const variant of variants) {
                cases.push({
                    experimentName: experiment.name,
                    flow,
                    fixtureName,
                    fixture,
                    variantName: variant.name,
                    variant,
                });
            }
        }
    }

    return cases;
}

export function selectedOpenAIEvalFlows(
    env: OpenAIEvalsEnv = {
        OPENAI_EVAL_FLOWS: process.env.OPENAI_EVAL_FLOWS,
    }
): Set<SupportedOpenAIEvalFlow> | null {
    const raw = env.OPENAI_EVAL_FLOWS?.trim();
    if (!raw) return null;

    const flows = new Set<SupportedOpenAIEvalFlow>();
    for (const token of raw.split(",")) {
        for (const flow of normalizeEvalFlowToken(token)) {
            flows.add(flow);
        }
    }

    return flows;
}

function normalizeEvalFlowToken(token: string): SupportedOpenAIEvalFlow[] {
    const normalized = token.trim().toLowerCase();
    if (!normalized) return [];
    if (normalized === "live") return ["forms-live-extraction", "notes-live-patch"];
    if (normalized === "forms-live") return ["forms-live-extraction"];
    if (normalized === "notes-live") return ["notes-live-patch"];

    return supportedOpenAIEvalFlows.includes(normalized as SupportedOpenAIEvalFlow)
        ? [normalized as SupportedOpenAIEvalFlow]
        : [];
}

function shouldSelectVariant(flow: SupportedOpenAIEvalFlow, variant: GptEvalVariant): boolean {
    if (flow === "forms-live-extraction" || flow === "notes-live-patch") {
        if (variant.productionDefault && variant.api === "chat-completions") return true;
        return variant.api === "responses" &&
            variant.outputMode === "json_schema" &&
            variant.reasoning === "low";
    }

    return variant.api === "responses" &&
        variant.outputMode === "json_schema" &&
        (variant.productionDefault || variant.reasoning === "low");
}

export async function runOpenAIEvalCase(evalCase: OpenAIEvalCase): Promise<OpenAIEvalResult> {
    const request = buildEvalRequest(evalCase);
    if (evalCase.variant.api === "chat-completions") {
        const response = await runOpenAIChatJson(evalCase, request);
        writeRawOutputIfEnabled(evalCase, response.outputText);
        return evaluateResponseOutput(evalCase, response);
    }

    const response = await runOpenAIResponsesJson({
        label: request.label,
        model: evalCase.variant.model,
        reasoningEffort: evalCase.variant.reasoning,
        instructions: request.instructions,
        input: request.input,
        maxOutputTokens: request.maxOutputTokens,
        jsonSchema: request.jsonSchema,
        metadata: {
            flow: evalCase.flow,
            fixtureName: evalCase.fixtureName,
            variantName: evalCase.variantName,
        },
    });

    writeRawOutputIfEnabled(evalCase, response.outputText);
    return evaluateResponseOutput(evalCase, response);
}

async function runOpenAIChatJson(
    evalCase: OpenAIEvalCase,
    request: EvalRequest
): Promise<ResponsesJsonCallResult> {
    const startedAt = Date.now();
    const completion = await openai.chat.completions.create({
        model: evalCase.variant.model,
        store: false,
        messages: [
            { role: "system", content: request.instructions },
            { role: "user", content: request.input },
        ],
        max_completion_tokens: request.maxOutputTokens,
        response_format: { type: "json_object" },
        reasoning_effort: evalCase.variant.reasoning === "none"
            ? undefined
            : evalCase.variant.reasoning,
    }, { timeout: GPT_REQUEST_TIMEOUT_MS });

    const durationMs = Date.now() - startedAt;
    return {
        outputText: completion.choices?.[0]?.message?.content ?? "",
        status: "completed",
        incompleteReason: null,
        durationMs,
        usage: safeUsageMetadata(completion.usage),
    };
}

export function evaluateStaticOpenAIEvalOutput(
    evalCase: OpenAIEvalCase,
    output: StaticOpenAIEvalOutput
): OpenAIEvalResult {
    return evaluateParsedOutput(evalCase, output, {
        parseSuccess: true,
        durationMs: 0,
        outputChars: staticOutputChars(output),
        notes: ["static-output"],
    });
}

export function formatOpenAIEvalResults(results: OpenAIEvalResult[]): string {
    const lines = [
        "| Flow | Fixture | Variant | Pass | Duration | Total tokens | Reasoning tokens | Output chars | Main notes |",
        "| ---- | ------- | ------- | ---: | -------: | -----------: | ---------------: | -----------: | ---------- |",
    ];

    for (const result of results) {
        const mainNotes = [
            result.parseSuccess ? undefined : "parse failed",
            result.incompleteReason ? `incomplete=${result.incompleteReason}` : undefined,
            result.missingRequiredConcepts.length > 0 ? `missing=${result.missingRequiredConcepts.length}` : undefined,
            result.forbiddenConceptsFound.length > 0 ? `forbidden=${result.forbiddenConceptsFound.length}` : undefined,
            typeof result.compressionRatio === "number" ? `ratio=${result.compressionRatio.toFixed(2)}` : undefined,
            ...result.notes,
        ].filter(Boolean).join("; ") || "-";

        lines.push([
            result.flow,
            result.fixtureName,
            result.variantName,
            result.passed ? "yes" : "no",
            `${result.durationMs}ms`,
            formatOptionalNumber(result.usage?.totalTokens),
            formatOptionalNumber(result.usage?.reasoningTokens),
            String(result.outputChars),
            mainNotes,
        ].join(" | "));
    }

    return lines.join("\n");
}

function buildEvalRequest(evalCase: OpenAIEvalCase): EvalRequest {
    switch (evalCase.flow) {
        case "forms-live-extraction": {
            const fixture = evalCase.fixture as FormsLiveEvalFixture;
            const allowedKeys = fixture.fields.map((field) => field.key);
            return {
                label: "eval-forms-live",
                instructions: evalCase.variant.api === "responses"
                    ? FORMS_LIVE_RESPONSES_UPDATES_SYS_TXT
                    : FORMS_LIVE_SYS_TXT,
                input: JSON.stringify({
                    allowed_keys: allowedKeys,
                    current_values: fixture.currentAttributes ?? {},
                    transcript_segment: fixture.transcriptSegment,
                }),
                maxOutputTokens: Math.max(512, fixture.fields.length * 60),
                jsonSchema: liveAttributesResponseSchema(allowedKeys),
            };
        }
        case "notes-live-patch": {
            const fixture = evalCase.fixture as NotesLiveEvalFixture;
            const transcriptTokens = countTokens(fixture.pendingTranscript);
            return {
                label: "eval-notes-live-patch",
                instructions: NOTES_INCREMENTAL_SYS_TXT,
                input: JSON.stringify({
                    note_style: fixture.noteStyle,
                    current_notes: fixture.currentNotes,
                    transcript_segment: fixture.pendingTranscript,
                }),
                maxOutputTokens: Math.min(
                    2048,
                    Math.max(1024, Math.ceil(transcriptTokens * 1.2) + 512)
                ),
                jsonSchema: NOTES_LIVE_PATCH_RESPONSE_SCHEMA,
            };
        }
        case "forms-final": {
            const fixture = evalCase.fixture as FormsFinalEvalFixture;
            const allowedKeys = fixture.fields.map((field) => field.key);
            return {
                label: "eval-forms-final",
                instructions: FORMS_FINAL_SYS_TXT,
                input: JSON.stringify({
                    allowed_keys: allowedKeys,
                    current_values: fixture.candidateAttributes ?? {},
                    full_transcript: fixture.transcript,
                }),
                maxOutputTokens: Math.max(1024, fixture.fields.length * 80),
                jsonSchema: finalAttributesResponseSchema(allowedKeys),
            };
        }
        case "notes-final": {
            const fixture = evalCase.fixture as NotesFinalEvalFixture;
            const inputTokens = countTokens(fixture.transcript) + countTokens(fixture.currentNotes);
            return {
                label: "eval-notes-final",
                instructions: NOTES_FINAL_SYS_TXT,
                input: JSON.stringify({
                    note_style: fixture.noteStyle,
                    current_notes: fixture.currentNotes,
                    available_transcript: fixture.transcript,
                }),
                maxOutputTokens: notesFinalOutputBudget(inputTokens),
                jsonSchema: NOTES_FINAL_RESPONSE_SCHEMA,
            };
        }
        case "summarise": {
            const fixture = evalCase.fixture as NotesTransformEvalFixture;
            const inputTokens = countTokens(fixture.currentVisibleNotes);
            return {
                label: "eval-notes-summarise",
                instructions: NOTES_SUMMARISE_SYS_TXT,
                input: JSON.stringify({
                    note_style: fixture.noteStyle,
                    current_visible_notes: fixture.currentVisibleNotes,
                }),
                maxOutputTokens: notesTransformOutputBudget(inputTokens, NOTES_SUMMARY_OUTPUT_TOKEN_MULTIPLIER),
                jsonSchema: NOTES_SUMMARY_RESPONSE_SCHEMA,
            };
        }
        case "reorganise": {
            const fixture = evalCase.fixture as NotesTransformEvalFixture;
            const inputTokens = countTokens(fixture.currentVisibleNotes);
            return {
                label: "eval-notes-reorganise",
                instructions: NOTES_REORGANISE_SYS_TXT,
                input: JSON.stringify({
                    note_style: fixture.noteStyle,
                    current_visible_notes: fixture.currentVisibleNotes,
                }),
                maxOutputTokens: notesTransformOutputBudget(inputTokens, NOTES_REORGANISE_OUTPUT_TOKEN_MULTIPLIER),
                jsonSchema: NOTES_REORGANISE_RESPONSE_SCHEMA,
            };
        }
    }
}

function evaluateResponseOutput(
    evalCase: OpenAIEvalCase,
    response: ResponsesJsonCallResult
): OpenAIEvalResult {
    const outputChars = response.outputText.length;
    const parsed = parseResponseOutput(evalCase, response.outputText);

    if (!parsed.parseSuccess) {
        return baseResult(evalCase, {
            parseSuccess: false,
            status: response.status,
            incompleteReason: response.incompleteReason,
            durationMs: response.durationMs,
            outputChars,
            usage: response.usage,
            notes: [parsed.reason],
        });
    }

    return evaluateParsedOutput(evalCase, parsed.output, {
        parseSuccess: true,
        status: response.status,
        incompleteReason: response.incompleteReason,
        durationMs: response.durationMs,
        outputChars,
        usage: response.usage,
        notes: response.status === "incomplete" ? ["incomplete-response"] : [],
    });
}

function parseResponseOutput(
    evalCase: OpenAIEvalCase,
    outputText: string
): { parseSuccess: true; output: StaticOpenAIEvalOutput } | { parseSuccess: false; reason: string } {
    if (!outputText.trim()) return { parseSuccess: false, reason: "empty-output" };

    try {
        if (evalCase.flow === "summarise") {
            return {
                parseSuccess: true,
                output: {
                    summaryMarkdown: parseNotesTransformMarkdown(
                        outputText,
                        "summaryMarkdown",
                        ["notesMarkdown", "markdown", "outputMarkdown"]
                    ),
                },
            };
        }

        if (evalCase.flow === "reorganise") {
            return {
                parseSuccess: true,
                output: {
                    reorganisedMarkdown: parseNotesTransformMarkdown(outputText, "reorganisedMarkdown"),
                },
            };
        }

        const parsed = JSON.parse(extractJsonObjectText(outputText)) as unknown;
        if (!isRecord(parsed)) return { parseSuccess: false, reason: "invalid-json-shape" };

        if (evalCase.flow === "forms-live-extraction" && isRecord(parsed.parsedAttributes)) {
            return {
                parseSuccess: true,
                output: { parsedAttributes: stringifyRecord(parsed.parsedAttributes) },
            };
        }

        if (evalCase.flow === "forms-live-extraction" && Array.isArray(parsed.updates)) {
            return {
                parseSuccess: true,
                output: { liveAttributeUpdates: parseFormsLiveUpdates(parsed.updates) },
            };
        }

        if (evalCase.flow === "notes-live-patch") {
            const patch = parseNotesLivePatchContent(outputText);
            if (patch.parseFailed) return { parseSuccess: false, reason: "invalid-json" };
            return {
                parseSuccess: true,
                output: { notesLivePatch: patch },
            };
        }

        if (evalCase.flow === "forms-final" && isRecord(parsed.finalAttributes)) {
            return {
                parseSuccess: true,
                output: { finalAttributes: stringifyRecord(parsed.finalAttributes) },
            };
        }

        if (evalCase.flow === "notes-final" && typeof parsed.notesMarkdown === "string") {
            return {
                parseSuccess: true,
                output: { notesMarkdown: parsed.notesMarkdown },
            };
        }

        return { parseSuccess: false, reason: "missing-expected-key" };
    } catch {
        return { parseSuccess: false, reason: "invalid-json" };
    }
}

function evaluateParsedOutput(
    evalCase: OpenAIEvalCase,
    output: StaticOpenAIEvalOutput,
    metadata: {
        parseSuccess: boolean;
        status?: string;
        incompleteReason?: string | null;
        durationMs: number;
        outputChars: number;
        usage?: SafeUsageMetadata;
        notes: string[];
    }
): OpenAIEvalResult {
    const notes = [...metadata.notes];
    let missingRequiredConcepts: string[] = [];
    let forbiddenConceptsFound: string[] = [];
    let expectedOpenQuestionsMissing: string[] | undefined;
    let expectedSectionHintsMissing: string[] | undefined;
    let forms: OpenAIEvalFormsMetrics | undefined;
    let notesLive: OpenAIEvalNotesLiveMetrics | undefined;
    let ratio: number | undefined;
    let headingCount: number | undefined;
    let bulletCount: number | undefined;
    let suspiciouslyShort = false;

    if (evalCase.flow === "forms-live-extraction") {
        const fixture = evalCase.fixture as FormsLiveEvalFixture;
        const parsedAttributes = "liveAttributeUpdates" in output
            ? formsLiveUpdatesToSparseAttributes(output.liveAttributeUpdates)
            : "parsedAttributes" in output
                ? output.parsedAttributes
                : {};
        const sparseAttributes = sparseNonEmptyRecord(parsedAttributes);
        forms = evaluateFormsLive(fixture, sparseAttributes);
        missingRequiredConcepts = forms.expectedFieldMismatchCount > 0
            ? [`field-mismatches:${forms.expectedFieldMismatchCount}`]
            : [];
        forbiddenConceptsFound = containsForbiddenConcepts(
            Object.values(sparseAttributes).join("\n"),
            fixture.forbiddenConcepts ?? []
        );
    } else if (evalCase.flow === "forms-final") {
        const fixture = evalCase.fixture as FormsFinalEvalFixture;
        const finalAttributes = "finalAttributes" in output ? output.finalAttributes : {};
        forms = evaluateFormsFinal(fixture, finalAttributes);
        missingRequiredConcepts = forms.expectedFieldMismatchCount > 0
            ? [`field-mismatches:${forms.expectedFieldMismatchCount}`]
            : [];
        forbiddenConceptsFound = containsForbiddenConcepts(
            Object.values(finalAttributes).join("\n"),
            fixture.forbiddenConcepts ?? []
        );
    } else if (evalCase.flow === "notes-live-patch") {
        const fixture = evalCase.fixture as NotesLiveEvalFixture;
        const patch = "notesLivePatch" in output ? output.notesLivePatch : { updates: [] };
        const appliedMarkdown = applyNotesLivePatch(fixture.currentNotes, patch);
        const patchMarkdown = notesLivePatchMarkdown(patch);
        const appliedDeltaMarkdown = addedMarkdownLines(fixture.currentNotes, appliedMarkdown);
        const appliedChanged = appliedMarkdown !== fixture.currentNotes;
        const hasPatchContent = patchMarkdown.trim().length > 0;
        notesLive = {
            updateCount: patch.updates.length,
            fallbackUsed: Boolean(patch.fallbackAppendMarkdown?.trim()),
            patchChars: patchMarkdown.length,
            appliedChanged,
            rejectedBySafetyFilter: hasPatchContent && !appliedChanged,
        };

        missingRequiredConcepts = containsAllConcepts(appliedMarkdown, fixture.requiredPatchConcepts);
        forbiddenConceptsFound = containsForbiddenConcepts(appliedDeltaMarkdown, fixture.forbiddenPatchConcepts);
        headingCount = countMarkdownHeadings(appliedMarkdown);
        bulletCount = countMarkdownBullets(appliedMarkdown);

        if (!appliedChanged) notes.push("no-applied-change");
        if (notesLive.rejectedBySafetyFilter) notes.push("rejected-by-safety-filter");
        if (/^#\s+/m.test(appliedDeltaMarkdown)) notes.push("document-title-in-applied-notes");
        if (/^#\s+/m.test(patchMarkdown) && !/^#\s+/m.test(appliedDeltaMarkdown)) {
            notes.push("document-title-filtered");
        }

        const repeatedLines = repeatedExistingLines(fixture.currentNotes, appliedMarkdown);
        if (repeatedLines.length > 0) notes.push(`repeated-existing-lines:${repeatedLines.length}`);

        if (fixture.expectedFallbackUsed !== undefined &&
            notesLive.fallbackUsed !== fixture.expectedFallbackUsed) {
            notes.push(fixture.expectedFallbackUsed ? "expected-fallback-missing" : "unexpected-fallback-used");
        }

        if (fixture.expectedTargetHeading) {
            const expectedHeading = normalizeMarkdownHeading(fixture.expectedTargetHeading);
            const matchedHeading = patch.updates.some((update) =>
                normalizeMarkdownHeading(update.targetHeading) === expectedHeading
            );
            if (!matchedHeading) notes.push("expected-heading-not-targeted");
        }
    } else {
        const markdown = markdownFromOutput(output);
        const fixture = evalCase.fixture as NotesFinalEvalFixture | NotesTransformEvalFixture;
        missingRequiredConcepts = containsAllConcepts(markdown, fixture.requiredConcepts);
        forbiddenConceptsFound = containsForbiddenConcepts(markdown, fixture.forbiddenConcepts);
        headingCount = countMarkdownHeadings(markdown);
        bulletCount = countMarkdownBullets(markdown);

        if (fixture.expectedOpenQuestions && fixture.expectedOpenQuestions.length > 0) {
            expectedOpenQuestionsMissing = containsAllConcepts(
                extractOpenQuestions(markdown).join("\n"),
                fixture.expectedOpenQuestions
            );
        }

        if (evalCase.flow === "summarise") {
            const transformFixture = fixture as NotesTransformEvalFixture;
            ratio = compressionRatio(transformFixture.currentVisibleNotes, markdown);
            if (typeof transformFixture.maxCompressionRatio === "number" &&
                ratio > transformFixture.maxCompressionRatio) {
                notes.push("compression-ratio-above-target");
            }
            suspiciouslyShort = markdown.length < transformFixture.currentVisibleNotes.length * 0.15;
        }

        if (evalCase.flow === "reorganise") {
            const transformFixture = fixture as NotesTransformEvalFixture;
            ratio = compressionRatio(transformFixture.currentVisibleNotes, markdown);
            expectedSectionHintsMissing = transformFixture.expectedSectionHints
                ? containsAllConcepts(markdown, transformFixture.expectedSectionHints)
                : [];
            if (typeof transformFixture.minPreservationRatio === "number" &&
                ratio < transformFixture.minPreservationRatio) {
                notes.push("preservation-ratio-below-target");
            }
            suspiciouslyShort = markdown.length < transformFixture.currentVisibleNotes.length * 0.5;
        }

        if (evalCase.flow === "notes-final") {
            const finalFixture = fixture as NotesFinalEvalFixture;
            suspiciouslyShort = !finalFixture.allowConciseFinalOutput &&
                markdown.length < Math.min(120, finalFixture.currentNotes.length * 0.5);
        }

        if (suspiciouslyShort) notes.push("suspiciously-short");
    }

    const failedNotes = notes.filter((note) =>
        note.includes("ratio") ||
        note === "suspiciously-short" ||
        note === "incomplete-response" ||
        note === "no-applied-change" ||
        note === "rejected-by-safety-filter" ||
        note === "document-title-in-applied-notes" ||
        note === "expected-fallback-missing" ||
        note === "unexpected-fallback-used" ||
        note === "expected-heading-not-targeted" ||
        note.startsWith("repeated-existing-lines:")
    );
    const passed = metadata.parseSuccess &&
        failedNotes.length === 0 &&
        missingRequiredConcepts.length === 0 &&
        forbiddenConceptsFound.length === 0 &&
        (expectedOpenQuestionsMissing?.length ?? 0) === 0 &&
        (expectedSectionHintsMissing?.length ?? 0) === 0 &&
        (forms?.expectedFieldMismatchCount ?? 0) === 0 &&
        metadata.status !== "incomplete";

    return {
        fixtureName: evalCase.fixtureName,
        flow: evalCase.flow,
        variantName: evalCase.variantName,
        model: evalCase.variant.model,
        reasoningEffort: evalCase.variant.reasoning,
        passed,
        parseSuccess: metadata.parseSuccess,
        status: metadata.status,
        incompleteReason: metadata.incompleteReason,
        durationMs: metadata.durationMs,
        outputChars: metadata.outputChars,
        compressionRatio: ratio,
        headingCount,
        bulletCount,
        suspiciouslyShort,
        missingRequiredConcepts,
        forbiddenConceptsFound,
        expectedOpenQuestionsMissing,
        expectedSectionHintsMissing,
        forms,
        notesLive,
        usage: metadata.usage,
        notes,
    };
}

function evaluateFormsFinal(
    fixture: FormsFinalEvalFixture,
    actual: Record<string, string>
): OpenAIEvalFormsMetrics {
    let expectedFieldMatchCount = 0;
    let expectedFieldMismatchCount = 0;
    let unknownEmptyCorrectCount = 0;
    let unknownEmptyMismatchCount = 0;
    let notApplicableCorrectCount = 0;
    let notApplicableMismatchCount = 0;
    let inventedValueCount = 0;

    for (const [key, expectedValue] of Object.entries(fixture.expectedFinalAttributes)) {
        const actualValue = actual[key] ?? "";
        if (actualValue === expectedValue) {
            expectedFieldMatchCount++;
        } else {
            expectedFieldMismatchCount++;
        }
    }

    for (const key of fixture.expectedEmptyFields) {
        const actualValue = actual[key] ?? "";
        if (actualValue === "") {
            unknownEmptyCorrectCount++;
        } else {
            unknownEmptyMismatchCount++;
            inventedValueCount++;
        }
    }

    for (const key of fixture.expectedNotApplicableFields) {
        if (actual[key] === "N/A") {
            notApplicableCorrectCount++;
        } else {
            notApplicableMismatchCount++;
        }
    }

    return {
        expectedFieldMatchCount,
        expectedFieldMismatchCount,
        unknownEmptyCorrectCount,
        unknownEmptyMismatchCount,
        notApplicableCorrectCount,
        notApplicableMismatchCount,
        inventedValueCount,
    };
}

function evaluateFormsLive(
    fixture: FormsLiveEvalFixture,
    actual: Record<string, string>
): OpenAIEvalFormsMetrics {
    let expectedFieldMatchCount = 0;
    let expectedFieldMismatchCount = 0;
    let unknownEmptyCorrectCount = 0;
    let unknownEmptyMismatchCount = 0;
    let notApplicableCorrectCount = 0;
    let notApplicableMismatchCount = 0;
    let inventedValueCount = 0;

    for (const [key, expectedValue] of Object.entries(fixture.expectedSparseAttributes)) {
        const actualValue = actual[key] ?? "";
        if (matchesExpectedLiveValue(fixture, key, actualValue, expectedValue)) {
            expectedFieldMatchCount++;
        } else {
            expectedFieldMismatchCount++;
        }
    }

    for (const key of fixture.expectedOmittedFields) {
        const actualValue = actual[key] ?? "";
        if (actualValue === "") {
            unknownEmptyCorrectCount++;
        } else {
            unknownEmptyMismatchCount++;
            inventedValueCount++;
        }
    }

    for (const [key, value] of Object.entries(actual)) {
        if (fixture.forbiddenAttributes.includes(key) && value.trim() !== "") {
            inventedValueCount++;
        }
    }

    for (const [key, expectedValue] of Object.entries(fixture.expectedSparseAttributes)) {
        if (expectedValue === "N/A") {
            if (matchesExpectedLiveValue(fixture, key, actual[key] ?? "", expectedValue)) {
                notApplicableCorrectCount++;
            } else {
                notApplicableMismatchCount++;
            }
        }
    }

    return {
        expectedFieldMatchCount,
        expectedFieldMismatchCount,
        unknownEmptyCorrectCount,
        unknownEmptyMismatchCount,
        notApplicableCorrectCount,
        notApplicableMismatchCount,
        inventedValueCount,
    };
}

function baseResult(
    evalCase: OpenAIEvalCase,
    metadata: {
        parseSuccess: boolean;
        status?: string;
        incompleteReason?: string | null;
        durationMs: number;
        outputChars: number;
        usage?: SafeUsageMetadata;
        notes: string[];
    }
): OpenAIEvalResult {
    return {
        fixtureName: evalCase.fixtureName,
        flow: evalCase.flow,
        variantName: evalCase.variantName,
        model: evalCase.variant.model,
        reasoningEffort: evalCase.variant.reasoning,
        passed: false,
        parseSuccess: metadata.parseSuccess,
        status: metadata.status,
        incompleteReason: metadata.incompleteReason,
        durationMs: metadata.durationMs,
        outputChars: metadata.outputChars,
        missingRequiredConcepts: [],
        forbiddenConceptsFound: [],
        usage: metadata.usage,
        notes: metadata.notes,
    };
}

function findFixtureForFlow(
    flow: SupportedOpenAIEvalFlow,
    fixtureName: string
): OpenAIEvalCase["fixture"] | undefined {
    if (flow === "forms-live-extraction") {
        return formsLiveFixtures.find((fixture) => fixture.name === fixtureName);
    }
    if (flow === "forms-final") {
        return formsFinalFixtures.find((fixture) => fixture.name === fixtureName);
    }
    if (flow === "notes-live-patch") {
        return notesLiveFixtures.find((fixture) => fixture.name === fixtureName);
    }
    if (flow === "notes-final") {
        return notesFinalFixtures.find((fixture) => fixture.name === fixtureName);
    }
    return notesTransformFixtures.find((fixture) =>
        fixture.name === fixtureName && fixture.transform === flow
    );
}

function markdownFromOutput(output: StaticOpenAIEvalOutput): string {
    if ("notesMarkdown" in output) return output.notesMarkdown;
    if ("summaryMarkdown" in output) return output.summaryMarkdown;
    if ("reorganisedMarkdown" in output) return output.reorganisedMarkdown;
    if ("notesLivePatch" in output) return notesLivePatchMarkdown(output.notesLivePatch);
    if ("parsedAttributes" in output) return Object.values(output.parsedAttributes).join("\n");
    if ("liveAttributeUpdates" in output) {
        return Object.values(formsLiveUpdatesToSparseAttributes(output.liveAttributeUpdates)).join("\n");
    }
    return Object.values(output.finalAttributes).join("\n");
}

function staticOutputChars(output: StaticOpenAIEvalOutput): number {
    if ("finalAttributes" in output) return JSON.stringify(output.finalAttributes).length;
    if ("parsedAttributes" in output) return JSON.stringify(output.parsedAttributes).length;
    if ("liveAttributeUpdates" in output) return JSON.stringify(output.liveAttributeUpdates).length;
    return markdownFromOutput(output).length;
}

function stringifyRecord(record: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? value : ""])
    );
}

function sparseNonEmptyRecord(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(record).filter(([, value]) => value.trim() !== "")
    );
}

function parseFormsLiveUpdates(updates: unknown[]): FormsLiveAttributeUpdate[] {
    return updates.flatMap((entry): FormsLiveAttributeUpdate[] => {
        if (!isRecord(entry)) return [];
        const fieldKey = entry.fieldKey;
        const value = entry.value;
        if (typeof fieldKey !== "string" || typeof value !== "string") return [];
        return [{ fieldKey, value }];
    });
}

function formsLiveUpdatesToSparseAttributes(
    updates: FormsLiveAttributeUpdate[]
): Record<string, string> {
    const result: Record<string, string> = {};

    for (const update of updates) {
        const fieldKey = update.fieldKey.trim();
        const value = update.value.trim();
        if (!fieldKey || !value) continue;
        result[fieldKey] = value;
    }

    return result;
}

function matchesExpectedLiveValue(
    fixture: FormsLiveEvalFixture,
    key: string,
    actualValue: string,
    expectedValue: string
): boolean {
    return [
        expectedValue,
        ...(fixture.expectedSparseAttributeAlternatives?.[key] ?? []),
    ].some((value) => actualValue === value);
}

function repeatedExistingLines(existingMarkdown: string, appliedMarkdown: string): string[] {
    const existingCounts = meaningfulLineCounts(existingMarkdown);
    const appliedCounts = meaningfulLineCounts(appliedMarkdown);
    const repeated: string[] = [];

    for (const [line, existingCount] of existingCounts.entries()) {
        const appliedCount = appliedCounts.get(line) ?? 0;
        if (appliedCount > existingCount) repeated.push(line);
    }

    return repeated;
}

function meaningfulLineCounts(markdown: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const line of meaningfulLines(markdown)) {
        const normalized = line.toLowerCase();
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return counts;
}

function addedMarkdownLines(existingMarkdown: string, appliedMarkdown: string): string {
    const existingCounts = lineCounts(existingMarkdown);
    const addedLines: string[] = [];

    for (const line of appliedMarkdown.split(/\r?\n/)) {
        const normalized = normalizeMarkdownLineForDiff(line);
        const existingCount = existingCounts.get(normalized) ?? 0;
        if (normalized && existingCount > 0) {
            existingCounts.set(normalized, existingCount - 1);
            continue;
        }
        addedLines.push(line);
    }

    return addedLines.join("\n");
}

function lineCounts(markdown: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const line of markdown.split(/\r?\n/)) {
        const normalized = normalizeMarkdownLineForDiff(line);
        if (!normalized) continue;
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return counts;
}

function normalizeMarkdownLineForDiff(line: string): string {
    return line.trim().replace(/\s+/g, " ").toLowerCase();
}

function meaningfulLines(markdown: string): string[] {
    return markdown
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^#{1,3}\s+/, ""))
        .filter((line) => line.length >= 24);
}

function notesLivePatchMarkdown(patch: NotesLivePatch): string {
    return [
        ...patch.updates.map((update) => update.appendMarkdown),
        patch.fallbackAppendMarkdown ?? "",
    ].filter((value) => value.trim() !== "").join("\n\n");
}

function formatOptionalNumber(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function writeRawOutputIfEnabled(evalCase: OpenAIEvalCase, outputText: string): void {
    if (!shouldWriteOpenAIEvalOutputs()) return;

    const outputDir = openAIEvalOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const fileName = [
        evalCase.flow,
        evalCase.fixtureName,
        evalCase.variantName,
    ].map(safeFileSegment).join("__");

    writeFileSync(join(outputDir, `${fileName}.txt`), outputText, "utf8");
}

function safeFileSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}
