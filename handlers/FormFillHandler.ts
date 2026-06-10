import PQueue from "p-queue";
import type { WebSocket } from "ws";
import {
    TranscriptionHandler,
    StartPayload,
    FormFillState,
    makeAudioState,
} from "../types.js";
import {
    FORMS_MIN_CHUNK_NUM,
    FORMS_MIN_TRANSCRIPT_CHARS,
    MAX_AUDIO_BUFFER_SIZE,
    MAX_FORMS_TRANSCRIPTION_QUEUE_JOBS,
} from "../types.js";
import {
    checkWebMIntegrity,
    extractWebMInitSegment,
    runWhisperOnBuffer,
    appendWithOverlap,
} from "../transcription.js";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "../parse-gpt.js";
import { recordUsageEvent, safeErrorInfo } from "../safe-log.js";

function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

export function isMeaningfulFormTranscript(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length >= FORMS_MIN_TRANSCRIPT_CHARS && /[A-Za-z0-9$]/.test(trimmed);
}

export class FormFillHandler implements TranscriptionHandler {
    private st: FormFillState;
    private queue: PQueue;
    private passCount = 0;
    private sessionStartedAt = 0;
    private closed = false;
    private isStopping = false;
    private stopPromise: Promise<void> | null = null;
    private finalSent = false;
    private overloadSignaled = false;

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
        if (this.closed) return;
        if (payload.mode !== "forms") return;

        this.st.template = [];
        this.st.currAttributes = {};
        this.passCount = 0;
        this.sessionStartedAt = Date.now();
        this.isStopping = false;
        this.stopPromise = null;
        this.finalSent = false;
        this.overloadSignaled = false;

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
        recordUsageEvent("recording_session_start", {
            mode: "forms",
            templateFields: this.st.template.length,
            blockCount: Object.keys(payload.blocks ?? {}).length,
        });
        this.send({ type: "started", mode: "forms" });
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        if (this.closed || this.isStopping || this.finalSent) {
            console.log(
                `[${this.sessionId}][forms] Chunk ignored after stop/close — ` +
                `bytes: ${chunk.length}, queue: ${this.queue.size} queued, ${this.queue.pending} pending`
            );
            return;
        }

        if (this.overloadSignaled) return;

        if (this.queueLoad() >= MAX_FORMS_TRANSCRIPTION_QUEUE_JOBS) {
            if (!this.overloadSignaled) {
                this.overloadSignaled = true;
                console.warn(
                    `[${this.sessionId}][forms] Queue overloaded — ` +
                    `queue: ${this.queue.size} queued, ${this.queue.pending} pending, ` +
                    `maxJobs: ${MAX_FORMS_TRANSCRIPTION_QUEUE_JOBS}`
                );
                recordUsageEvent("recording_queue_overloaded", {
                    mode: "forms",
                    queueSize: this.queue.size,
                    queuePending: this.queue.pending,
                    queueLoad: this.queueLoad(),
                    maxJobs: MAX_FORMS_TRANSCRIPTION_QUEUE_JOBS,
                    elapsedSessionMs: Date.now() - this.sessionStartedAt,
                    audioBufferBytes: this.st.audioBuffer.length,
                    incomingChunkBytes: chunk.length,
                    overloadSignaled: this.overloadSignaled,
                });
                this.send({
                    type: "error",
                    code: "transcription-overloaded",
                    message: "Recording processing is temporarily overloaded. Please stop and try again.",
                });
            }
            return;
        }

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

        if (st.nchunks < FORMS_MIN_CHUNK_NUM) return;

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
        recordUsageEvent("transcription_batch_accepted", {
            mode: "forms",
            reason: "batch",
            passNum,
            audioBufferBytes: captureSize,
            chunkCount: captureChunkCount,
            queueSize: queueSizeAtEnqueue,
            queuePending: queuePendingAtEnqueue,
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
        });

        this.queue.add(async () => {
            if (this.closed) return;
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
                if (this.closed) return;
                const whisperMs = Date.now() - t0;
                const rawChars = transcription.length;
                console.log(
                    `[${this.sessionId}][forms] Pass ${passNum} — ` +
                    `whisper: ${whisperMs}ms, rawChars: ${rawChars}`
                );

                // Stage 2: Revision
                const t1 = Date.now();
                const revised = await reviseTranscription(transcription, { mode: "forms" });
                if (this.closed) return;
                const reviseMs = Date.now() - t1;
                const revisedChars = revised.length;
                console.log(
                    `[${this.sessionId}][forms] Pass ${passNum} — ` +
                    `revise: ${reviseMs}ms, revisedChars: ${revisedChars}`
                );

                if (!isMeaningfulFormTranscript(revised)) {
                    const passMs = Date.now() - passStart;
                    console.log(
                        `[${this.sessionId}][forms] Pass ${passNum} skipped — ` +
                        `emptyOrNoise: true, revisedChars: ${revised.trim().length}, passMs: ${passMs}`
                    );
                    recordUsageEvent("transcription_batch_processed", {
                        mode: "forms",
                        reason: "batch",
                        passNum,
                        skipped: true,
                        emptyOrNoise: true,
                        rawChars,
                        revisedChars: revised.trim().length,
                        durationMs: passMs,
                    });
                    return;
                }

                const prevSize = st.currTranscriptSize;
                [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);
                const window = st.transcript.slice(-(prevSize + st.currTranscriptSize));

                // Stage 3: Attribute extraction
                const t2 = Date.now();
                const extracted = await extractAttributesFromText(window, st.template, st.currAttributes);
                if (this.closed) return;
                st.currAttributes = { ...st.currAttributes, ...extracted };
                const extractMs = Date.now() - t2;
                const passMs = Date.now() - passStart;
                const attrsReturned = Object.keys(extracted).length;

                console.log(
                    `[${this.sessionId}][forms] Pass ${passNum} complete — ` +
                    `extract: ${extractMs}ms, attrsReturned: ${attrsReturned}, passMs: ${passMs}`
                );
                recordUsageEvent("transcription_batch_processed", {
                    mode: "forms",
                    reason: "batch",
                    passNum,
                    skipped: false,
                    rawChars,
                    revisedChars,
                    attrsReturned,
                    cumulativeTranscriptChars: st.transcript.length,
                    durationMs: passMs,
                });

                this.send({ type: "attributes_update", attributes: st.currAttributes });

            } catch (e) {
                recordUsageEvent("transcription_batch_failed", {
                    mode: "forms",
                    reason: "batch",
                    passNum,
                    durationMs: Date.now() - passStart,
                });
                console.error(
                    `[${this.sessionId}][forms] Pass ${passNum} failed — ` +
                    `passMs: ${Date.now() - passStart}ms, error: ${safeErrorInfo(e)}`
                );
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.isStopping = true;
        this.stopPromise = this.stopAndFinalize();
        return this.stopPromise;
    }

    private async stopAndFinalize(): Promise<void> {
        const stopStart = Date.now();
        const st = this.st;
        const queueSizeAtStop = this.queue.size;
        const queuePendingAtStop = this.queue.pending;
        console.log(
            `[${this.sessionId}][forms] Stop received — ` +
            `queueSize: ${queueSizeAtStop}, queuePending: ${queuePendingAtStop}`
        );
        recordUsageEvent("recording_stop_start", {
            mode: "forms",
            stopReason: "client",
            queueSize: queueSizeAtStop,
            queuePending: queuePendingAtStop,
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
            transcriptChars: st.transcript.length,
            templateFields: st.template.length,
        });

        const drainStart = Date.now();
        await this.queue.onIdle();
        if (this.closed) return;
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
            if (this.closed) return;
            const remainingWhisperMs = Date.now() - t0;
            const rawChars = raw.length;
            console.log(
                `[${this.sessionId}][forms] Remaining whisper — ` +
                `duration: ${remainingWhisperMs}ms, rawChars: ${rawChars}`
            );

            if (isMeaningfulFormTranscript(raw)) {
                const t1 = Date.now();
                const revised = await reviseTranscription(raw, { mode: "forms" });
                if (this.closed) return;
                const remainingReviseMs = Date.now() - t1;
                console.log(
                    `[${this.sessionId}][forms] Remaining revise — ` +
                    `duration: ${remainingReviseMs}ms, revisedChars: ${revised.length}`
                );
                [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);
            } else {
                console.log(
                    `[${this.sessionId}][forms] Remaining audio skipped — ` +
                    `emptyOrNoise: true, rawChars: ${raw.trim().length}`
                );
            }
        } catch (err) {
            console.error(`[${this.sessionId}][forms] Error on remaining audio — ${safeErrorInfo(err)}`);
        }

        await this.runFinalExtraction(stopStart);
    }

    private async runFinalExtraction(stopStart: number): Promise<void> {
        if (this.closed || this.finalSent) return;
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
            if (this.closed || this.finalSent) return;

            const finalMs = Date.now() - t0;
            const stopMs = Date.now() - stopStart;
            const sessionMs = Date.now() - this.sessionStartedAt;
            const finalAttrCount = Object.keys(st.currAttributes).length;

            console.log(
                `[${this.sessionId}][forms] Final complete — ` +
                `finalExtract: ${finalMs}ms, stop-to-done: ${stopMs}ms, ` +
                `session: ${Math.round(sessionMs / 1000)}s, finalAttrCount: ${finalAttrCount}`
            );
            recordUsageEvent("recording_finalisation_complete", {
                mode: "forms",
                stopReason: "client",
                finalMs,
                stopToDoneMs: stopMs,
                elapsedSessionMs: sessionMs,
                transcriptChars: st.transcript.length,
                templateFields: st.template.length,
                finalAttrCount,
                passCount: this.passCount,
            });

            this.finalSent = true;
            this.send({ type: "final_attributes", attributes: st.currAttributes });
        } catch (err) {
            if (this.closed || this.finalSent) return;
            const finalMs = Date.now() - t0;
            const stopMs = Date.now() - stopStart;
            console.error(
                `[${this.sessionId}][forms] Final extraction error — ` +
                `finalExtract: ${finalMs}ms, stop-to-done: ${stopMs}ms, error: ${safeErrorInfo(err)}`
            );
            recordUsageEvent("recording_finalisation_failed", {
                mode: "forms",
                stopReason: "client",
                finalMs,
                stopToDoneMs: stopMs,
                transcriptChars: st.transcript.length,
                templateFields: st.template.length,
            });
            this.finalSent = true;
            this.send({ type: "final_attributes", attributes: st.currAttributes });
        }
    }

    onClose(): void {
        if (this.closed) return;
        this.closed = true;
        this.isStopping = true;
        this.queue.clear();
        console.log(`[${this.sessionId}][forms] Handler closed`);
        recordUsageEvent("recording_session_closed", {
            mode: "forms",
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
            queueSize: this.queue.size,
            queuePending: this.queue.pending,
            finalSent: this.finalSent,
        });
    }

    private queueLoad(): number {
        return this.queue.size + this.queue.pending;
    }

    private send(msg: object): void {
        if (!this.closed && this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    }
}
