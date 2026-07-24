import dotenv from "dotenv";

dotenv.config();

export type NotesLiveCadenceProfileName = "normal" | "showcase";

export type NotesLiveCadenceProfile = {
    name: NotesLiveCadenceProfileName;
    firstAttemptMs: number;
    secondAttemptMs: number;
    earlyAttemptMs: number;
    steadyAttemptMs: number;
    earlyAttemptCount: number;
    minimumNewTranscriptChars: number;
    minimumNewTranscriptWords: number;
    firstTranscriptionBatchChunks: number;
};

export type NotesLiveCadenceStage =
    | "first"
    | "second"
    | "early"
    | "steady"
    | "settled"
    | "long"
    | "extended";

export type NotesLiveCadenceDecision = {
    stage: NotesLiveCadenceStage;
    delayMs: number;
    minimumNewTranscriptChars: number;
    minimumNewTranscriptWords: number;
};

export type NotesLiveTranscriptMetrics = {
    chars: number;
    words: number;
};

export const NOTES_LIVE_CADENCE_PROFILES: Record<
    NotesLiveCadenceProfileName,
    NotesLiveCadenceProfile
> = {
    normal: {
        name: "normal",
        firstAttemptMs: 15_000,
        secondAttemptMs: 15_000,
        earlyAttemptMs: 15_000,
        steadyAttemptMs: 15_000,
        earlyAttemptCount: 4,
        minimumNewTranscriptChars: 80,
        minimumNewTranscriptWords: 0,
        firstTranscriptionBatchChunks: 3,
    },
    showcase: {
        name: "showcase",
        firstAttemptMs: 3_500,
        secondAttemptMs: 5_000,
        earlyAttemptMs: 7_000,
        steadyAttemptMs: 10_000,
        earlyAttemptCount: 4,
        minimumNewTranscriptChars: 25,
        minimumNewTranscriptWords: 5,
        firstTranscriptionBatchChunks: 2,
    },
};

const LONG_SESSION_CADENCE: Array<{
    stage: "settled" | "long" | "extended";
    untilMs: number;
    delayMs: number;
    minimumNewTranscriptChars: number;
}> = [
    {
        stage: "settled",
        untilMs: 10 * 60_000,
        delayMs: 30_000,
        minimumNewTranscriptChars: 280,
    },
    {
        stage: "long",
        untilMs: 30 * 60_000,
        delayMs: 60_000,
        minimumNewTranscriptChars: 600,
    },
    {
        stage: "extended",
        untilMs: Infinity,
        delayMs: 120_000,
        minimumNewTranscriptChars: 1200,
    },
];

const EARLY_SESSION_MS = 2 * 60_000;
const NON_NOTE_WORDS = new Set([
    "ah",
    "hello",
    "hey",
    "hi",
    "hmm",
    "okay",
    "ok",
    "thanks",
    "thank",
    "um",
    "uh",
    "well",
    "yeah",
]);

export function resolveNotesLiveCadenceProfile(
    value = process.env.NOTES_LIVE_CADENCE_PROFILE
): NotesLiveCadenceProfileName {
    if (value === undefined || value.trim() === "" || value === "normal") return "normal";
    if (value === "showcase") return "showcase";
    throw new Error("NOTES_LIVE_CADENCE_PROFILE must be either normal or showcase");
}

export const NOTES_LIVE_CADENCE_PROFILE_NAME = resolveNotesLiveCadenceProfile();
export const NOTES_LIVE_CADENCE_PROFILE =
    NOTES_LIVE_CADENCE_PROFILES[NOTES_LIVE_CADENCE_PROFILE_NAME];

export function getNextNotesLiveCadence(args: {
    profile: NotesLiveCadenceProfile;
    completedAttemptCount: number;
    elapsedSessionMs: number;
}): NotesLiveCadenceDecision {
    const { profile, completedAttemptCount, elapsedSessionMs } = args;

    if (elapsedSessionMs >= EARLY_SESSION_MS) {
        const longSession = LONG_SESSION_CADENCE.find(
            (stage) => elapsedSessionMs < stage.untilMs
        ) ?? LONG_SESSION_CADENCE[LONG_SESSION_CADENCE.length - 1];
        return {
            stage: longSession.stage,
            delayMs: longSession.delayMs,
            minimumNewTranscriptChars: longSession.minimumNewTranscriptChars,
            minimumNewTranscriptWords: 0,
        };
    }

    if (completedAttemptCount === 0) {
        return profileDecision(profile, "first", profile.firstAttemptMs);
    }
    if (completedAttemptCount === 1) {
        return profileDecision(profile, "second", profile.secondAttemptMs);
    }
    if (completedAttemptCount < profile.earlyAttemptCount) {
        return profileDecision(profile, "early", profile.earlyAttemptMs);
    }
    return profileDecision(profile, "steady", profile.steadyAttemptMs);
}

export function getNotesLiveTranscriptMetrics(text: string): NotesLiveTranscriptMetrics {
    const chars = text.trim().length;
    const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [])
        .filter((word) => !NON_NOTE_WORDS.has(word))
        .length;
    return { chars, words };
}

export function hasEnoughNotesLiveTranscript(
    metrics: NotesLiveTranscriptMetrics,
    decision: NotesLiveCadenceDecision
): boolean {
    return metrics.chars >= decision.minimumNewTranscriptChars &&
        metrics.words >= decision.minimumNewTranscriptWords;
}

function profileDecision(
    profile: NotesLiveCadenceProfile,
    stage: "first" | "second" | "early" | "steady",
    delayMs: number
): NotesLiveCadenceDecision {
    return {
        stage,
        delayMs,
        minimumNewTranscriptChars: profile.minimumNewTranscriptChars,
        minimumNewTranscriptWords: profile.minimumNewTranscriptWords,
    };
}
