import PQueue from "p-queue";
import type { WebSocket } from "ws";
import {
    TranscriptionHandler,
    StartPayload,
    FormFillState,
    FieldDef,
    makeAudioState,
} from "../types.js";
import { MIN_CHUNK_NUM, MIN_WORD_COUNT, MAX_AUDIO_BUFFER_SIZE } from "../types.js";
import { checkWebMIntegrity, runWhisperOnBuffer, appendWithOverlap } from "../transcription.js";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "../parse-gpt.js";

function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

export class FormFillHandler implements TranscriptionHandler {
    private state: FormFillState;
    private queue: PQueue;

    constructor(private socket: WebSocket) {
        this.state = {
            ...makeAudioState(),
            template: [],
            currAttributes: {},
        };
        this.queue = new PQueue({ concurrency: 4 });
    }

    async onStart(payload: StartPayload): Promise<void> {
        if (payload.mode !== "forms") return;

        this.state.template = [];
        this.state.currAttributes = {};

        for (const blockName of Object.keys(payload.blocks ?? {})) {
            const fields = payload.blocks[blockName];
            if (!Array.isArray(fields)) continue;

            for (const field of fields) {
                const name = String(field);
                this.state.template.push({ block_name: blockName, field_name: name });
                this.state.currAttributes[normalizeKey(name)] = "";
            }
        }

        this.send({ type: "started", mode: "forms" });
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        const state = this.state;

        if (state.audioBuffer.length + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
            console.warn("[FormFill] Audio buffer limit exceeded, dropping chunk");
            this.send({ type: "error", code: "audio-buffer-overflow" });
            return;
        }

        if (!state.webmHeader && checkWebMIntegrity(chunk)) {
            state.webmHeader = chunk;
        }

        state.audioBuffer = Buffer.concat([state.audioBuffer, chunk]);
        state.nchunks++;

        if (state.nchunks < MIN_CHUNK_NUM) return;

        if (!checkWebMIntegrity(state.audioBuffer) && state.webmHeader) {
            state.audioBuffer = Buffer.concat([state.webmHeader, state.audioBuffer]);
        }

        // Snapshot + reset
        const captureBuffer = state.audioBuffer;
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;

        this.queue.add(async () => {
            try {
                const transcription = await runWhisperOnBuffer(captureBuffer);
                const revised = await reviseTranscription(transcription);

                const wordCount = revised.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    console.log(`[FormFill] Too short (${wordCount} words), skipping`);
                    return;
                }

                const prevSize = state.currTranscriptSize;
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, revised);
                const window = state.transcript.slice(-(prevSize + state.currTranscriptSize));

                const extracted = await extractAttributesFromText(window, state.template, state.currAttributes);
                state.currAttributes = { ...state.currAttributes, ...extracted };

                this.send({
                    type: "attributes_update",
                    attributes: state.currAttributes,
                });
            } catch (e) {
                console.error("[FormFill] Processing error:", e);
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        await this.queue.onIdle();

        const state = this.state;
        let remaining = state.audioBuffer;

        if (remaining.length === 0) {
            this.send({
                type: "final_attributes",
                attributes: state.currAttributes,
            });
            return;
        }

        if (!checkWebMIntegrity(remaining) && state.webmHeader) {
            remaining = Buffer.concat([state.webmHeader, remaining]);
        }

        // Clear immediately
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;
        state.webmHeader = null;

        try {
            const raw = await runWhisperOnBuffer(remaining);
            const wordCount = raw.trim().split(/\s+/).length;

            if (wordCount >= MIN_WORD_COUNT) {
                const revised = await reviseTranscription(raw);
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, revised);
            }

            state.currAttributes = await parseFinalAttributes(
                state.transcript,
                state.template,
                state.currAttributes
            );

            console.log(`[FormFill] Final: ${state.transcript.length} chars, ${Object.keys(state.currAttributes).length} fields`);

            this.send({
                type: "final_attributes",
                attributes: state.currAttributes,
            });
        } catch (error) {
            console.error("[FormFill] Final processing error:", error);
            this.send({
                type: "final_attributes",
                attributes: state.currAttributes,
            });
        }
    }

    onClose(): void {
        this.queue.clear();
    }

    private send(msg: object): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    }
}
