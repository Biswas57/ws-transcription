import { describe, expect, it, vi } from "vitest";
import { longSessionFixtures } from "./fixtures/gpt-evals/index.js";
import { estimateLongSessionLivePatchGrowth } from "./long-session-cost-estimator.js";

describe("long-session cost estimator", () => {
    it("estimates live patch growth for all synthetic long-session fixtures", () => {
        expect(longSessionFixtures).toHaveLength(4);

        for (const fixture of longSessionFixtures) {
            const estimate = estimateLongSessionLivePatchGrowth(fixture);

            expect(estimate.fixtureName).toBe(fixture.name);
            expect(estimate.stepCount).toBe(fixture.steps.length);
            expect(estimate.livePatchCalls).toBe(fixture.steps.length);
            expect(estimate.currentNotesStartChars).toBe(fixture.initialCurrentNotes.length);
            expect(estimate.currentNotesEndChars).toBeGreaterThan(estimate.currentNotesStartChars);
            expect(estimate.maxCurrentNotesChars).toBe(estimate.currentNotesEndChars);
            expect(estimate.cumulativeUnboundedInputChars).toBeGreaterThan(estimate.cumulativeOutputChars);
            expect(estimate.cumulativeBoundedInputChars).toBeLessThanOrEqual(
                estimate.cumulativeUnboundedInputChars
            );
            expect(estimate.cumulativeSavedInputChars).toBe(
                estimate.cumulativeUnboundedInputChars - estimate.cumulativeBoundedInputChars
            );
            expect(estimate.cumulativeUnboundedEstimatedInputTokens).toBe(
                estimate.steps.reduce((sum, step) => sum + step.unboundedEstimatedInputTokens, 0)
            );
            expect(estimate.cumulativeBoundedEstimatedInputTokens).toBe(
                estimate.steps.reduce((sum, step) => sum + step.boundedEstimatedInputTokens, 0)
            );

            for (const step of estimate.steps) {
                expect(step.unboundedInputChars).toBeGreaterThan(step.pendingTranscriptChars);
                expect(step.boundedInputChars).toBeGreaterThan(step.pendingTranscriptChars);
                expect(step.boundedInputChars).toBeLessThanOrEqual(step.unboundedInputChars);
                expect(step.savedInputChars).toBe(step.unboundedInputChars - step.boundedInputChars);
                expect(step.currentNotesCharsAfter).toBeGreaterThan(step.currentNotesCharsBefore);
                expect(step.unboundedEstimatedInputTokens).toBe(Math.ceil(step.unboundedInputChars / 4));
                expect(step.boundedEstimatedInputTokens).toBe(Math.ceil(step.boundedInputChars / 4));
            }
        }
    });

    it("shows cumulative input pressure grows with canonical notes", () => {
        const estimate = estimateLongSessionLivePatchGrowth(longSessionFixtures[0]);
        const firstStep = estimate.steps[0];
        const lastStep = estimate.steps[estimate.steps.length - 1];

        expect(lastStep.currentNotesCharsBefore).toBeGreaterThan(firstStep.currentNotesCharsBefore);
        expect(lastStep.unboundedInputChars).toBeGreaterThan(firstStep.unboundedInputChars);
    });

    it("shows bounded live context savings once fixtures exceed the compaction threshold", () => {
        const estimates = longSessionFixtures.map((fixture) => estimateLongSessionLivePatchGrowth(fixture));

        for (const estimate of estimates) {
            expect(estimate.firstCompactedStep).not.toBeNull();
            expect(estimate.cumulativeSavedInputChars).toBeGreaterThan(0);
            expect(estimate.cumulativeSavedEstimatedInputTokens).toBeGreaterThan(0);

            const compactedSteps = estimate.steps.filter((step) => step.contextCompacted);
            expect(compactedSteps.length).toBeGreaterThan(0);
            for (const step of compactedSteps) {
                expect(step.currentNotesContextChars).toBeLessThan(step.currentNotesCharsBefore);
                expect(step.contextSavedChars).toBeGreaterThan(0);
                expect(step.headingCount).toBeGreaterThan(0);
            }
        }
    });

    it("does not call providers while estimating", () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        try {
            estimateLongSessionLivePatchGrowth(longSessionFixtures[0]);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
