import PQueue from "p-queue";
import type { WebSocket } from "ws";
import {
    TranscriptionHandler,
    StartPayload,
    NotesState,
    makeAudioState,
} from "../types.js";
import {
    MIN_CHUNK_NUM,
    MIN_WORD_COUNT,
    MAX_AUDIO_BUFFER_SIZE,
    NOTES_CHUNK_PHASES,
    MAX_NOTES_SESSION_MS,
} from "../types.js";
import {
    checkWebMIntegrity,
    extractWebMInitSegment,
    transcribeAudioBatch,
    appendWithOverlap,
} from "../transcription.js";
import { reviseTranscription, generateNotesIncremental, finalizeNotes } from "../parse-gpt.js";

// ─── Adaptive notes update scheduler ─────────────────────────────────────────
//
// Notes updates use a time-and-chars based cadence so that:
//   - Early in a session updates feel real-time (every ~7.5s once enough text lands)
//   - Long sessions taper off to avoid stacking full-document rewrites
//   - At most one generateNotesIncremental runs at a time per session (one-in-flight)
//
// Both conditions must hold (AND logic) before an update fires:
//   - enough wall-clock time has elapsed since the last update
//   - enough pending revised transcript has accumulated
//
// lastNotesUpdateAt is initialised to sessionStartedAt so the first update
// waits for the early-phase interval rather than firing immediately.

type NotesUpdatePhase = {
    name: "early" | "warmup" | "settled" | "long" | "extended";
    maxWaitMs: number;
    minPendingChars: number;
};

type StopTrigger = "client" | "session-cap";

function getNotesPhase(elapsedMs: number): NotesUpdatePhase {
    if (elapsedMs <   2 * 60_000) return { name: "early",    maxWaitMs:   7_500, minPendingChars:   80 };
    if (elapsedMs <   5 * 60_000) return { name: "warmup",   maxWaitMs:  20_000, minPendingChars:  180 };
    if (elapsedMs <  10 * 60_000) return { name: "settled",  maxWaitMs:  30_000, minPendingChars:  280 };
    if (elapsedMs <  30 * 60_000) return { name: "long",     maxWaitMs:  60_000, minPendingChars:  600 };
    return                               { name: "extended", maxWaitMs: 120_000, minPendingChars: 1200 };
}

const MAX_CONTINUATION_NOTES_CHARS = 20000;
const CONTINUATION_OMISSION_MARKER = "\n\n[... middle of previous notes omitted due to continuation size limit ...]\n\n";

function normalizeContinuationNotes(markdown: string): { markdown: string; truncated: boolean } {
    const trimmed = markdown.trim();
    if (trimmed.length <= MAX_CONTINUATION_NOTES_CHARS) {
        return { markdown: trimmed, truncated: false };
    }

    // Preserve the start for structure/headings and the end for recent manual edits.
    const availableChars = MAX_CONTINUATION_NOTES_CHARS - CONTINUATION_OMISSION_MARKER.length;
    const headChars = Math.ceil(availableChars / 2);
    const tailChars = Math.floor(availableChars / 2);
    return {
        markdown: `${trimmed.slice(0, headChars)}${CONTINUATION_OMISSION_MARKER}${trimmed.slice(-tailChars)}`,
        truncated: true,
    };
}

export class NotesHandler implements TranscriptionHandler {
    private st: NotesState;
    private queue: PQueue;
    private passCount = 0;
    private sessionStartedAt = 0;

    // ── Adaptive scheduler state ──────────────────────────────────────────────
    // pendingNotesTranscript: revised transcript segments waiting for the next
    //   scheduled generateNotesIncremental call (newline-separated, never logged).
    // notesUpdateInFlight: true while a generateNotesIncremental is running —
    //   prevents a second call from starting until the first completes.
    // notesUpdatePromise: the in-flight promise, stored so onStop (T-012c) can
    //   await it before flushing pending transcript and running finalizeNotes.
    // lastNotesUpdateAt: timestamp of last completed update, seeded to
    //   sessionStartedAt so the first update waits for the early-phase interval.
    // isStopping: set once onStop begins so the scheduler's follow-up check
    //   cannot start new updates — Stop owns the single flush + finalisation
    //   path and must not wait for or trigger extra scheduler work.
    private pendingNotesTranscript = "";
    private notesUpdateInFlight = false;
    private notesUpdatePromise: Promise<void> | null = null;
    private lastNotesUpdateAt = 0;
    private isStopping = false;
    private sessionCapTimer: NodeJS.Timeout | null = null;
    private stopPromise: Promise<void> | null = null;

    constructor(private socket: WebSocket, private sessionId: string) {
        this.st = {
            ...makeAudioState(),
            noteStyle: "general",
            sections: [],
            currentMarkdown: "",
        };
        // Session transcript/markdown state is mutated sequentially; do not
        // parallelise without sequence guards around pass ordering.
        this.queue = new PQueue({ concurrency: 1 });
    }

    async onStart(payload: StartPayload): Promise<void> {
        if (payload.mode !== "notes") return;

        this.st.noteStyle = payload.noteStyle ?? "general";
        this.st.sections = payload.sections ?? [];
        const continuationRequested = payload.continuation === true;
        const providedNotesChars = typeof payload.currentNotesMarkdown === "string" ? payload.currentNotesMarkdown.length : 0;
        const continuation = continuationRequested && typeof payload.currentNotesMarkdown === "string"
            ? normalizeContinuationNotes(payload.currentNotesMarkdown)
            : { markdown: "", truncated: false };
        this.st.currentMarkdown = continuation.markdown;
        this.passCount = 0;
        this.sessionStartedAt = Date.now();
        // Seed lastNotesUpdateAt to session start so the AND-logic time gate
        // makes the first notes update wait for the early-phase interval (7.5s)
        // rather than firing immediately on the first revised segment.
        this.lastNotesUpdateAt = this.sessionStartedAt;
        this.pendingNotesTranscript = "";
        this.notesUpdateInFlight = false;
        this.notesUpdatePromise = null;
        this.isStopping = false;
        this.stopPromise = null;
        this.startSessionCapTimer();

        // Log resolved config only; never log notes content.
        console.log(
            `[${this.sessionId}][notes] Session start — ` +
            `style: "${this.st.noteStyle}", ` +
            `sections: [${this.st.sections.length > 0 ? this.st.sections.map(s => `"${s}"`).join(", ") : "none"}], ` +
            `continuation: ${continuationRequested}, ` +
            `providedNotesChars: ${providedNotesChars}, ` +
            `seededNotesChars: ${this.st.currentMarkdown.length}, ` +
            `truncated: ${continuation.truncated}`
        );

        this.send({ type: "started", mode: "notes" });
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        const st = this.st;

        // Once stop begins (manual or session-cap), ignore late-arriving audio
        // frames so finalisation cannot be prolonged by additional queue jobs.
        if (this.isStopping) {
            console.log(
                `[${this.sessionId}][notes] Chunk ignored during stop — ` +
                `bytes: ${chunk.length}, queue: ${this.queue.size} queued, ${this.queue.pending} pending`
            );
            return;
        }

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

        // T-012d: Notes-only adaptive batch threshold — smaller batches early in
        // the session so revised transcript (and notes updates) arrive sooner,
        // tapering to MIN_CHUNK_NUM later. Forms mode is unaffected.
        const chunkThreshold = this.notesChunkThreshold();
        if (st.nchunks < chunkThreshold) return;

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
            console.log(
                `[${this.sessionId}][notes] Pass ${passNum} start — ` +
                `buffer: ${captureSize} bytes, chunkThreshold: ${chunkThreshold}`
            );

            try {
                // Stage 1: Whisper transcription (with optional VAD pre-gate).
                const t0 = Date.now();
                const batchResult = await transcribeAudioBatch({
                    audioBuffer: captureBuffer,
                    sessionId: this.sessionId,
                    mode: "notes",
                    passNum,
                    reason: "batch",
                });
                if (batchResult.skipped) {
                    console.log(`[${this.sessionId}][notes] Pass ${passNum} — vad skip, no whisper (${Date.now() - passStart}ms)`);
                    return;
                }
                const transcription = batchResult.transcript;
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

                // Stage 3: Buffer revised transcript for the adaptive scheduler.
                // generateNotesIncremental is no longer called per-pass — the
                // scheduler (maybeScheduleNotesUpdate) decides when to fire it
                // based on elapsed session time and accumulated pending chars.
                this.pendingNotesTranscript +=
                    (this.pendingNotesTranscript.length > 0 ? "\n\n" : "") + revised;

                const e2eMs = Date.now() - passStart;
                console.log(
                    `[${this.sessionId}][notes] Pass ${passNum} complete — ` +
                    `revise: ${Date.now() - t1}ms, e2e: ${e2eMs}ms, ` +
                    `pendingChars: ${this.pendingNotesTranscript.length}`
                );

                // Trigger scheduler — fires notes update if phase conditions are met.
                void this.maybeScheduleNotesUpdate();

            } catch (e) {
                console.error(`[${this.sessionId}][notes] Pass ${passNum} failed after ${Date.now() - passStart}ms:`, e);
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        await this.beginStop("client");
    }

    private beginStop(trigger: StopTrigger): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.clearSessionCapTimer();
        this.stopPromise = this.stopAndFinalize(trigger);
        return this.stopPromise;
    }

    private async stopAndFinalize(trigger: StopTrigger): Promise<void> {
        const stopStart = Date.now();
        const st = this.st;
        // Block the scheduler's follow-up check from starting new updates. Any
        // in-flight update still completes and is awaited below; Stop then owns
        // the single pending flush + finalisation.
        this.isStopping = true;
        console.log(
            `[${this.sessionId}][notes] Stop received — ` +
            `trigger: ${trigger}, queue: ${this.queue.size} queued, ${this.queue.pending} pending`
        );

        await this.queue.onIdle();
        console.log(`[${this.sessionId}][notes] Queue drained — ${Date.now() - stopStart}ms`);

        let remaining = st.audioBuffer;

        // Process any audio buffered after the last queue pass (Whisper + revise only).
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
                const remainingResult = await transcribeAudioBatch({
                    audioBuffer: remaining,
                    sessionId: this.sessionId,
                    mode: "notes",
                    passNum: ++this.passCount,
                    reason: "stop",
                });
                const raw = remainingResult.transcript;
                console.log(`[${this.sessionId}][notes] Remaining whisper: ${Date.now() - t0}ms`);

                const wordCount = raw.trim().split(/\s+/).length;
                if (wordCount >= MIN_WORD_COUNT) {
                    const revised = await reviseTranscription(raw);
                    [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);

                    this.pendingNotesTranscript +=
                        (this.pendingNotesTranscript.length > 0 ? "\n\n" : "") + revised;
                }
            } catch (err) {
                console.error(`[${this.sessionId}][notes] Error on remaining audio:`, err);
            }
        }

        const hadInFlight = this.notesUpdatePromise !== null;
        console.log(
            `[${this.sessionId}][notes] Stop flush prep — ` +
            `pendingChars: ${this.pendingNotesTranscript.length}, ` +
            `inFlight: ${hadInFlight}`
        );

        // Await the single in-flight scheduled update, if any (may restore a
        // failed batch into pending). isStopping prevents its finally-block from
        // chaining a follow-up, so one snapshot await is sufficient.
        const inFlightNotesUpdate = this.notesUpdatePromise;
        if (inFlightNotesUpdate) {
            await inFlightNotesUpdate;
        }

        if (this.pendingNotesTranscript.trim().length > 0) {
            const pendingBatch = this.pendingNotesTranscript;
            this.pendingNotesTranscript = "";

            const flushStart = Date.now();
            console.log(
                `[${this.sessionId}][notes] Stop flush start — pendingChars: ${pendingBatch.length}`
            );

            try {
                const updated = await generateNotesIncremental(
                    pendingBatch,
                    st.currentMarkdown,
                    st.noteStyle,
                    st.sections,
                );
                st.currentMarkdown = updated;
                this.send({ type: "notes_update", notesMarkdown: updated });
                console.log(
                    `[${this.sessionId}][notes] Stop flush done — ` +
                    `duration: ${Date.now() - flushStart}ms, ` +
                    `outputChars: ${updated.length}`
                );
            } catch (e) {
                console.error(
                    `[${this.sessionId}][notes] Stop flush failed after ` +
                    `${Date.now() - flushStart}ms:`,
                    e
                );
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
        this.clearSessionCapTimer();
        // Stop any future scheduling: an in-flight update's finally-block
        // follow-up checks isStopping, so it won't schedule after close.
        this.isStopping = true;
        this.queue.clear();
        // Clear pending buffer so a stale update can't fire on a closed socket.
        this.pendingNotesTranscript = "";
        this.notesUpdateInFlight = false;
        this.notesUpdatePromise = null;
        console.log(`[${this.sessionId}][notes] Handler closed`);
    }

    private startSessionCapTimer(): void {
        this.clearSessionCapTimer();
        const remainingMs = MAX_NOTES_SESSION_MS - (Date.now() - this.sessionStartedAt);
        if (remainingMs <= 0) {
            console.warn(
                `[${this.sessionId}][notes] Session cap reached immediately — ` +
                `maxMs: ${MAX_NOTES_SESSION_MS}`
            );
            void this.beginStop("session-cap");
            return;
        }
        this.sessionCapTimer = setTimeout(() => {
            console.warn(
                `[${this.sessionId}][notes] Session cap reached — ` +
                `maxMs: ${MAX_NOTES_SESSION_MS}, sessionMs: ${Date.now() - this.sessionStartedAt}`
            );
            void this.beginStop("session-cap");
        }, remainingMs);
        // Do not keep the process alive solely for a long safety timer.
        this.sessionCapTimer.unref?.();
        console.log(
            `[${this.sessionId}][notes] Session cap armed — ` +
            `maxMs: ${MAX_NOTES_SESSION_MS}, remainingMs: ${remainingMs}`
        );
    }

    private clearSessionCapTimer(): void {
        if (!this.sessionCapTimer) return;
        clearTimeout(this.sessionCapTimer);
        this.sessionCapTimer = null;
    }

    // ── Notes-only adaptive audio batch threshold (T-012d) ────────────────────
    //
    // Returns the minimum number of buffered ~2s chunks required before a
    // Whisper/revision pass fires, based on elapsed session time. Smaller early
    // thresholds make revised transcript available sooner so the notes scheduler
    // can actually update near its early-phase cadence; later phases taper back
    // to MIN_CHUNK_NUM. Forms mode does not use this and keeps MIN_CHUNK_NUM.
    private notesChunkThreshold(): number {
        const elapsed = Date.now() - this.sessionStartedAt;
        for (const phase of NOTES_CHUNK_PHASES) {
            if (elapsed < phase.untilMs) return phase.minChunks;
        }
        return MIN_CHUNK_NUM;
    }

    // ── Adaptive scheduler ────────────────────────────────────────────────────
    //
    // Called after each queue job appends to pendingNotesTranscript, and once
    // more after each in-flight notes update completes (follow-up check).
    //
    // AND conditions before firing:
    //   1. No notes update currently in flight.
    //   2. Enough pending revised transcript for the current phase.
    //   3. Enough wall-clock time since the last update for the current phase.
    //
    // On error: restores the batch to pendingNotesTranscript so content is
    // not silently dropped — will retry on the next maybeScheduleNotesUpdate call.
    private maybeScheduleNotesUpdate(): void {
        // Once Stop has begun, do not start new scheduled updates (including the
        // finally-block follow-up). Stop awaits the in-flight update, then runs
        // exactly one flush + finalisation.
        if (this.isStopping) return;
        if (this.notesUpdateInFlight) return;
        if (this.pendingNotesTranscript.length === 0) return;

        const elapsed = Date.now() - this.sessionStartedAt;
        const phase = getNotesPhase(elapsed);
        const timeSinceLast = Date.now() - this.lastNotesUpdateAt;

        if (this.pendingNotesTranscript.length < phase.minPendingChars) return;
        if (timeSinceLast < phase.maxWaitMs) return;

        // Snapshot and clear the buffer before any async work.
        // Any new segments appended by concurrent queue jobs land in the fresh
        // (empty) buffer and will be picked up by the follow-up check.
        const batch = this.pendingNotesTranscript;
        this.pendingNotesTranscript = "";
        this.notesUpdateInFlight = true;

        const updateStart = Date.now();
        console.log(
            `[${this.sessionId}][notes] Scheduled update start — ` +
            `phase: ${phase.name}, pendingChars: ${batch.length}, ` +
            `currentMarkdownChars: ${this.st.currentMarkdown.length}`
        );

        this.notesUpdatePromise = (async () => {
            try {
                const updated = await generateNotesIncremental(
                    batch,
                    this.st.currentMarkdown,
                    this.st.noteStyle,
                    this.st.sections,
                );
                this.st.currentMarkdown = updated;
                this.lastNotesUpdateAt = Date.now();
                console.log(
                    `[${this.sessionId}][notes] Scheduled update done — ` +
                    `phase: ${phase.name}, duration: ${Date.now() - updateStart}ms, ` +
                    `outputChars: ${updated.length}`
                );
                this.send({ type: "notes_update", notesMarkdown: updated });
            } catch (e) {
                console.error(
                    `[${this.sessionId}][notes] Scheduled update failed after ` +
                    `${Date.now() - updateStart}ms:`, e
                );
                // Restore batch so content isn't silently dropped.
                // Prepend so existing pending (from jobs that ran during the
                // failed update) stays in correct chronological order.
                this.pendingNotesTranscript =
                    batch + (this.pendingNotesTranscript.length > 0
                        ? "\n\n" + this.pendingNotesTranscript
                        : "");
            } finally {
                this.notesUpdateInFlight = false;
                this.notesUpdatePromise = null;
                // One follow-up check: if enough transcript accumulated while
                // this update was running, fire another update immediately.
                // Guarded explicitly so that once Stop/Close has begun no
                // scheduler-created follow-up can run — Stop owns the single
                // flush + finalisation, and Close must not schedule after the
                // socket is gone. (maybeScheduleNotesUpdate also early-returns
                // on isStopping; this makes the boundary obvious at the call site.)
                if (!this.isStopping) {
                    this.maybeScheduleNotesUpdate();
                }
            }
        })();
    }

    private send(msg: object): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    }
}
