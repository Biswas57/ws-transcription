import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.restoreAllMocks();
});

describe("Notes overload recovery support", () => {
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

    it("suppresses late final sends after handler cleanup", async () => {
        const socket = makeSocket();
        const handler = new NotesHandler(socket as never, "test-notes-stale-final");
        await startNotes(handler, "## Current\n\n- Existing note.");
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
    });
});
