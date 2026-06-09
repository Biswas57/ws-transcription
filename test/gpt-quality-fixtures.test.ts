import { describe, expect, it } from "vitest";
import {
    allGptEvalFixtures,
    formsFinalFixtures,
    notesFinalFixtures,
    notesLiveFixtures,
    notesTransformFixtures,
    type FormsFinalEvalFixture,
    type GptEvalFixture,
    type NotesFinalEvalFixture,
    type NotesLiveEvalFixture,
    type NotesTransformEvalFixture,
} from "./fixtures/gpt-evals/index.js";
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
        ]);
        expect(formsFinalFixtures.map((fixture) => fixture.name)).toEqual([
            "medical-intake-basic",
            "correction-overwrite",
        ]);
        expect(notesTransformFixtures.map((fixture) => fixture.name)).toEqual([
            "summarise-rca-process",
            "reorganise-rca-process",
        ]);
        expect(notesLiveFixtures.map((fixture) => fixture.name)).toEqual([
            "early-patch-basic",
            "side-topic-repetition",
        ]);
        expect(allGptEvalFixtures).toHaveLength(8);
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
            if (fixture.kind === "notes-transform") assertNotesTransformFixture(fixture);
            if (fixture.kind === "notes-live") assertNotesLiveFixture(fixture);
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
        expect(summariseFixtures).toHaveLength(1);

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
            "summarise-rca-process",
            "reorganise-rca-process",
            "early-patch-basic",
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

function getRequiredConcepts(fixture: GptEvalFixture): string[] {
    if (fixture.kind === "notes-live") return fixture.requiredPatchConcepts;
    if (fixture.kind === "forms-final") return fixture.requiredConcepts ?? [];
    return fixture.requiredConcepts;
}

function getForbiddenConcepts(fixture: GptEvalFixture): string[] {
    if (fixture.kind === "notes-live") return fixture.forbiddenPatchConcepts;
    if (fixture.kind === "forms-final") return fixture.forbiddenConcepts ?? [];
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
