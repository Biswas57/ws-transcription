import PQueue from "p-queue";
import type { WebSocket } from "ws";
import {
    TranscriptionHandler,
    StartPayload,
    NotesState,
    makeAudioState,
} from "../types.js";
import { MIN_CHUNK_NUM, MIN_WORD_COUNT, MAX_AUDIO_BUFFER_SIZE } from "../types.js";
import { checkWebMIntegrity, runWhisperOnBuffer, appendWithOverlap } from "../transcription.js";
import { reviseTranscription, generateNotesIncremental, finalizeNotes } from "../parse-gpt.js";

export class NotesHandler implements TranscriptionHandler {
    private state: NotesState;
    private queue: PQueue;

    constructor(private socket: WebSocket) {
        this.state = {
            ...makeAudioState(),
            noteStyle: "general",
            sections: [],
            currentMarkdown: "",
        };
        this.queue = new PQueue({ concurrency: 4 });
    }

    async onStart(payload: StartPayload): Promise<void> {
        if (payload.mode !== "notes") return;

        this.state.noteStyle = payload.noteStyle ?? "general";
        this.state.sections = payload.sections ?? [];
        this.state.currentMarkdown = "";

        console.log(`[Notes] Started — style: ${this.state.noteStyle}, sections: [${this.state.sections.join(", ")}]`);
        this.send({ type: "started", mode: "notes" });
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        const state = this.state;

        if (state.audioBuffer.length + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
            console.warn("[Notes] Audio buffer limit exceeded, dropping chunk");
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

        // Snapshot + reset immediately (same pattern as FormFillHandler)
        const captureBuffer = state.audioBuffer;
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;

        this.queue.add(async () => {
            try {
                const transcription = await runWhisperOnBuffer(captureBuffer);
                const revised = await reviseTranscription(transcription);

                const wordCount = revised.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    console.log(`[Notes] Too short (${wordCount} words), skipping`);
                    return;
                }

                // Append to session transcript
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, revised);

                // Incrementally update notes
                state.currentMarkdown = await generateNotesIncremental(
                    revised,
                    state.currentMarkdown,
                    state.noteStyle,
                    state.sections
                );

                this.send({
                    type: "notes_update",
                    notesMarkdown: state.currentMarkdown,
                });
            } catch (e) {
                console.error("[Notes] Processing error:", e);
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        await this.queue.onIdle();

        const state = this.state;
        let remaining = state.audioBuffer;

        // Process any remaining buffered audio first
        if (remaining.length > 0) {
            if (!checkWebMIntegrity(remaining) && state.webmHeader) {
                remaining = Buffer.concat([state.webmHeader, remaining]);
            }

            state.audioBuffer = Buffer.alloc(0);
            state.nchunks = 0;
            state.webmHeader = null;

            try {
                const raw = await runWhisperOnBuffer(remaining);
                const wordCount = raw.trim().split(/\s+/).length;

                if (wordCount >= MIN_WORD_COUNT) {
                    const revised = await reviseTranscription(raw);
                    [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, revised);

                    // One more incremental update before the final pass
                    state.currentMarkdown = await generateNotesIncremental(
                        revised,
                        state.currentMarkdown,
                        state.noteStyle,
                        state.sections
                    );
                }
            } catch (err) {
                console.error("[Notes] Error processing remaining audio:", err);
            }
        }

        // Final gpt-4o polish pass
        try {
            const finalMarkdown = await finalizeNotes(
                state.transcript,
                state.currentMarkdown,
                state.noteStyle,
                state.sections
            );
            state.currentMarkdown = finalMarkdown;

            console.log(`[Notes] Final: ${state.transcript.length} chars transcript → ${finalMarkdown.length} chars notes`);

            this.send({
                type: "notes_final",
                notesMarkdown: finalMarkdown,
            });
        } catch (err) {
            console.error("[Notes] Final pass error, sending current notes:", err);
            this.send({
                type: "notes_final",
                notesMarkdown: state.currentMarkdown,
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
