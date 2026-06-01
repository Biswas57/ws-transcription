import { describe, it, expect, beforeEach, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    whisperText: "yes",
    resolveWhisper: null as null | ((value: string) => void),
    runWhisperOnBuffer: vi.fn(),
    reviseTranscription: vi.fn(),
    extractAttributesFromText: vi.fn(),
    parseFinalAttributes: vi.fn(),
}));

vi.mock("../transcription.js", () => ({
    checkWebMIntegrity: vi.fn(() => true),
    extractWebMInitSegment: vi.fn((buffer: Buffer) => buffer),
    runWhisperOnBuffer: mockState.runWhisperOnBuffer,
    appendWithOverlap: (base: string, addition: string): [string, number] => [base + addition, addition.length],
}));

vi.mock("../parse-gpt.js", () => ({
    reviseTranscription: mockState.reviseTranscription,
    extractAttributesFromText: mockState.extractAttributesFromText,
    parseFinalAttributes: mockState.parseFinalAttributes,
}));

import { FormFillHandler, isMeaningfulFormTranscript } from "../handlers/FormFillHandler.js";

type MockSocket = {
    OPEN: number;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
};

function makeSocket(): MockSocket {
    return {
        OPEN: 1,
        readyState: 1,
        send: vi.fn(),
    };
}

function messages(socket: MockSocket): Array<{ type?: string; attributes?: Record<string, string>; code?: string }> {
    return socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
}

async function startForms(handler: FormFillHandler): Promise<void> {
    await handler.onStart({
        action: "start",
        mode: "forms",
        token: "test-token",
        blocks: { main: ["answer"] },
    });
}

async function sendChunks(handler: FormFillHandler, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await handler.onAudioChunk(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, i]));
    }
}

beforeEach(() => {
    mockState.whisperText = "yes";
    mockState.resolveWhisper = null;
    mockState.runWhisperOnBuffer.mockReset();
    mockState.reviseTranscription.mockReset();
    mockState.extractAttributesFromText.mockReset();
    mockState.parseFinalAttributes.mockReset();

    mockState.runWhisperOnBuffer.mockImplementation(async () => mockState.whisperText);
    mockState.reviseTranscription.mockImplementation(async (raw: string) => raw);
    mockState.extractAttributesFromText.mockImplementation(async () => ({ answer: mockState.whisperText }));
    mockState.parseFinalAttributes.mockImplementation(async (_transcript: string, _template: unknown, current: Record<string, string>) => current);
});

describe("Forms stabilisation", () => {
    it("treats short form values as meaningful transcript", () => {
        for (const value of ["yes", "no", "John", "Tuesday", "$500", "N/A", "3pm"]) {
            expect(isMeaningfulFormTranscript(value), value).toBe(true);
        }

        expect(isMeaningfulFormTranscript("")).toBe(false);
        expect(isMeaningfulFormTranscript("   ")).toBe(false);
        expect(isMeaningfulFormTranscript("...")).toBe(false);
    });

    it("emits attributes for a one-word Forms transcript", async () => {
        const socket = makeSocket();
        const handler = new FormFillHandler(socket as never, "test-forms-short");
        await startForms(handler);
        socket.send.mockClear();

        await sendChunks(handler, 10);

        await vi.waitFor(() => {
            expect(messages(socket).some((msg) => msg.type === "attributes_update" && msg.attributes?.answer === "yes")).toBe(true);
        });
    });

    it("suppresses in-flight sends after the handler is closed", async () => {
        const socket = makeSocket();
        const handler = new FormFillHandler(socket as never, "test-forms-stale");
        await startForms(handler);
        socket.send.mockClear();

        mockState.runWhisperOnBuffer.mockImplementationOnce(
            () => new Promise<string>((resolve) => {
                mockState.resolveWhisper = resolve;
            })
        );

        await sendChunks(handler, 10);
        await vi.waitFor(() => expect(mockState.runWhisperOnBuffer).toHaveBeenCalledTimes(1));

        handler.onClose();
        mockState.resolveWhisper?.("yes");
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(socket.send).not.toHaveBeenCalled();
    });

    it("makes duplicate Forms stop send one final message", async () => {
        const socket = makeSocket();
        const handler = new FormFillHandler(socket as never, "test-forms-stop");
        await startForms(handler);
        socket.send.mockClear();

        await Promise.all([handler.onStop(), handler.onStop()]);

        const finals = messages(socket).filter((msg) => msg.type === "final_attributes");
        expect(finals).toHaveLength(1);
        expect(mockState.parseFinalAttributes).toHaveBeenCalledTimes(1);
    });

    it("signals overload once instead of accepting unbounded queue work", async () => {
        const socket = makeSocket();
        const handler = new FormFillHandler(socket as never, "test-forms-overload");
        await startForms(handler);
        socket.send.mockClear();

        mockState.runWhisperOnBuffer.mockImplementation(
            () => new Promise<string>((resolve) => {
                mockState.resolveWhisper = resolve;
            })
        );

        await sendChunks(handler, 40);
        await vi.waitFor(() => expect(mockState.runWhisperOnBuffer).toHaveBeenCalledTimes(1));

        await handler.onAudioChunk(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 99]));
        await handler.onAudioChunk(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 100]));

        const overloads = messages(socket).filter((msg) => msg.type === "error" && msg.code === "transcription-overloaded");
        expect(overloads).toHaveLength(1);

        handler.onClose();
        mockState.resolveWhisper?.("yes");
    });
});
