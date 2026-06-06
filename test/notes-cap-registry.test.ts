import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTES_SESSION_MS } from "../types.js";
import { mintWSToken, verifyWSToken } from "../ws-token.js";
import {
    clearNotesCapWindowsForTest,
    closeNotesCapWindowForTest,
    getNotesCapWindowForTest,
    markNotesCapWindowReconnectableForTest,
    NOTES_RECONNECT_CAP_GRACE_MS,
    resolveNotesCapWindow,
} from "../notes-cap-registry.js";

const USER_ID = "cap-window-user";
const RECORDING_SESSION_ID = "recording-session-123";
const ORIGINAL_WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET;

beforeEach(() => {
    clearNotesCapWindowsForTest();
    process.env.WS_TOKEN_SECRET = "notes-cap-registry-test-secret";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    clearNotesCapWindowsForTest();
    if (ORIGINAL_WS_TOKEN_SECRET === undefined) {
        delete process.env.WS_TOKEN_SECRET;
    } else {
        process.env.WS_TOKEN_SECRET = ORIGINAL_WS_TOKEN_SECRET;
    }
    vi.restoreAllMocks();
});

describe("Notes cap registry", () => {
    it("round trips recordingSessionId through the signed WS token payload", () => {
        const token = mintWSToken(USER_ID, "notes", RECORDING_SESSION_ID);
        const payload = verifyWSToken(token);

        expect(payload.userId).toBe(USER_ID);
        expect(payload.mode).toBe("notes");
        expect(payload.recordingSessionId).toBe(RECORDING_SESSION_ID);
    });

    it("creates a first logical cap window for a signed recording session", () => {
        const lease = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 10_000,
        });

        expect(lease?.capWindowReused).toBe(false);
        expect(lease?.reason).toBe("no-existing-window");
        expect(lease?.capStartedAtMs).toBe(10_000);
        expect(lease?.capDeadlineMs).toBe(10_000 + MAX_NOTES_SESSION_MS);

        const snapshot = getNotesCapWindowForTest(USER_ID, RECORDING_SESSION_ID);
        expect(snapshot?.state).toBe("active");
        expect(snapshot?.lastBackendSessionId).toBe("s0001");
    });

    it("reuses the original cap deadline for a quick reconnect within grace", () => {
        const first = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 0,
        });
        expect(first).not.toBeNull();

        markNotesCapWindowReconnectableForTest(USER_ID, RECORDING_SESSION_ID, "s0001", 5_000);

        const reconnect = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0002",
            continuationRequested: true,
            nowMs: 10_000,
        });

        expect(reconnect?.capWindowReused).toBe(true);
        expect(reconnect?.expiredOnStart).toBe(false);
        expect(reconnect?.reason).toBe("reused-reconnectable");
        expect(reconnect?.capStartedAtMs).toBe(first?.capStartedAtMs);
        expect(reconnect?.capDeadlineMs).toBe(first?.capDeadlineMs);

        const snapshot = getNotesCapWindowForTest(USER_ID, RECORDING_SESSION_ID);
        expect(snapshot?.state).toBe("active");
        expect(snapshot?.lastBackendSessionId).toBe("s0002");
    });

    it("creates a fresh cap window when reconnect misses the grace window", () => {
        const first = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 0,
        });
        expect(first).not.toBeNull();

        markNotesCapWindowReconnectableForTest(USER_ID, RECORDING_SESSION_ID, "s0001", 5_000);

        const afterGrace = 5_000 + NOTES_RECONNECT_CAP_GRACE_MS + 1;
        const reconnect = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0002",
            continuationRequested: true,
            nowMs: afterGrace,
        });

        expect(reconnect?.capWindowReused).toBe(false);
        expect(reconnect?.capStartedAtMs).toBe(afterGrace);
        expect(reconnect?.capDeadlineMs).toBe(afterGrace + MAX_NOTES_SESSION_MS);
    });

    it("reuses an active cap window for duplicate socket replacement after initial grace", () => {
        const first = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 0,
        });
        expect(first).not.toBeNull();

        const replacement = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0002",
            continuationRequested: true,
            nowMs: 10 * 60_000,
        });

        expect(replacement?.capWindowReused).toBe(true);
        expect(replacement?.reason).toBe("reused-active");
        expect(replacement?.capDeadlineMs).toBe(first?.capDeadlineMs);
    });

    it("reuses an expired logical window so the handler can finalise through the session cap path", () => {
        const first = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 0,
        });
        expect(first).not.toBeNull();

        markNotesCapWindowReconnectableForTest(
            USER_ID,
            RECORDING_SESSION_ID,
            "s0001",
            MAX_NOTES_SESSION_MS - 30_000
        );

        const reconnect = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0002",
            continuationRequested: true,
            nowMs: MAX_NOTES_SESSION_MS + 1,
        });

        expect(reconnect?.capWindowReused).toBe(true);
        expect(reconnect?.expiredOnStart).toBe(true);
        expect(reconnect?.reason).toBe("expired");
        expect(reconnect?.capDeadlineMs).toBe(first?.capDeadlineMs);
    });

    it("closes and deletes a cap window after finalisation", () => {
        resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 0,
        });

        closeNotesCapWindowForTest(USER_ID, RECORDING_SESSION_ID, "s0001");

        expect(getNotesCapWindowForTest(USER_ID, RECORDING_SESSION_ID)).toBeNull();
    });

    it("ignores stale close attempts from an older backend session", () => {
        resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0001",
            continuationRequested: false,
            nowMs: 0,
        });
        markNotesCapWindowReconnectableForTest(USER_ID, RECORDING_SESSION_ID, "s0001", 1_000);

        resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0002",
            continuationRequested: true,
            nowMs: 2_000,
        });

        closeNotesCapWindowForTest(USER_ID, RECORDING_SESSION_ID, "s0001");

        const snapshot = getNotesCapWindowForTest(USER_ID, RECORDING_SESSION_ID);
        expect(snapshot?.state).toBe("active");
        expect(snapshot?.lastBackendSessionId).toBe("s0002");
    });

    it("falls back safely when no registry entry exists after a backend restart", () => {
        const reconnect = resolveNotesCapWindow({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            backendSessionId: "s0002",
            continuationRequested: true,
            nowMs: 50_000,
        });

        expect(reconnect?.capWindowReused).toBe(false);
        expect(reconnect?.reason).toBe("no-existing-window");
        expect(reconnect?.capStartedAtMs).toBe(50_000);
    });
});
