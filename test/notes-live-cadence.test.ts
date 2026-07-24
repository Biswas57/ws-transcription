import { describe, expect, it } from "vitest";
import {
    NOTES_LIVE_CADENCE_PROFILES,
    getNextNotesLiveCadence,
    getNotesLiveTranscriptMetrics,
    hasEnoughNotesLiveTranscript,
    resolveNotesLiveCadenceProfile,
} from "../notes-live-cadence.js";

describe("Notes live cadence configuration", () => {
    it("keeps normal as the default and rejects unknown profiles", () => {
        expect(resolveNotesLiveCadenceProfile(undefined)).toBe("normal");
        expect(resolveNotesLiveCadenceProfile("")).toBe("normal");
        expect(resolveNotesLiveCadenceProfile("normal")).toBe("normal");
        expect(resolveNotesLiveCadenceProfile("showcase")).toBe("showcase");
        expect(() => resolveNotesLiveCadenceProfile("fast")).toThrow(
            "NOTES_LIVE_CADENCE_PROFILE must be either normal or showcase"
        );
    });

    it("preserves the existing normal cadence and defines the showcase cadence", () => {
        expect(NOTES_LIVE_CADENCE_PROFILES.normal).toEqual({
            name: "normal",
            firstAttemptMs: 15_000,
            secondAttemptMs: 15_000,
            earlyAttemptMs: 15_000,
            steadyAttemptMs: 15_000,
            earlyAttemptCount: 4,
            minimumNewTranscriptChars: 80,
            minimumNewTranscriptWords: 0,
            firstTranscriptionBatchChunks: 3,
        });
        expect(NOTES_LIVE_CADENCE_PROFILES.showcase).toEqual({
            name: "showcase",
            firstAttemptMs: 3_500,
            secondAttemptMs: 5_000,
            earlyAttemptMs: 7_000,
            steadyAttemptMs: 10_000,
            earlyAttemptCount: 4,
            minimumNewTranscriptChars: 25,
            minimumNewTranscriptWords: 5,
            firstTranscriptionBatchChunks: 2,
        });
    });

    it("progresses through first, second, early, steady, and long-session stages", () => {
        const profile = NOTES_LIVE_CADENCE_PROFILES.showcase;
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 0,
            elapsedSessionMs: 5_000,
        })).toMatchObject({ stage: "first", delayMs: 3_500 });
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 1,
            elapsedSessionMs: 10_000,
        })).toMatchObject({ stage: "second", delayMs: 5_000 });
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 2,
            elapsedSessionMs: 20_000,
        })).toMatchObject({ stage: "early", delayMs: 7_000 });
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 4,
            elapsedSessionMs: 60_000,
        })).toMatchObject({ stage: "steady", delayMs: 10_000 });
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 1,
            elapsedSessionMs: 3 * 60_000,
        })).toMatchObject({
            stage: "settled",
            delayMs: 30_000,
            minimumNewTranscriptChars: 280,
        });
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 8,
            elapsedSessionMs: 20 * 60_000,
        })).toMatchObject({
            stage: "long",
            delayMs: 60_000,
            minimumNewTranscriptChars: 600,
        });
        expect(getNextNotesLiveCadence({
            profile,
            completedAttemptCount: 12,
            elapsedSessionMs: 40 * 60_000,
        })).toMatchObject({
            stage: "extended",
            delayMs: 120_000,
            minimumNewTranscriptChars: 1200,
        });
    });

    it("requires useful new transcript for showcase attempts", () => {
        const decision = getNextNotesLiveCadence({
            profile: NOTES_LIVE_CADENCE_PROFILES.showcase,
            completedAttemptCount: 0,
            elapsedSessionMs: 4_000,
        });

        expect(hasEnoughNotesLiveTranscript(
            getNotesLiveTranscriptMetrics("Hello everyone, um, okay, thanks."),
            decision
        )).toBe(false);
        expect(hasEnoughNotesLiveTranscript(
            getNotesLiveTranscriptMetrics("Planning a student fitness application with workout tracking."),
            decision
        )).toBe(true);
        expect(hasEnoughNotesLiveTranscript(
            getNotesLiveTranscriptMetrics("Planning fitness app."),
            decision
        )).toBe(false);
    });
});
