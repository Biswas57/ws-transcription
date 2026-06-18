import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTES_SESSION_MS } from "../types.js";
import {
    clearNotesCapWindowsForTest,
    getNotesCapWindowForTest,
} from "../notes-cap-registry.js";
import { NotesFinalisationRecoveryStore } from "../notes-finalisation-recovery.js";

const LONG_TRANSCRIPT = "alpha beta gamma delta epsilon zeta eta theta iota kappa";

type BatchResult = {
    skipped: false;
    transcript: string;
};

const mockState = vi.hoisted(() => ({
    transcribeAudioBatch: vi.fn(),
    reviseTranscription: vi.fn(),
    generateNotesIncrementalPatch: vi.fn(),
    finalizeNotes: vi.fn(),
}));

vi.mock("../transcription.js", () => ({
    checkWebMIntegrity: vi.fn(() => true),
    extractWebMInitSegment: vi.fn((buffer: Buffer) => buffer),
    transcribeAudioBatch: mockState.transcribeAudioBatch,
    appendWithOverlap: (base: string, addition: string): [string, number] => [
        base + (base.length > 0 ? "\n" : "") + addition,
        addition.length,
    ],
}));

vi.mock("../parse-gpt.js", () => ({
    reviseTranscription: mockState.reviseTranscription,
    generateNotesIncrementalPatch: mockState.generateNotesIncrementalPatch,
    finalizeNotes: mockState.finalizeNotes,
}));

import { NotesHandler } from "../handlers/NotesHandler.js";

type MockSocket = {
    OPEN: number;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
};

function makeSocket(): MockSocket {
    return {
        OPEN: 1,
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(),
    };
}

function messages(socket: MockSocket): Array<{
    type?: string;
    mode?: string;
    code?: string;
    message?: string;
    notesMarkdown?: string;
    finalisationRecoveryId?: string;
}> {
    return socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
}

async function startNotes(handler: NotesHandler, currentNotesMarkdown?: string): Promise<void> {
    await handler.onStart({
        action: "start",
        mode: "notes",
        token: "test-token",
        noteStyle: "meeting",
        sections: ["Summary"],
        continuation: currentNotesMarkdown !== undefined,
        currentNotesMarkdown,
    });
}

async function sendChunks(handler: NotesHandler, count: number, offset = 0): Promise<void> {
    for (let i = 0; i < count; i++) {
        await handler.onAudioChunk(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, (offset + i) & 0xff]));
    }
}

function deferredBatch(): {
    promise: Promise<BatchResult>;
    resolve: (value: BatchResult) => void;
} {
    let resolve!: (value: BatchResult) => void;
    const promise = new Promise<BatchResult>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

beforeEach(() => {
    clearNotesCapWindowsForTest();
    mockState.transcribeAudioBatch.mockReset();
    mockState.reviseTranscription.mockReset();
    mockState.generateNotesIncrementalPatch.mockReset();
    mockState.finalizeNotes.mockReset();

    mockState.transcribeAudioBatch.mockResolvedValue({ skipped: false, transcript: LONG_TRANSCRIPT });
    mockState.reviseTranscription.mockImplementation(async (raw: string) => raw);
    mockState.generateNotesIncrementalPatch.mockResolvedValue({ updates: [] });
    mockState.finalizeNotes.mockImplementation(async (_transcript: string, currentMarkdown: string) => currentMarkdown);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    clearNotesCapWindowsForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("Notes overload recovery support", () => {
    it("includes a finalisation recovery ID for authenticated Notes starts only", async () => {
        const authenticatedSocket = makeSocket();
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "handler-recovery-start",
        });
        const authenticatedHandler = new NotesHandler(
            authenticatedSocket as never,
            "test-notes-recovery-start",
            { userId: "recovery-user", recordingSessionId: "recovery-recording" },
            { finalisationRecoveryStore: store }
        );

        await startNotes(authenticatedHandler);
        expect(messages(authenticatedSocket).find((msg) => msg.type === "started")).toMatchObject({
            type: "started",
            mode: "notes",
            finalisationRecoveryId: "handler-recovery-start",
        });

        const unauthenticatedSocket = makeSocket();
        const unauthenticatedHandler = new NotesHandler(
            unauthenticatedSocket as never,
            "test-notes-recovery-absent"
        );
        await startNotes(unauthenticatedHandler);
        expect(messages(unauthenticatedSocket).find((msg) => msg.type === "started")).toEqual({
            type: "started",
            mode: "notes",
        });
    });

    it("signals overload once, pauses intake, and lets already accepted work continue", async () => {
        const socket = makeSocket();
        const handler = new NotesHandler(socket as never, "test-notes-overload");
        await startNotes(handler);
        socket.send.mockClear();

        const firstBatch = deferredBatch();
        let firstCall = true;
        mockState.transcribeAudioBatch.mockImplementation(() => {
            if (firstCall) {
                firstCall = false;
                return firstBatch.promise;
            }
            return Promise.resolve({ skipped: false, transcript: LONG_TRANSCRIPT });
        });

        await sendChunks(handler, 24);
        await vi.waitFor(() => expect(mockState.transcribeAudioBatch).toHaveBeenCalledTimes(1));

        await handler.onAudioChunk(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 99]));
        await sendChunks(handler, 8, 100);

        const overloads = messages(socket).filter((msg) => msg.type === "error" && msg.code === "transcription-overloaded");
        expect(overloads).toHaveLength(1);
        expect(overloads[0].message).toBe("Recording processing is temporarily overloaded. Please stop and try again.");
        expect(socket.close).not.toHaveBeenCalled();
        expect(mockState.finalizeNotes).not.toHaveBeenCalled();
        expect(mockState.transcribeAudioBatch).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("queueLoad: 6"));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pendingNotesTranscriptChars: 0"));

        firstBatch.resolve({ skipped: false, transcript: LONG_TRANSCRIPT });

        await vi.waitFor(() => expect(mockState.transcribeAudioBatch).toHaveBeenCalledTimes(6));
        expect(mockState.reviseTranscription).toHaveBeenCalledTimes(6);
        expect(mockState.finalizeNotes).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();

        handler.onClose();
    });

    it("seeds large continuation markdown as the full canonical notes", async () => {
        const socket = makeSocket();
        const handler = new NotesHandler(socket as never, "test-notes-continuation");
        const largeMarkdown = [
            "## Existing notes",
            "",
            ...Array.from({ length: 4000 }, (_, index) => `- Existing point ${index}`),
        ].join("\n");
        expect(largeMarkdown.length).toBeGreaterThan(20_000);

        await startNotes(handler, largeMarkdown);

        const started = messages(socket).find((msg) => msg.type === "started");
        expect(started?.mode).toBe("notes");

        await handler.onStop();

        const final = messages(socket).find((msg) => msg.type === "notes_final");
        expect(final?.notesMarkdown).toBe(largeMarkdown);

        handler.onClose();
    });

    it("suppresses late final sends after handler cleanup while storing recoverable success", async () => {
        const socket = makeSocket();
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "handler-recovery-stale",
        });
        const handler = new NotesHandler(
            socket as never,
            "test-notes-stale-final",
            { userId: "recovery-user", recordingSessionId: "recovery-recording" },
            { finalisationRecoveryStore: store }
        );
        await startNotes(handler, "## Current\n\n- Existing note.");
        const recoveryId = messages(socket).find((msg) => msg.type === "started")?.finalisationRecoveryId;
        expect(recoveryId).toBe("handler-recovery-stale");
        socket.send.mockClear();

        let resolveFinal!: (value: string) => void;
        mockState.finalizeNotes.mockImplementationOnce(
            () => new Promise<string>((resolve) => {
                resolveFinal = resolve;
            })
        );

        const stopPromise = handler.onStop();
        await vi.waitFor(() => expect(mockState.finalizeNotes).toHaveBeenCalledTimes(1));

        handler.onClose();
        resolveFinal("## Final\n\n- Late final note.");
        await stopPromise;

        expect(socket.send).not.toHaveBeenCalled();
        expect(store.getForOwner({
            recoveryId: recoveryId ?? "",
            userId: "recovery-user",
            recordingSessionId: "recovery-recording",
        })).toMatchObject({
            status: "succeeded",
            notesMarkdown: "## Final\n\n- Late final note.",
        });
    });

    it("stores fallback final notes as recoverable success when finalisation throws", async () => {
        const socket = makeSocket();
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "handler-recovery-fallback",
        });
        const handler = new NotesHandler(
            socket as never,
            "test-notes-recovery-fallback",
            { userId: "recovery-user" },
            { finalisationRecoveryStore: store }
        );
        const currentNotes = "## Current\n\n- Fallback note.";
        await startNotes(handler, currentNotes);
        const recoveryId = messages(socket).find((msg) => msg.type === "started")?.finalisationRecoveryId;
        mockState.finalizeNotes.mockRejectedValueOnce(Object.assign(new Error("raw provider details"), {
            code: "provider_error",
        }));

        await handler.onStop();

        const final = messages(socket).find((msg) => msg.type === "notes_final");
        expect(final?.notesMarkdown).toBe(currentNotes);
        expect(store.getForOwner({
            recoveryId: recoveryId ?? "",
            userId: "recovery-user",
        })).toMatchObject({
            status: "succeeded",
            notesMarkdown: currentNotes,
        });
    });

    it("does not duplicate the finalisation recovery lifecycle on duplicate stop", async () => {
        const socket = makeSocket();
        const store = new NotesFinalisationRecoveryStore({
            createRecoveryId: () => "handler-recovery-duplicate-stop",
        });
        const markPendingSpy = vi.spyOn(store, "markPending");
        const handler = new NotesHandler(
            socket as never,
            "test-notes-recovery-duplicate-stop",
            { userId: "recovery-user" },
            { finalisationRecoveryStore: store }
        );
        await startNotes(handler, "## Current\n\n- Existing note.");

        await Promise.all([handler.onStop(), handler.onStop()]);

        expect(markPendingSpy).toHaveBeenCalledTimes(1);
    });
});

describe("Notes cap continuity handler behaviour", () => {
    it("finalises through the existing session-cap path when reconnect starts after the logical deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const userId = "notes-cap-user";
        const recordingSessionId = "notes-recording-session";
        const currentMarkdown = "## Existing\n\n- Preserved note.";

        const firstSocket = makeSocket();
        const firstHandler = new NotesHandler(firstSocket as never, "test-notes-cap-a", {
            userId,
            recordingSessionId,
        });
        await startNotes(firstHandler);

        vi.setSystemTime(MAX_NOTES_SESSION_MS - 30_000);
        firstHandler.onClose();
        expect(getNotesCapWindowForTest(userId, recordingSessionId)?.state).toBe("reconnectable");

        vi.setSystemTime(MAX_NOTES_SESSION_MS + 1);
        const reconnectSocket = makeSocket();
        const reconnectHandler = new NotesHandler(reconnectSocket as never, "test-notes-cap-b", {
            userId,
            recordingSessionId,
        });

        await startNotes(reconnectHandler, currentMarkdown);
        await vi.runOnlyPendingTimersAsync();

        const sent = messages(reconnectSocket);
        expect(sent[0]).toMatchObject({ type: "started", mode: "notes" });
        expect(sent[0].finalisationRecoveryId).toEqual(expect.any(String));
        const final = sent.find((msg) => msg.type === "notes_final");
        expect(final?.notesMarkdown).toBe(currentMarkdown);
        expect(mockState.finalizeNotes).toHaveBeenCalledWith("", currentMarkdown, "meeting", ["Summary"]);
        expect(getNotesCapWindowForTest(userId, recordingSessionId)).toBeNull();

        reconnectHandler.onClose();
    });
});
