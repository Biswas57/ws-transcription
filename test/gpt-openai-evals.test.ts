import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
    notesLiveFixtures,
    notesTransformFixtures,
} from "./fixtures/gpt-evals/index.js";
import { liveAttributesResponseSchema } from "../gpt/forms.js";
import { NOTES_LIVE_PATCH_RESPONSE_SCHEMA } from "../gpt/notes-live.js";
import {
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

        expect(cases).toHaveLength(28);
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

        expect(liveCases).toHaveLength(8);
        expect(liveAliasCases).toHaveLength(8);
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

        expect(cases).toHaveLength(6);
        expect(cases.every((evalCase) => evalCase.flow === "summarise")).toBe(true);
    });

    it("keeps live Responses candidate schemas strict and finite", () => {
        const formsSchema = liveAttributesResponseSchema(["full_name", "consent"]);

        expect(formsSchema.schema.additionalProperties).toBe(false);
        expect(formsSchema.schema.properties.parsedAttributes.additionalProperties).toBe(false);
        expect(formsSchema.schema.properties.parsedAttributes.required).toEqual(["full_name", "consent"]);
        expect(NOTES_LIVE_PATCH_RESPONSE_SCHEMA.schema.additionalProperties).toBe(false);
        expect(NOTES_LIVE_PATCH_RESPONSE_SCHEMA.schema.required).toEqual([
            "updates",
            "fallbackAppendMarkdown",
        ]);
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
            parsedAttributes: {
                full_name: "Jordan Lee",
                consent: "yes",
                appointment_fee: "$500",
                appointment_date: "",
            },
        });

        expect(result.passed).toBe(true);
        expect(result.parseSuccess).toBe(true);
        expect(result.forms?.expectedFieldMismatchCount).toBe(0);
        expect(result.forms?.unknownEmptyCorrectCount).toBe(1);
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
