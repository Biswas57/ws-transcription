import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    NotesFinalisationRecoveryStore,
} from "../notes-finalisation-recovery.js";
import {
    createNotesFinalisationRecoveryRequestHandler,
} from "../notes-finalisation-recovery-routes.js";

const TEST_SECRET = "notes-finalisation-recovery-secret";
const USER_ID = "user-private-123";
const OTHER_USER_ID = "other-user-private-456";
const RECORDING_SESSION_ID = "recording-session-abc";
const FINAL_NOTES = "## Private final notes\n\n- Sensitive recovered markdown.";

type RouteResult = { status: number; body: unknown };

async function postJson(
    handler: ReturnType<typeof createNotesFinalisationRecoveryRequestHandler>,
    path: string,
    body: unknown,
    authHeader: string | null = `Bearer ${TEST_SECRET}`
): Promise<RouteResult> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    if (authHeader !== null) headers.authorization = authHeader;

    const req = Readable.from([
        Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    ]) as IncomingMessage;
    req.method = "POST";
    req.url = path;
    req.headers = headers;

    let status = 0;
    let rawBody = "";
    const resDouble = {
        headersSent: false,
        writeHead(code: number) {
            status = code;
            resDouble.headersSent = true;
            return resDouble;
        },
        end(chunk?: unknown) {
            rawBody += chunk ? String(chunk) : "";
            return resDouble;
        },
    };
    const res = resDouble as unknown as ServerResponse;

    await handler(req, res);
    return {
        status,
        body: JSON.parse(rawBody),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("notes finalisation recovery store", () => {
    it("recovers succeeded final notes for the matching owner and session", () => {
        let now = 1_000;
        const store = new NotesFinalisationRecoveryStore({
            now: () => now,
            createRecoveryId: () => "recovery-success",
            ttlMs: 500,
            pendingTtlMs: 5_000,
        });

        const reserved = store.reserve({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
        });
        expect(reserved.status).toBe("pending");

        store.markPending(reserved.recoveryId, { stopReason: "client" });
        now = 1_200;
        store.succeed(reserved.recoveryId, FINAL_NOTES, { outputChars: FINAL_NOTES.length });

        expect(store.getForOwner({
            recoveryId: reserved.recoveryId,
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
        })).toMatchObject({
            status: "succeeded",
            notesMarkdown: FINAL_NOTES,
            completedAt: 1_200,
            expiresAt: 1_700,
        });
    });

    it("hides records from mismatched owners and recording sessions", () => {
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "recovery-owner-guard",
        });
        const reserved = store.reserve({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
        });
        store.succeed(reserved.recoveryId, FINAL_NOTES);

        expect(store.getForOwner({
            recoveryId: reserved.recoveryId,
            userId: OTHER_USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
        })).toEqual({ status: "not_found" });

        expect(store.getForOwner({
            recoveryId: reserved.recoveryId,
            userId: USER_ID,
            recordingSessionId: "wrong-recording-session",
        })).toEqual({ status: "not_found" });
    });

    it("returns failed status with a safe error code", () => {
        let now = 1_000;
        const store = new NotesFinalisationRecoveryStore({
            now: () => now,
            createRecoveryId: () => "recovery-failed",
            ttlMs: 500,
        });

        const reserved = store.reserve({ userId: USER_ID });
        now = 1_250;
        store.fail(reserved.recoveryId, "finalisation-provider-error");

        expect(store.getForOwner({
            recoveryId: reserved.recoveryId,
            userId: USER_ID,
        })).toMatchObject({
            status: "failed",
            errorCode: "finalisation-provider-error",
            completedAt: 1_250,
            expiresAt: 1_750,
        });
    });

    it("expires records safely without returning recovered notes", () => {
        let now = 1_000;
        const store = new NotesFinalisationRecoveryStore({
            now: () => now,
            createRecoveryId: () => "recovery-expired",
            ttlMs: 100,
        });

        const reserved = store.reserve({ userId: USER_ID });
        store.succeed(reserved.recoveryId, FINAL_NOTES);
        now = 1_101;

        expect(store.getForOwner({
            recoveryId: reserved.recoveryId,
            userId: USER_ID,
        })).toEqual({ status: "expired" });
    });

    it("prunes terminal records before enforcing max stored records", () => {
        let id = 0;
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => `recovery-${++id}`,
            maxRecords: 2,
        });

        const first = store.reserve({ userId: USER_ID });
        store.succeed(first.recoveryId, FINAL_NOTES);
        store.reserve({ userId: USER_ID });

        const third = store.reserve({ userId: USER_ID });

        expect(third.recoveryId).toBe("recovery-3");
        expect(store.getForTest(first.recoveryId)).toBeNull();
    });

    it("logs safe metadata without raw notes, user IDs, or recovery IDs", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "recovery-raw-id",
        });

        const reserved = store.reserve({
            userId: USER_ID,
            recordingSessionId: RECORDING_SESSION_ID,
            metadata: {
                rawNotes: "## Private notes should not appear",
                safeStatus: "reserved",
            },
        });
        store.markPending(reserved.recoveryId, {
            rawFinal: "## More private notes",
            stopReason: "client",
        });
        store.succeed(reserved.recoveryId, FINAL_NOTES, { outputChars: FINAL_NOTES.length });

        const lines = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(lines).toContain("notes_final_recovery_reserved");
        expect(lines).toContain("notes_final_recovery_pending");
        expect(lines).toContain("notes_final_recovery_succeeded");
        expect(lines).toContain("safeStatus: reserved");
        expect(lines).toContain(`outputChars: ${FINAL_NOTES.length}`);
        expect(lines).not.toContain("Private notes");
        expect(lines).not.toContain("Sensitive recovered markdown");
        expect(lines).not.toContain(USER_ID);
        expect(lines).not.toContain(RECORDING_SESSION_ID);
        expect(lines).not.toContain("recovery-raw-id");
    });
});

describe("notes finalisation recovery route", () => {
    it("returns pending, succeeded, failed, expired, and not_found statuses", async () => {
        let now = 1_000;
        let id = 0;
        const store = new NotesFinalisationRecoveryStore({
            now: () => now,
            createRecoveryId: () => `route-recovery-${++id}`,
            ttlMs: 100,
        });
        const handler = createNotesFinalisationRecoveryRequestHandler({
            getSecret: () => TEST_SECRET,
            store,
        });

        const pending = store.reserve({ userId: USER_ID });
        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: pending.recoveryId,
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 200,
            body: { status: "pending" },
        });

        const succeeded = store.reserve({ userId: USER_ID });
        store.succeed(succeeded.recoveryId, FINAL_NOTES);
        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: succeeded.recoveryId,
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 200,
            body: { status: "succeeded", notesMarkdown: FINAL_NOTES },
        });

        const failed = store.reserve({ userId: USER_ID });
        store.fail(failed.recoveryId, "finalisation-provider-error");
        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: failed.recoveryId,
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 200,
            body: { status: "failed", errorCode: "finalisation-provider-error" },
        });

        now = 1_101;
        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: succeeded.recoveryId,
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 200,
            body: { status: "expired" },
        });

        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: "missing-recovery",
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 200,
            body: { status: "not_found" },
        });
    });

    it("fails closed for missing and invalid auth", async () => {
        const store = new NotesFinalisationRecoveryStore();
        const handler = createNotesFinalisationRecoveryRequestHandler({
            getSecret: () => TEST_SECRET,
            store,
        });

        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: "recovery-id",
            userId: USER_ID,
        }, null)).resolves.toMatchObject({
            status: 401,
            body: { error: { code: "unauthorised" } },
        });

        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: "recovery-id",
            userId: USER_ID,
        }, "Bearer wrong-secret")).resolves.toMatchObject({
            status: 401,
            body: { error: { code: "unauthorised" } },
        });

        const unavailable = createNotesFinalisationRecoveryRequestHandler({
            getSecret: () => "",
            store,
        });
        await expect(postJson(unavailable, "/notes/finalisation-recovery", {
            recoveryId: "recovery-id",
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 503,
            body: { error: { code: "finalisation-recovery-service-unavailable" } },
        });
    });

    it("rejects invalid request bodies safely", async () => {
        const handler = createNotesFinalisationRecoveryRequestHandler({
            getSecret: () => TEST_SECRET,
            store: new NotesFinalisationRecoveryStore(),
        });

        await expect(postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: "",
            userId: USER_ID,
        })).resolves.toMatchObject({
            status: 400,
            body: { error: { code: "invalid-request" } },
        });

        await expect(postJson(handler, "/notes/finalisation-recovery", "not-json")).resolves.toMatchObject({
            status: 400,
            body: { error: { code: "invalid-request" } },
        });
    });

    it("does not log recovered markdown from route polling", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "route-log-recovery",
        });
        const handler = createNotesFinalisationRecoveryRequestHandler({
            getSecret: () => TEST_SECRET,
            store,
        });
        const reserved = store.reserve({ userId: USER_ID });
        store.succeed(reserved.recoveryId, FINAL_NOTES);

        await postJson(handler, "/notes/finalisation-recovery", {
            recoveryId: reserved.recoveryId,
            userId: USER_ID,
        });

        const lines = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(lines).toContain("notes_final_recovery_polled");
        expect(lines).not.toContain("Sensitive recovered markdown");
        expect(lines).not.toContain(FINAL_NOTES);
    });
});
