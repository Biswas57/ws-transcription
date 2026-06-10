import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
    formsLiveFixtures,
    notesLiveFixtures,
    notesTransformFixtures,
} from "./fixtures/gpt-evals/index.js";
import { liveAttributesResponseSchema } from "../gpt/forms.js";
import { NOTES_LIVE_PATCH_RESPONSE_SCHEMA } from "../gpt/notes-live.js";
import {
    buildOpenAIEvalRequest,
    evaluateStaticOpenAIEvalOutput,
    formatOpenAIEvalResults,
    openAIEvalOutputDir,
    runOpenAIEvalCase,
    selectOpenAIEvalCases,
    selectedOpenAIEvalFlows,
    shouldSkipOpenAIEvals,
    shouldWriteOpenAIEvalOutputs,
    supportedOpenAIEvalFlows,
} from "./gpt-openai-eval-runner.js";

describe("OpenAI GPT eval runner", () => {
    it("keeps OpenAI-backed evals explicitly opt-in", () => {
        expect(shouldSkipOpenAIEvals({})).toBe("OPENAI_EVALS is not set to 1");
        expect(shouldSkipOpenAIEvals({ OPENAI_EVALS: "0" })).toBe("OPENAI_EVALS is not set to 1");
        expect(shouldSkipOpenAIEvals({ OPENAI_EVALS: "1" })).toBe("OPENAI_API_KEY is not set");
        expect(shouldSkipOpenAIEvals({
            OPENAI_EVALS: "1",
            OPENAI_API_KEY: "sk-test",
        })).toBeNull();
    });

    it("keeps raw eval output writing disabled unless explicitly enabled", () => {
        expect(shouldWriteOpenAIEvalOutputs({})).toBe(false);
        expect(shouldWriteOpenAIEvalOutputs({ OPENAI_EVALS_WRITE_OUTPUTS: "0" })).toBe(false);
        expect(shouldWriteOpenAIEvalOutputs({ OPENAI_EVALS_WRITE_OUTPUTS: "1" })).toBe(true);
        expect(openAIEvalOutputDir({})).toBe("/tmp/formify-gpt-eval-outputs");
        expect(openAIEvalOutputDir({ OPENAI_EVALS_OUTPUT_DIR: "/tmp/custom-evals" })).toBe("/tmp/custom-evals");
    });

    it("selects live Chat baselines and Responses strict-schema candidates", () => {
        const cases = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined });

        expect(cases).toHaveLength(64);
        expect(new Set(cases.map((evalCase) => evalCase.flow))).toEqual(
            new Set(supportedOpenAIEvalFlows)
        );
        expect(cases.every((evalCase) =>
            evalCase.variant.productionDefault ||
            (
                evalCase.variant.api === "responses" &&
                evalCase.variant.outputMode === "json_schema" &&
                evalCase.variant.reasoning === "low"
            )
        )).toBe(true);

        const formsLiveVariants = cases
            .filter((evalCase) => evalCase.flow === "forms-live-extraction")
            .map((evalCase) => evalCase.variant.name);
        const notesLiveVariants = cases
            .filter((evalCase) => evalCase.flow === "notes-live-patch")
            .map((evalCase) => evalCase.variant.name);

        expect(new Set(formsLiveVariants)).toEqual(new Set([
            "current-chat-mini-low",
            "candidate-responses-mini-low",
        ]));
        expect(new Set(notesLiveVariants)).toEqual(new Set([
            "current-chat-mini-low",
            "candidate-responses-mini-low",
        ]));
    });

    it("filters opt-in eval cases by live flow aliases", () => {
        const liveCases = selectOpenAIEvalCases({
            OPENAI_EVAL_FLOWS: "forms-live,notes-live",
        });
        const liveAliasCases = selectOpenAIEvalCases({
            OPENAI_EVAL_FLOWS: "live",
        });
        const unknownCases = selectOpenAIEvalCases({
            OPENAI_EVAL_FLOWS: "not-a-flow",
        });

        expect(liveCases).toHaveLength(34);
        expect(liveAliasCases).toHaveLength(34);
        expect(unknownCases).toHaveLength(0);
        expect(selectedOpenAIEvalFlows({ OPENAI_EVAL_FLOWS: "forms-live,notes-live" })).toEqual(
            new Set(["forms-live-extraction", "notes-live-patch"])
        );
        expect(new Set(liveCases.map((evalCase) => evalCase.flow))).toEqual(
            new Set(["forms-live-extraction", "notes-live-patch"])
        );
    });

    it("filters opt-in eval cases by exact flow name", () => {
        const cases = selectOpenAIEvalCases({
            OPENAI_EVAL_FLOWS: "summarise",
        });

        const summariseFixtureCount = notesTransformFixtures.filter((fixture) =>
            fixture.transform === "summarise"
        ).length;

        expect(cases).toHaveLength(summariseFixtureCount * 2);
        expect(cases.every((evalCase) => evalCase.flow === "summarise")).toBe(true);
    });

    it("keeps live Responses candidate schemas strict and finite", () => {
        const formsSchema = liveAttributesResponseSchema(["full_name", "consent"]);

        expect(formsSchema.schema.additionalProperties).toBe(false);
        expect(formsSchema.schema.required).toEqual(["updates"]);
        expect(formsSchema.schema.properties.updates.type).toBe("array");
        expect(formsSchema.schema.properties.updates.items.additionalProperties).toBe(false);
        expect(formsSchema.schema.properties.updates.items.required).toEqual(["fieldKey", "value"]);
        expect(formsSchema.schema.properties.updates.items.properties.fieldKey.enum).toEqual([
            "full_name",
            "consent",
        ]);
        expect(NOTES_LIVE_PATCH_RESPONSE_SCHEMA.schema.additionalProperties).toBe(false);
        expect(NOTES_LIVE_PATCH_RESPONSE_SCHEMA.schema.required).toEqual([
            "updates",
            "fallbackAppendMarkdown",
        ]);
    });

    it("builds Notes live eval input through the runtime bounded-context request builder", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: "notes-live" }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "notes-live-long-current-notes" &&
            item.variant.name === "candidate-responses-mini-low"
        );
        const fixture = notesLiveFixtures.find((item) => item.name === "notes-live-long-current-notes");

        expect(evalCase).toBeDefined();
        expect(fixture).toBeDefined();
        expect(fixture!.currentNotes.length).toBeGreaterThan(6000);

        const request = buildOpenAIEvalRequest(evalCase!);
        const input = JSON.parse(request.input) as {
            current_notes: string;
            transcript_segment: string;
        };

        expect(input.current_notes).toContain("Compact current notes context for live patching");
        expect(input.current_notes).toContain("## Existing note outline");
        expect(input.current_notes).toContain("## Recent note tail");
        expect(input.current_notes.length).toBeLessThan(fixture!.currentNotes.length);
        expect(input.current_notes).not.toBe(fixture!.currentNotes);
        expect(input.transcript_segment).toBe(fixture!.pendingTranscript);
        expect(request.metadata).toMatchObject({
            currentNotesChars: fixture!.currentNotes.length,
            contextCompacted: true,
        });
        expect(request.metadata?.currentNotesContextChars).toBeLessThan(fixture!.currentNotes.length);
        expect(request.metadata?.contextSavedChars).toBeGreaterThan(0);
        expect(request.metadata?.headingCount).toBeGreaterThan(0);
    });

    it("keeps short Notes live eval input un-compacted through the same runtime builder", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: "notes-live" }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "early-patch-basic" &&
            item.variant.name === "candidate-responses-mini-low"
        );

        expect(evalCase).toBeDefined();
        const request = buildOpenAIEvalRequest(evalCase!);
        const input = JSON.parse(request.input) as { current_notes: string };

        expect(input.current_notes).toBe("");
        expect(request.metadata).toMatchObject({
            currentNotesChars: 0,
            currentNotesContextChars: 0,
            contextSavedChars: 0,
            contextCompacted: false,
            headingCount: 0,
        });
    });

    it("formats Notes live context metadata without raw notes, headings, or transcript", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: "notes-live" }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "notes-live-long-current-notes" &&
            item.variant.name === "candidate-responses-mini-low"
        );

        expect(evalCase).toBeDefined();
        const request = buildOpenAIEvalRequest(evalCase!);
        const table = formatOpenAIEvalResults([{
            fixtureName: evalCase!.fixtureName,
            flow: evalCase!.flow,
            variantName: evalCase!.variantName,
            model: evalCase!.variant.model,
            reasoningEffort: evalCase!.variant.reasoning,
            passed: true,
            parseSuccess: true,
            durationMs: 0,
            outputChars: 0,
            missingRequiredConcepts: [],
            forbiddenConceptsFound: [],
            notes: request.summaryNotes ?? [],
        }]);

        expect(table).toContain("contextCompacted=true");
        expect(table).toContain("currentNotesChars=");
        expect(table).toContain("currentNotesContextChars=");
        expect(table).toContain("contextSavedChars=");
        expect(table).toContain("headingCount=");
        expect(table).not.toContain("Incident overview");
        expect(table).not.toContain("Payment retry failures");
        expect(table).not.toContain("retry failure screenshots");
    });

    it("evaluates static Forms final outputs without an API call", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "forms-final" &&
            item.fixtureName === "medical-intake-basic" &&
            item.variant.productionDefault
        );

        expect(evalCase).toBeDefined();
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            finalAttributes: {
                firstName: "Alex",
                appointmentDay: "Tuesday",
                fee: "$500",
                preferredTime: "3pm",
                allergies: "N/A",
                email: "",
            },
        });

        expect(result.passed).toBe(true);
        expect(result.parseSuccess).toBe(true);
        expect(result.forms?.expectedFieldMismatchCount).toBe(0);
        expect(result.forms?.unknownEmptyCorrectCount).toBe(1);
        expect(result.forms?.notApplicableCorrectCount).toBe(1);
    });

    it("evaluates static Forms live outputs without an API call", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "forms-live-extraction" &&
            item.fixtureName === "forms-live-basic-short" &&
            item.variant.name === "candidate-responses-mini-low"
        );

        expect(evalCase).toBeDefined();
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            liveAttributeUpdates: [
                { fieldKey: "appointment_fee", value: "$400" },
                { fieldKey: "full_name", value: "Jordan Lee" },
                { fieldKey: "appointment_date", value: "" },
                { fieldKey: "consent", value: "yes" },
                { fieldKey: "appointment_fee", value: "$500" },
            ],
        });

        expect(result.passed).toBe(true);
        expect(result.parseSuccess).toBe(true);
        expect(result.forms?.expectedFieldMismatchCount).toBe(0);
        expect(result.forms?.unknownEmptyCorrectCount).toBe(1);
    });

    it("keeps unknown and unmentioned Forms live fields out of sparse scoring", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "forms-live-extraction" &&
            item.fixtureName === "forms-live-sparse-unknowns" &&
            item.variant.name === "candidate-responses-mini-low"
        );

        expect(evalCase).toBeDefined();
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            liveAttributeUpdates: [
                { fieldKey: "client_name", value: "Morgan Patel" },
                { fieldKey: "review_reason", value: "tenancy support review" },
            ],
        });

        expect(result.passed).toBe(true);
        expect(result.forms?.expectedFieldMismatchCount).toBe(0);
        expect(result.forms?.unknownEmptyCorrectCount).toBe(4);
        expect(result.forms?.inventedValueCount).toBe(0);
    });

    it("evaluates static Notes live patch outputs after safety filters", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "early-patch-basic" &&
            item.variant.name === "candidate-responses-mini-low"
        );
        const fixture = notesLiveFixtures.find((item) => item.name === "early-patch-basic");

        expect(evalCase).toBeDefined();
        expect(fixture?.sampleGoodOutput).toBeDefined();
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            notesLivePatch: {
                updates: [],
                fallbackAppendMarkdown: fixture!.sampleGoodOutput!,
            },
        });

        expect(result.passed).toBe(true);
        expect(result.parseSuccess).toBe(true);
        expect(result.notesLive?.fallbackUsed).toBe(true);
        expect(result.notesLive?.appliedChanged).toBe(true);
    });

    it("evaluates structured Notes fallback sections through the patch applier", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "notes-live-fallback-section" &&
            item.variant.name === "candidate-responses-mini-low"
        );
        const fixture = notesLiveFixtures.find((item) => item.name === "notes-live-fallback-section");

        expect(evalCase).toBeDefined();
        expect(fixture?.sampleGoodOutput).toBeDefined();
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            notesLivePatch: {
                updates: [],
                fallbackAppendMarkdown: fixture!.sampleGoodOutput!,
            },
        });

        expect(result.passed).toBe(true);
        expect(result.notesLive?.fallbackUsed).toBe(true);
        expect(result.headingCount).toBeGreaterThan(1);
    });

    it("fails Notes live static outputs that repeat existing bullets or miss expected heading reuse", () => {
        const repeatedCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "notes-live-unsafe-or-repeated" &&
            item.variant.name === "candidate-responses-mini-low"
        );
        const headingCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "notes-live-heading-reuse" &&
            item.variant.name === "candidate-responses-mini-low"
        );

        expect(repeatedCase).toBeDefined();
        const repeatedResult = evaluateStaticOpenAIEvalOutput(repeatedCase!, {
            notesLivePatch: {
                updates: [{
                    targetHeading: "Communications",
                    appendMarkdown: "- Do not publish customer communications before legal review.\n- Mei is the approval owner.",
                }],
            },
        });
        expect(repeatedResult.passed).toBe(false);
        expect(repeatedResult.notes.some((note) => note.startsWith("repeated-existing-lines:"))).toBe(true);

        expect(headingCase).toBeDefined();
        const headingResult = evaluateStaticOpenAIEvalOutput(headingCase!, {
            notesLivePatch: {
                updates: [],
                fallbackAppendMarkdown: "- Mei to send the legal review request by Wednesday.",
            },
        });
        expect(headingResult.passed).toBe(false);
        expect(headingResult.notes).toContain("expected-heading-not-targeted");
    });

    it("allows Notes live outputs that mention rejected title wording as a warning", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "notes-live-patch" &&
            item.fixtureName === "notes-live-unsafe-or-repeated" &&
            item.variant.name === "candidate-responses-mini-low"
        );

        expect(evalCase).toBeDefined();
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            notesLivePatch: {
                updates: [{
                    targetHeading: "Communications",
                    appendMarkdown: "- Approval owner is Mei.\n- \"Title: Emergency Runbook\" should not be used as a document title.",
                }],
                fallbackAppendMarkdown: "",
            },
        });

        expect(result.passed).toBe(true);
        expect(result.forbiddenConceptsFound).toEqual([]);
    });

    it("evaluates static Summarise outputs with deterministic quality checks", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "summarise" &&
            item.fixtureName === "summarise-rca-process" &&
            item.variant.productionDefault
        );
        const fixture = notesTransformFixtures.find((item) => item.name === "summarise-rca-process");

        expect(evalCase).toBeDefined();
        expect(fixture?.sampleGoodOutput).toBeDefined();

        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            summaryMarkdown: fixture!.sampleGoodOutput!,
        });

        expect(result.passed).toBe(true);
        expect(result.parseSuccess).toBe(true);
        expect(result.missingRequiredConcepts).toEqual([]);
        expect(result.forbiddenConceptsFound).toEqual([]);
        expect(result.expectedOpenQuestionsMissing).toEqual([]);
        expect(result.compressionRatio).toBeLessThanOrEqual(fixture!.maxCompressionRatio ?? 1);
    });

    it("formats safe summary results without raw model output", () => {
        const evalCase = selectOpenAIEvalCases({ OPENAI_EVAL_FLOWS: undefined }).find((item) =>
            item.flow === "summarise" && item.variant.productionDefault
        );
        const fixture = notesTransformFixtures.find((item) => item.name === "summarise-rca-process");
        const result = evaluateStaticOpenAIEvalOutput(evalCase!, {
            summaryMarkdown: fixture!.sampleGoodOutput!,
        });
        const table = formatOpenAIEvalResults([result]);

        expect(table).toContain("summarise");
        expect(table).toContain("summarise-rca-process");
        expect(table).toContain("current-final-medium");
        expect(table).not.toContain("RCA triage and scope");
        expect(table).not.toContain("Legal reviews the final RCA document");
    });

    it("keeps the T-085b report explicit about offline execution", () => {
        const report = readFileSync(
            new URL("./fixtures/gpt-evals/T-085b-reasoning-model-results.md", import.meta.url),
            "utf8"
        );

        expect(report).toContain("Status: completed after providing Node with the local macOS certificate bundle.");
        expect(report).toContain("No production defaults were changed by T-085b.");
        expect(report).toContain("OPENAI_EVALS=1 pnpm exec vitest run test/gpt-openai-evals.test.ts");
        expect(report).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
        expect(report).toContain("forms-final | correction-overwrite | candidate-final-low | yes");
        expect(report).not.toContain("raw model output");
    });

    it("keeps expanded live fixture coverage in the eval matrix", () => {
        expect(formsLiveFixtures.map((fixture) => fixture.name)).toEqual([
            "forms-live-basic-short",
            "forms-live-correction-fragment",
            "forms-live-sparse-unknowns",
            "forms-live-correction-normalisation",
            "forms-live-explicit-na",
            "forms-live-noisy-fragment",
        ]);
        expect(notesLiveFixtures.map((fixture) => fixture.name)).toEqual([
            "early-patch-basic",
            "side-topic-repetition",
            "notes-live-long-current-notes",
            "notes-live-heading-reuse",
            "notes-live-fallback-section",
            "notes-live-unsafe-or-repeated",
            "notes-live-side-topic-main-topic-balance",
            "notes-live-long-meeting-rolling-context",
            "notes-live-lecture-topic-shift",
            "notes-live-repeated-correction",
            "notes-live-tangent-with-action",
        ]);
    });
});

const openAISkipReason = shouldSkipOpenAIEvals();
const openAIDescribe = openAISkipReason ? describe.skip : describe;

openAIDescribe("OpenAI-backed GPT evals", () => {
    it("runs selected eval cases when explicitly enabled", async () => {
        const evalCases = selectOpenAIEvalCases();
        const results = [];
        for (const evalCase of evalCases) {
            results.push(await runOpenAIEvalCase(evalCase));
        }

        console.log(formatOpenAIEvalResults(results));

        expect(results).toHaveLength(evalCases.length);
        for (const result of results) {
            expect(result.fixtureName.trim()).not.toBe("");
            expect(result.flow.trim()).not.toBe("");
            expect(result.variantName.trim()).not.toBe("");
            expect(result.model.trim()).not.toBe("");
            expect(typeof result.passed).toBe("boolean");
            expect(typeof result.parseSuccess).toBe("boolean");
            expect(result.outputChars).toBeGreaterThanOrEqual(0);
        }
    }, 900_000);
});
