import { describe, expect, it } from "vitest";
import {
    allGptEvalFixtures,
    formsFinalFixtures,
    formsLiveFixtures,
    longSessionFixtures,
    notesFinalFixtures,
    notesLiveFixtures,
    notesTransformFixtures,
    type FormsFinalEvalFixture,
    type FormsLiveEvalFixture,
    type EvalConcept,
    type GptEvalFixture,
    type LongSessionEvalFixture,
    type NotesFinalEvalFixture,
    type NotesLiveEvalFixture,
    type NotesTransformEvalFixture,
} from "./fixtures/gpt-evals/index.js";
import { gptReasoningExperiments } from "./fixtures/gpt-evals/reasoning-experiments.js";
import {
    compressionRatio,
    containsAllConcepts,
    containsForbiddenConcepts,
    countMarkdownBullets,
    countMarkdownHeadings,
    extractOpenQuestions,
    normaliseForConceptMatch,
} from "./gpt-quality-eval-helpers.js";

describe("GPT quality eval fixtures", () => {
    it("loads the planned fixture groups", () => {
        expect(notesFinalFixtures.map((fixture) => fixture.name)).toEqual([
            "rca-process-final",
            "short-study-final",
            "notes-final-preserve-current-only-detail",
            "notes-final-correction-overrides-current",
            "notes-final-deduplicate-current-and-transcript",
            "notes-final-drop-live-artefact",
        ]);
        expect(formsFinalFixtures.map((fixture) => fixture.name)).toEqual([
            "medical-intake-basic",
            "correction-overwrite",
            "unknown-empty-contract",
            "value-normalisation-and-correction",
        ]);
        expect(formsLiveFixtures.map((fixture) => fixture.name)).toEqual([
            "forms-live-basic-short",
            "forms-live-correction-fragment",
            "forms-live-sparse-unknowns",
            "forms-live-correction-normalisation",
            "forms-live-explicit-na",
            "forms-live-noisy-fragment",
        ]);
        expect(notesTransformFixtures.map((fixture) => fixture.name)).toEqual([
            "summarise-rca-process",
            "summarise-long-meeting-actions",
            "summarise-study-repeated-detail",
            "summarise-process-heavy-incident-review",
            "reorganise-rca-process",
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
        expect(longSessionFixtures.map((fixture) => fixture.name)).toEqual([
            "long-session-steady-meeting",
            "long-session-topic-shifts",
            "long-session-repetition-heavy",
            "long-session-correction-late",
        ]);
        expect(allGptEvalFixtures).toHaveLength(36);
    });

    it("uses unique fixture names", () => {
        const names = allGptEvalFixtures.map((fixture) => fixture.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it("has required fixture fields", () => {
        for (const fixture of allGptEvalFixtures) {
            expect(fixture.name.trim()).not.toBe("");
            assertNoUnsafeFixtureText(fixture);

            if (fixture.kind === "notes-final") assertNotesFinalFixture(fixture);
            if (fixture.kind === "forms-final") assertFormsFinalFixture(fixture);
            if (fixture.kind === "forms-live") assertFormsLiveFixture(fixture);
            if (fixture.kind === "notes-transform") assertNotesTransformFixture(fixture);
            if (fixture.kind === "notes-live") assertNotesLiveFixture(fixture);
            if (fixture.kind === "long-session") assertLongSessionFixture(fixture);
        }
    });

    it("runs deterministic helper checks on sample markdown", () => {
        const markdown = [
            "# Session Notes",
            "",
            "## Decisions",
            "",
            "- Keep the release checklist.",
            "- Assign QA sign off.",
            "",
            "### Details",
            "",
            "* Support handover remains open.",
            "",
            "## Open Questions / Verify",
            "",
            "- Confirm rollout window.",
            "- Verify support owner.",
        ].join("\n");

        expect(normaliseForConceptMatch("QA-sign off & support")).toBe("qa sign off and support");
        expect(containsAllConcepts(markdown, ["release checklist", "support owner"])).toEqual([]);
        expect(containsAllConcepts(markdown, ["missing concept"])).toEqual(["missing concept"]);
        expect(containsAllConcepts(markdown, [["support owner", "handover owner"]])).toEqual([]);
        expect(containsAllConcepts(markdown, [["missing one", "missing two"]])).toEqual(["missing one"]);
        expect(containsForbiddenConcepts(markdown, ["release checklist", "not present"])).toEqual([
            "release checklist",
        ]);
        expect(compressionRatio("1234567890", "12345")).toBe(0.5);
        expect(compressionRatio("", "")).toBe(0);
        expect(compressionRatio("", "nonempty")).toBe(Number.POSITIVE_INFINITY);
        expect(countMarkdownHeadings(markdown)).toBe(4);
        expect(countMarkdownBullets(markdown)).toBe(5);
        expect(extractOpenQuestions(markdown)).toEqual([
            "Confirm rollout window.",
            "Verify support owner.",
        ]);
    });

    it("keeps Summarise fixture expectations coherent", () => {
        const summariseFixtures = notesTransformFixtures.filter(
            (fixture) => fixture.transform === "summarise"
        );
        expect(summariseFixtures).toHaveLength(4);

        for (const fixture of summariseFixtures) {
            expect(fixture.maxCompressionRatio).toBeGreaterThan(0);
            expect(fixture.maxCompressionRatio).toBeLessThan(1);
            expect(fixture.requiredConcepts.length).toBeGreaterThan(0);
            expect(fixture.forbiddenConcepts.every((concept) => typeof concept === "string")).toBe(true);
        }
    });

    it("keeps Forms final expectations aligned to declared fields", () => {
        for (const fixture of formsFinalFixtures) {
            const fieldKeys = new Set(fixture.fields.map((field) => field.key));
            for (const key of Object.keys(fixture.expectedFinalAttributes)) {
                expect(fieldKeys.has(key)).toBe(true);
            }
            for (const key of fixture.expectedEmptyFields) {
                expect(fieldKeys.has(key)).toBe(true);
                expect(fixture.expectedFinalAttributes[key]).toBe("");
            }
            for (const key of fixture.expectedNotApplicableFields) {
                expect(fieldKeys.has(key)).toBe(true);
                expect(fixture.expectedFinalAttributes[key]).toBe("N/A");
            }
        }
    });

    it("keeps sample good outputs as light checker examples", () => {
        const fixturesWithSamples = allGptEvalFixtures.filter(hasSampleGoodOutput);

        expect(fixturesWithSamples.map((fixture) => fixture.name)).toEqual([
            "notes-final-preserve-current-only-detail",
            "notes-final-correction-overrides-current",
            "notes-final-deduplicate-current-and-transcript",
            "notes-final-drop-live-artefact",
            "summarise-rca-process",
            "reorganise-rca-process",
            "early-patch-basic",
            "notes-live-fallback-section",
        ]);

        for (const fixture of fixturesWithSamples) {
            const sample = fixture.sampleGoodOutput ?? "";
            const requiredConcepts = getRequiredConcepts(fixture);
            const forbiddenConcepts = getForbiddenConcepts(fixture);

            expect(containsAllConcepts(sample, requiredConcepts)).toEqual([]);
            expect(containsForbiddenConcepts(sample, forbiddenConcepts)).toEqual([]);

            if ("expectedOpenQuestions" in fixture && fixture.expectedOpenQuestions) {
                const openQuestions = extractOpenQuestions(sample).join("\n");
                expect(containsAllConcepts(openQuestions, fixture.expectedOpenQuestions)).toEqual([]);
            }

            if (fixture.kind === "notes-transform" && fixture.transform === "summarise") {
                expect(compressionRatio(fixture.currentVisibleNotes, sample)).toBeLessThanOrEqual(
                    fixture.maxCompressionRatio ?? 1
                );
            }
        }
    });

    it("keeps reasoning experiment plan descriptive and tied to known fixtures", () => {
        const experimentNames = gptReasoningExperiments.map((experiment) => experiment.name);
        expect(new Set(experimentNames).size).toBe(experimentNames.length);

        const knownFlows = new Set([
            "revision",
            "forms-live-extraction",
            "notes-live-patch",
            "forms-final",
            "notes-final",
            "summarise",
            "reorganise",
        ]);
        const fixtureNames = new Set(allGptEvalFixtures.map((fixture) => fixture.name));
        const plannedFlows = new Set(gptReasoningExperiments.map((experiment) => experiment.flow));

        expect(plannedFlows).toEqual(knownFlows);

        for (const experiment of gptReasoningExperiments) {
            expect(knownFlows.has(experiment.flow)).toBe(true);
            expect(experiment.linkedFixtures.length).toBeGreaterThan(0);
            for (const fixtureName of experiment.linkedFixtures) {
                expect(fixtureNames.has(fixtureName)).toBe(true);
            }

            expect(experiment.metrics.length).toBeGreaterThan(0);
            expect(experiment.qualityRisks.length).toBeGreaterThan(0);

            for (const variant of experiment.variants) {
                expect(variant.name.trim()).not.toBe("");
                expect(variant.notes.trim()).not.toBe("");
                if (variant.role === "candidate") {
                    expect(variant.productionDefault).toBe(false);
                }
            }
        }
    });
});

function assertNotesFinalFixture(fixture: NotesFinalEvalFixture): void {
    expect(fixture.noteStyle.trim()).not.toBe("");
    expect(fixture.transcript.trim()).not.toBe("");
    expect(fixture.currentNotes.trim()).not.toBe("");
    expect(fixture.requiredConcepts.length).toBeGreaterThan(0);
    expect(fixture.forbiddenConcepts.length).toBeGreaterThan(0);
}

function assertFormsFinalFixture(fixture: FormsFinalEvalFixture): void {
    expect(fixture.transcript.trim()).not.toBe("");
    expect(fixture.fields.length).toBeGreaterThan(0);
    expect(Object.keys(fixture.expectedFinalAttributes).length).toBeGreaterThan(0);
    for (const field of fixture.fields) {
        expect(field.key.trim()).not.toBe("");
        expect(field.label.trim()).not.toBe("");
    }
}

function assertFormsLiveFixture(fixture: FormsLiveEvalFixture): void {
    expect(fixture.transcriptSegment.trim()).not.toBe("");
    expect(fixture.fields.length).toBeGreaterThan(0);
    expect(Object.keys(fixture.expectedSparseAttributes).length).toBeGreaterThan(0);
    for (const field of fixture.fields) {
        expect(field.key.trim()).not.toBe("");
        expect(field.label.trim()).not.toBe("");
    }
    const fieldKeys = new Set(fixture.fields.map((field) => field.key));
    for (const key of Object.keys(fixture.expectedSparseAttributes)) {
        expect(fieldKeys.has(key)).toBe(true);
    }
    for (const key of fixture.expectedOmittedFields) {
        expect(fieldKeys.has(key)).toBe(true);
    }
}

function assertNotesTransformFixture(fixture: NotesTransformEvalFixture): void {
    expect(fixture.noteStyle.trim()).not.toBe("");
    expect(fixture.currentVisibleNotes.trim()).not.toBe("");
    expect(fixture.requiredConcepts.length).toBeGreaterThan(0);
    expect(fixture.forbiddenConcepts.length).toBeGreaterThan(0);
}

function assertNotesLiveFixture(fixture: NotesLiveEvalFixture): void {
    expect(fixture.noteStyle.trim()).not.toBe("");
    expect(fixture.pendingTranscript.trim()).not.toBe("");
    expect(fixture.requiredPatchConcepts.length).toBeGreaterThan(0);
    expect(fixture.forbiddenPatchConcepts.length).toBeGreaterThan(0);
    expect(fixture.expectedSafetyBehaviour.length).toBeGreaterThan(0);
}

function assertLongSessionFixture(fixture: LongSessionEvalFixture): void {
    expect(fixture.noteStyle.trim()).not.toBe("");
    expect(fixture.description.trim()).not.toBe("");
    expect(fixture.initialCurrentNotes.trim()).not.toBe("");
    expect(fixture.steps.length).toBeGreaterThan(0);
    expect(fixture.expectedGrowthRisk.length).toBeGreaterThan(0);

    for (const step of fixture.steps) {
        expect(step.elapsedMs).toBeGreaterThan(0);
        expect(step.pendingTranscript.trim()).not.toBe("");
        expect(step.sampleAppendMarkdown.trim()).not.toBe("");
    }
}

function getRequiredConcepts(fixture: GptEvalFixture): EvalConcept[] {
    if (fixture.kind === "notes-live") return fixture.requiredPatchConcepts;
    if (fixture.kind === "forms-live") return fixture.requiredConcepts ?? [];
    if (fixture.kind === "forms-final") return fixture.requiredConcepts ?? [];
    if (fixture.kind === "long-session") return [];
    return fixture.requiredConcepts;
}

function getForbiddenConcepts(fixture: GptEvalFixture): string[] {
    if (fixture.kind === "notes-live") return fixture.forbiddenPatchConcepts;
    if (fixture.kind === "forms-live") return fixture.forbiddenConcepts ?? [];
    if (fixture.kind === "forms-final") return fixture.forbiddenConcepts ?? [];
    if (fixture.kind === "long-session") return [];
    return fixture.forbiddenConcepts;
}

function hasSampleGoodOutput(fixture: GptEvalFixture): fixture is GptEvalFixture & { sampleGoodOutput: string } {
    return "sampleGoodOutput" in fixture &&
        typeof fixture.sampleGoodOutput === "string" &&
        fixture.sampleGoodOutput.length > 0;
}

function assertNoUnsafeFixtureText(fixture: GptEvalFixture): void {
    const text = collectStrings(fixture).join("\n");
    const unsafePatterns: Array<[RegExp, string]> = [
        [/\bsk-[a-z0-9_-]{8,}\b/i, "OpenAI-style API key"],
        [/\bOPENAI_API_KEY\b/i, "OpenAI env var"],
        [/\bBearer\s+\S+/i, "Bearer credential"],
        [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "email address"],
        [/\b(?:\+?\d[\s().-]*){8,}\b/, "phone-like number"],
        [/\bpassword\b/i, "password"],
        [/\bsecret\b/i, "secret"],
        [/\b(?:api_token|auth_token|access_token|refresh_token)\s*[:=]/i, "secret-like token"],
        [/\btoken\s*:/i, "token field"],
        [/https?:\/\/[^\s]*(?:internal|private|corp|localhost|127\.0\.0\.1)[^\s]*/i, "private URL"],
        [/\b(?:case|account)[-_ ]?(?:id|number)\s*[:=]\s*[a-z0-9-]+/i, "case/account identifier"],
    ];

    for (const [pattern, label] of unsafePatterns) {
        expect(text, `${fixture.name} contains ${label}`).not.toMatch(pattern);
    }
}

function collectStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collectStrings);
    if (value && typeof value === "object") {
        return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
    }
    return [];
}
