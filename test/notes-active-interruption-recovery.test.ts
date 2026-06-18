import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesActiveInterruptionRecoveryStore } from "../notes-active-interruption-recovery.js";

const USER_ID = "private-user-123";
const OTHER_USER_ID = "private-user-456";
const RECORDING_SESSION_ID = "recording-session-abc";
const OTHER_RECORDING_SESSION_ID = "recording-session-other";
const CURRENT_NOTES = "## Private notes\n\n- Sensitive current markdown.";
const TRANSCRIPT = "Sensitive accepted transcript text.";

function snapshot() {
    return {
        noteStyle: "meeting",
        sections: ["Summary"],
        currentMarkdown: CURRENT_NOTES,
        transcript: TRANSCRIPT,
        currTranscriptSize: TRANSCRIPT.length,
        pendingNotesTranscript: "Sensitive pending transcript text.",
        passCount: 2,
        sessionStartedAt: 100,
        lastNotesUpdateAt: 200,
        finalisationRecoveryId: "final-recovery-raw-id",
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("notes active interruption recovery store", () => {
    it("saves and claims interrupted state for a matching owner and recording session", () => {
        let now = 1_000;
        const store = new NotesActiveInterruptionRecoveryStore({
            now: () => now,
            ttlMs: 500,
        });

        store.save({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-a",
            snapshot: snapshot(),
            queueSize: 1,
            queuePending: 1,
        });

        now = 1_100;
        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        })).toMatchObject({
            status: "resumed",
            snapshot: {
                currentMarkdown: CURRENT_NOTES,
                transcript: TRANSCRIPT,
                finalisationRecoveryId: "final-recovery-raw-id",
            },
        });
    });

    it("hides interrupted state from mismatched owners and recording sessions", () => {
        const store = new NotesActiveInterruptionRecoveryStore();
        store.save({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-a",
            snapshot: snapshot(),
            queueSize: 0,
            queuePending: 0,
        });

        expect(store.claim({
            userId: OTHER_USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        })).toEqual({ status: "not_found" });

        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: OTHER_RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        })).toEqual({ status: "not_found" });
    });

    it("claims interrupted state only once", () => {
        const store = new NotesActiveInterruptionRecoveryStore();
        store.save({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-a",
            snapshot: snapshot(),
            queueSize: 0,
            queuePending: 0,
        });

        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        }).status).toBe("resumed");

        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-c",
        })).toEqual({ status: "not_found" });
    });

    it("expires interrupted state safely", () => {
        let now = 1_000;
        const store = new NotesActiveInterruptionRecoveryStore({
            now: () => now,
            ttlMs: 100,
        });
        store.save({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-a",
            snapshot: snapshot(),
            queueSize: 0,
            queuePending: 0,
        });

        now = 1_101;

        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        })).toEqual({ status: "expired" });
        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        })).toEqual({ status: "not_found" });
    });

    it("prunes the oldest interrupted state before exceeding max records", () => {
        let now = 1_000;
        const store = new NotesActiveInterruptionRecoveryStore({
            now: () => now,
            maxRecords: 2,
        });

        store.save({
            userId: USER_ID,
            recordingSessionId: "recording-1",
            backendSessionId: "s-active-a",
            snapshot: snapshot(),
            queueSize: 0,
            queuePending: 0,
        });
        now = 1_001;
        store.save({
            userId: USER_ID,
            recordingSessionId: "recording-2",
            backendSessionId: "s-active-b",
            snapshot: snapshot(),
            queueSize: 0,
            queuePending: 0,
        });
        now = 1_002;
        store.save({
            userId: USER_ID,
            recordingSessionId: "recording-3",
            backendSessionId: "s-active-c",
            snapshot: snapshot(),
            queueSize: 0,
            queuePending: 0,
        });

        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: "recording-1",
            backendSessionId: "s-active-claim",
        })).toEqual({ status: "not_found" });
        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: "recording-2",
            backendSessionId: "s-active-claim",
        }).status).toBe("resumed");
        expect(store.claim({
            userId: USER_ID,
            recordingSessionId: "recording-3",
            backendSessionId: "s-active-claim",
        }).status).toBe("resumed");
    });

    it("logs safe metadata without raw notes, transcript, user IDs, or recovery IDs", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const store = new NotesActiveInterruptionRecoveryStore();

        store.save({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-a",
            snapshot: snapshot(),
            queueSize: 1,
            queuePending: 0,
        });
        store.claim({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s-active-b",
        });

        const lines = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(lines).toContain("notes_active_interruption_saved");
        expect(lines).toContain("notes_active_interruption_claimed");
        expect(lines).toContain(`currentNotesChars: ${CURRENT_NOTES.length}`);
        expect(lines).not.toContain("Private notes");
        expect(lines).not.toContain("Sensitive accepted transcript");
        expect(lines).not.toContain(USER_ID);
        expect(lines).not.toContain(RECORDING_SESSION_ID);
        expect(lines).not.toContain("final-recovery-raw-id");
    });
});
