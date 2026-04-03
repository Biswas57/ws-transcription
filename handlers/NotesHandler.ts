import PQueue from "p-queue";
import type { WebSocket } from "ws";
import {
    TranscriptionHandler,
    StartPayload,
    NotesState,
    makeAudioState,
} from "../types.js";
import { MIN_CHUNK_NUM, MIN_WORD_COUNT, MAX_AUDIO_BUFFER_SIZE } from "../types.js";
import {
    checkWebMIntegrity,
    extractWebMInitSegment,
    runWhisperOnBuffer,
    appendWithOverlap,
} from "../transcription.js";
import { reviseTranscription, generateNotesIncremental, finalizeNotes } from "../parse-gpt.js";

export class NotesHandler implements TranscriptionHandler {
    private st: NotesState;
    private queue: PQueue;
    private passCount = 0;
    private sessionStartedAt = 0;

    constructor(private socket: WebSocket, private sessionId: string) {
        this.st = {
            ...makeAudioState(),
            noteStyle: "general",
            sections: [],
            currentMarkdown: "",
        };
        this.queue = new PQueue({ concurrency: 4 });
    }

    async onStart(payload: StartPayload): Promise<void> {
        if (payload.mode !== "notes") return;

        this.st.noteStyle = payload.noteStyle ?? "general";
        this.st.sections = payload.sections ?? [];
        this.st.currentMarkdown = "";
        this.passCount = 0;
        this.sessionStartedAt = Date.now();

        // Log resolved config — safe to log (user-chosen config, not transcript content)
        console.log(
            `[${this.sessionId}][notes] Session start — ` +
            `style: "${this.st.noteStyle}", ` +
            `sections: [${this.st.sections.length > 0 ? this.st.sections.map(s => `"${s}"`).join(", ") : "none"}]`
        );

        this.send({ type: "started", mode: "notes" });
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        const st = this.st;

        if (st.audioBuffer.length + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
            console.warn(`[${this.sessionId}][notes] Audio buffer overflow — dropping chunk`);
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

        // Snapshot + reset so new chunks aren't blocked during async processing
        const captureBuffer = st.audioBuffer;
        const captureSize = captureBuffer.length;
        st.audioBuffer = Buffer.alloc(0);
        st.nchunks = 0;
        const passNum = ++this.passCount;

        this.queue.add(async () => {
            const passStart = Date.now();
            console.log(`[${this.sessionId}][notes] Pass ${passNum} start — buffer: ${captureSize} bytes`);

            try {
                // Stage 1: Whisper transcription
                const t0 = Date.now();
                const transcription = await runWhisperOnBuffer(captureBuffer);
                console.log(`[${this.sessionId}][notes] Pass ${passNum} — whisper: ${Date.now() - t0}ms, chars: ${transcription.length}`);

                // Stage 2: Transcript revision
                const t1 = Date.now();
                const revised = await reviseTranscription(transcription);
                console.log(`[${this.sessionId}][notes] Pass ${passNum} — revise: ${Date.now() - t1}ms`);

                const wordCount = revised.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    console.log(`[${this.sessionId}][notes] Pass ${passNum} — too short (${wordCount} words), skipping`);
                    return;
                }

                [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);

                // Stage 3: Incremental notes generation
                const t2 = Date.now();
                st.currentMarkdown = await generateNotesIncremental(
                    revised,
                    st.currentMarkdown,
                    this.st.noteStyle,
                    this.st.sections
                );
                const notesMs = Date.now() - t2;
                const e2eMs = Date.now() - passStart;

                console.log(
                    `[${this.sessionId}][notes] Pass ${passNum} complete — ` +
                    `notes: ${notesMs}ms, e2e: ${e2eMs}ms, output: ${st.currentMarkdown.length} chars`
                );

                // Stage 4: Outbound send
                this.send({ type: "notes_update", notesMarkdown: st.currentMarkdown });

            } catch (e) {
                console.error(`[${this.sessionId}][notes] Pass ${passNum} failed after ${Date.now() - passStart}ms:`, e);
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        const stopStart = Date.now();
        const st = this.st;
        console.log(`[${this.sessionId}][notes] Stop received — draining queue (${this.queue.size} queued, ${this.queue.pending} pending)`);

        await this.queue.onIdle();
        console.log(`[${this.sessionId}][notes] Queue drained — ${Date.now() - stopStart}ms`);

        let remaining = st.audioBuffer;

        // Process any audio buffered after the last incremental pass
        if (remaining.length > 0) {
            console.log(`[${this.sessionId}][notes] Processing ${remaining.length} bytes remaining audio`);

            if (!checkWebMIntegrity(remaining) && st.webmHeader) {
                remaining = Buffer.concat([st.webmHeader, remaining]);
            }
            st.audioBuffer = Buffer.alloc(0);
            st.nchunks = 0;
            st.webmHeader = null;

            try {
                const t0 = Date.now();
                const raw = await runWhisperOnBuffer(remaining);
                console.log(`[${this.sessionId}][notes] Remaining whisper: ${Date.now() - t0}ms`);

                const wordCount = raw.trim().split(/\s+/).length;
                if (wordCount >= MIN_WORD_COUNT) {
                    const revised = await reviseTranscription(raw);
                    [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);

                    st.currentMarkdown = await generateNotesIncremental(
                        revised,
                        st.currentMarkdown,
                        this.st.noteStyle,
                        this.st.sections
                    );
                }
            } catch (err) {
                console.error(`[${this.sessionId}][notes] Error on remaining audio:`, err);
            }
        }

        // Final GPT-5.4 polish pass
        console.log(`[${this.sessionId}][notes] Starting final pass — transcript: ${st.transcript.length} chars`);
        const finalStart = Date.now();

        try {
            const finalMarkdown = await finalizeNotes(
                st.transcript,
                st.currentMarkdown,
                this.st.noteStyle,
                this.st.sections
            );

            const finalMs = Date.now() - finalStart;
            const stopMs = Date.now() - stopStart;
            const sessionMs = Date.now() - this.sessionStartedAt;

            console.log(
                `[${this.sessionId}][notes] Final pass complete — ` +
                `finalizeNotes: ${finalMs}ms, stop-to-done: ${stopMs}ms, ` +
                `session: ${Math.round(sessionMs / 1000)}s, output: ${finalMarkdown.length} chars`
            );

            st.currentMarkdown = finalMarkdown;
            this.send({ type: "notes_final", notesMarkdown: finalMarkdown });
        } catch (err) {
            console.error(`[${this.sessionId}][notes] Final pass error:`, err);
            this.send({ type: "notes_final", notesMarkdown: st.currentMarkdown });
        }
    }

    onClose(): void {
        this.queue.clear();
        console.log(`[${this.sessionId}][notes] Handler closed`);
    }

    private send(msg: object): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    }
}
