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
import {
    checkWebMIntegrity,
    extractWebMInitSegment,
    runWhisperOnBuffer,
    appendWithOverlap,
} from "../transcription.js";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "../parse-gpt.js";

function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

export class FormFillHandler implements TranscriptionHandler {
    private st: FormFillState;
    private queue: PQueue;
    private passCount = 0;
    private sessionStartedAt = 0;

    constructor(private socket: WebSocket, private sessionId: string) {
        this.st = {
            ...makeAudioState(),
            template: [],
            currAttributes: {},
        };
        // Session transcript/attribute state is mutated sequentially; do not
        // parallelise without sequence guards around pass ordering.
        this.queue = new PQueue({ concurrency: 1 });
    }

    async onStart(payload: StartPayload): Promise<void> {
        if (payload.mode !== "forms") return;

        this.st.template = [];
        this.st.currAttributes = {};
        this.passCount = 0;
        this.sessionStartedAt = Date.now();

        for (const blockName of Object.keys(payload.blocks ?? {})) {
            const fields = payload.blocks[blockName];
            if (!Array.isArray(fields)) continue;
            for (const field of fields) {
                const name = String(field);
                this.st.template.push({ block_name: blockName, field_name: name });
                this.st.currAttributes[normalizeKey(name)] = "";
            }
        }

        console.log(`[${this.sessionId}][forms] Session start — ${this.st.template.length} fields across ${Object.keys(payload.blocks ?? {}).length} blocks`);
        this.send({ type: "started", mode: "forms" });
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        const st = this.st;

        if (st.audioBuffer.length + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
            console.warn(`[${this.sessionId}][forms] Audio buffer overflow — dropping chunk`);
            this.send({ type: "error", code: "audio-buffer-overflow" });
            return;
        }

        if (!st.webmHeader && checkWebMIntegrity(chunk)) {
            st.webmHeader = extractWebMInitSegment(chunk);
        }

        st.audioBuffer = Buffer.concat([st.audioBuffer, chunk]);
        st.nchunks++;

        if (st.nchunks < MIN_CHUNK_NUM) return;

        if (!checkWebMIntegrity(st.audioBuffer) && st.webmHeader) {
            st.audioBuffer = Buffer.concat([st.webmHeader, st.audioBuffer]);
        }

        const captureBuffer = st.audioBuffer;
        const captureSize = captureBuffer.length;
        const captureChunkCount = st.nchunks;
        st.audioBuffer = Buffer.alloc(0);
        st.nchunks = 0;
        const passNum = ++this.passCount;
        const queueSizeAtEnqueue = this.queue.size;
        const queuePendingAtEnqueue = this.queue.pending;

        this.queue.add(async () => {
            const passStart = Date.now();
            console.log(
                `[${this.sessionId}][forms] Pass ${passNum} start — ` +
                `queueSize: ${queueSizeAtEnqueue}, queuePending: ${queuePendingAtEnqueue}, ` +
                `bufferBytes: ${captureSize}, chunkCount: ${captureChunkCount}`
            );

            try {
                // Stage 1: Whisper
                const t0 = Date.now();
                const transcription = await runWhisperOnBuffer(captureBuffer);
                const whisperMs = Date.now() - t0;
                const rawChars = transcription.length;
                console.log(
                    `[${this.sessionId}][forms] Pass ${passNum} — ` +
                    `whisper: ${whisperMs}ms, rawChars: ${rawChars}`
                );

                // Stage 2: Revision
                const t1 = Date.now();
                const revised = await reviseTranscription(transcription);
                const reviseMs = Date.now() - t1;
                const revisedChars = revised.length;
                console.log(
                    `[${this.sessionId}][forms] Pass ${passNum} — ` +
                    `revise: ${reviseMs}ms, revisedChars: ${revisedChars}`
                );

                const wordCount = revised.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    const passMs = Date.now() - passStart;
                    console.log(
                        `[${this.sessionId}][forms] Pass ${passNum} skipped — ` +
                        `tooShort: ${wordCount} words, passMs: ${passMs}`
                    );
                    return;
                }

                const prevSize = st.currTranscriptSize;
                [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);
                const window = st.transcript.slice(-(prevSize + st.currTranscriptSize));

                // Stage 3: Attribute extraction
                const t2 = Date.now();
                const extracted = await extractAttributesFromText(window, st.template, st.currAttributes);
                st.currAttributes = { ...st.currAttributes, ...extracted };
                const extractMs = Date.now() - t2;
                const passMs = Date.now() - passStart;
                const attrsReturned = Object.keys(extracted).length;

                console.log(
                    `[${this.sessionId}][forms] Pass ${passNum} complete — ` +
                    `extract: ${extractMs}ms, attrsReturned: ${attrsReturned}, passMs: ${passMs}`
                );

                this.send({ type: "attributes_update", attributes: st.currAttributes });

            } catch (e) {
                console.error(
                    `[${this.sessionId}][forms] Pass ${passNum} failed — ` +
                    `passMs: ${Date.now() - passStart}ms:`,
                    e
                );
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        const stopStart = Date.now();
        const st = this.st;
        const queueSizeAtStop = this.queue.size;
        const queuePendingAtStop = this.queue.pending;
        console.log(
            `[${this.sessionId}][forms] Stop received — ` +
            `queueSize: ${queueSizeAtStop}, queuePending: ${queuePendingAtStop}`
        );

        const drainStart = Date.now();
        await this.queue.onIdle();
        const drainMs = Date.now() - drainStart;
        console.log(`[${this.sessionId}][forms] Queue drained — ${drainMs}ms`);

        let remaining = st.audioBuffer;

        if (remaining.length === 0) {
            console.log(`[${this.sessionId}][forms] No remaining audio — running final extraction`);
            await this.runFinalExtraction(stopStart);
            return;
        }

        if (!checkWebMIntegrity(remaining) && st.webmHeader) {
            remaining = Buffer.concat([st.webmHeader, remaining]);
        }
        st.audioBuffer = Buffer.alloc(0);
        st.nchunks = 0;
        st.webmHeader = null;

        console.log(
            `[${this.sessionId}][forms] Remaining audio — bytes: ${remaining.length}`
        );

        try {
            const t0 = Date.now();
            const raw = await runWhisperOnBuffer(remaining);
            const remainingWhisperMs = Date.now() - t0;
            const rawChars = raw.length;
            console.log(
                `[${this.sessionId}][forms] Remaining whisper — ` +
                `duration: ${remainingWhisperMs}ms, rawChars: ${rawChars}`
            );

            const wordCount = raw.trim().split(/\s+/).length;
            if (wordCount >= MIN_WORD_COUNT) {
                const t1 = Date.now();
                const revised = await reviseTranscription(raw);
                const remainingReviseMs = Date.now() - t1;
                console.log(
                    `[${this.sessionId}][forms] Remaining revise — ` +
                    `duration: ${remainingReviseMs}ms, revisedChars: ${revised.length}`
                );
                [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);
            }
        } catch (err) {
            console.error(`[${this.sessionId}][forms] Error on remaining audio:`, err);
        }

        await this.runFinalExtraction(stopStart);
    }

    private async runFinalExtraction(stopStart: number): Promise<void> {
        const st = this.st;
        console.log(
            `[${this.sessionId}][forms] Final extraction start — ` +
            `transcriptChars: ${st.transcript.length}, templateFields: ${st.template.length}`
        );
        const t0 = Date.now();

        try {
            st.currAttributes = await parseFinalAttributes(
                st.transcript,
                st.template,
                st.currAttributes
            );

            const finalMs = Date.now() - t0;
            const stopMs = Date.now() - stopStart;
            const sessionMs = Date.now() - this.sessionStartedAt;
            const finalAttrCount = Object.keys(st.currAttributes).length;

            console.log(
                `[${this.sessionId}][forms] Final complete — ` +
                `finalExtract: ${finalMs}ms, stop-to-done: ${stopMs}ms, ` +
                `session: ${Math.round(sessionMs / 1000)}s, finalAttrCount: ${finalAttrCount}`
            );

            this.send({ type: "final_attributes", attributes: st.currAttributes });
        } catch (err) {
            const finalMs = Date.now() - t0;
            const stopMs = Date.now() - stopStart;
            console.error(
                `[${this.sessionId}][forms] Final extraction error — ` +
                `finalExtract: ${finalMs}ms, stop-to-done: ${stopMs}ms:`,
                err
            );
            this.send({ type: "final_attributes", attributes: st.currAttributes });
        }
    }

    onClose(): void {
        this.queue.clear();
        console.log(`[${this.sessionId}][forms] Handler closed`);
    }

    private send(msg: object): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    }
}
