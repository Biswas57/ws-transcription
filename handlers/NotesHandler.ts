import PQueue from "p-queue";
import type { WebSocket } from "ws";
import {
    TranscriptionHandler,
    StartPayload,
    NotesState,
    makeAudioState,
} from "../types.js";
import {
    NOTES_MIN_WORD_COUNT,
    MAX_AUDIO_BUFFER_SIZE,
    NOTES_CHUNK_PHASES,
    NOTES_DEFAULT_MIN_CHUNKS,
    MAX_NOTES_SESSION_MS,
    MAX_NOTES_TRANSCRIPTION_QUEUE_JOBS,
} from "../types.js";
import {
    checkWebMIntegrity,
    extractWebMInitSegment,
    transcribeAudioBatch,
    appendWithOverlap,
} from "../transcription.js";
import { reviseTranscription, generateNotesIncrementalPatch, finalizeNotes } from "../parse-gpt.js";
import { applyNotesLivePatch } from "../notes-live-patch.js";
import { recordUsageEvent, safeErrorInfo } from "../safe-log.js";
import { resolveNotesCapWindow, type NotesCapWindowLease } from "../notes-cap-registry.js";
import {
    defaultNotesFinalisationRecoveryStore,
    type NotesFinalisationRecoveryStore,
} from "../notes-finalisation-recovery.js";
import {
    defaultNotesActiveInterruptionRecoveryStore,
    type NotesActiveInterruptionClaimResult,
    type NotesActiveInterruptionRecoveryStore,
    type NotesActiveInterruptionSnapshot,
} from "../notes-active-interruption-recovery.js";

// ─── Adaptive notes update scheduler ─────────────────────────────────────────
//
// Notes updates use a time-and-chars based cadence so that:
//   - Early in a session updates feel real-time (every ~7.5s once enough text lands)
//   - Long sessions taper off to avoid stacking full-document rewrites
//   - At most one live patch generation runs at a time per session (one-in-flight)
//
// Both conditions must hold (AND logic) before an update fires:
//   - enough wall-clock time has elapsed since the last update
//   - enough pending revised transcript has accumulated
//
// lastNotesUpdateAt is initialised to sessionStartedAt so the first update
// waits for the early-phase interval rather than firing immediately.

type NotesUpdatePhase = {
    name: "early" | "settled" | "long" | "extended";
    untilMs: number;
    maxWaitMs: number;
    minPendingChars: number;
};

type StopTrigger = "client" | "session-cap";
type NotesHandlerAuthContext = {
    userId?: string;
    recordingSessionId?: string;
};

type NotesHandlerDeps = {
    finalisationRecoveryStore?: NotesFinalisationRecoveryStore;
    activeInterruptionRecoveryStore?: NotesActiveInterruptionRecoveryStore;
};

const NOTES_UPDATE_PHASES: NotesUpdatePhase[] = [
    { name: "early", untilMs: 2 * 60_000, maxWaitMs: 15_000, minPendingChars: 80 },
    { name: "settled", untilMs: 10 * 60_000, maxWaitMs: 30_000, minPendingChars: 280 },
    { name: "long", untilMs: 30 * 60_000, maxWaitMs: 60_000, minPendingChars: 600 },
    { name: "extended", untilMs: Infinity, maxWaitMs: 120_000, minPendingChars: 1200 },
];

function getNotesPhase(elapsedMs: number): NotesUpdatePhase {
    return NOTES_UPDATE_PHASES.find((phase) => elapsedMs < phase.untilMs) ?? NOTES_UPDATE_PHASES[NOTES_UPDATE_PHASES.length - 1];
}

function countWords(text: string): number {
    const trimmed = text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function joinNotesBatches(...batches: string[]): string {
    return batches
        .map((batch) => batch.trim())
        .filter((batch) => batch.length > 0)
        .join("\n\n");
}

export class NotesHandler implements TranscriptionHandler {
    private st: NotesState;
    private queue: PQueue;
    private passCount = 0;
    private sessionStartedAt = 0;

    // ── Adaptive scheduler state ──────────────────────────────────────────────
    // pendingNotesTranscript: revised transcript segments waiting for the next
    //   scheduled live patch call (newline-separated, never logged).
    // notesUpdateInFlight: true while a live patch generation is running —
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
    private notesUpdateActiveBatch = "";
    private lastNotesUpdateAt = 0;
    private isStopping = false;
    private sessionCapTimer: NodeJS.Timeout | null = null;
    private stopPromise: Promise<void> | null = null;
    private closed = false;
    private overloadSignaled = false;
    private capWindow: NotesCapWindowLease | null = null;
    private capWindowClosed = false;
    private finalisationRecoveryId: string | null = null;
    private finalisationRecoveryEnabled = false;
    private finalisationRecoveryStore: NotesFinalisationRecoveryStore;
    private activeInterruptionRecoveryStore: NotesActiveInterruptionRecoveryStore;
    private activeRecordingRecoveryStatus: "resumed" | "expired" | "not_found" | null = null;

    constructor(
        private socket: WebSocket,
        private sessionId: string,
        private authContext: NotesHandlerAuthContext = {},
        deps: NotesHandlerDeps = {}
    ) {
        this.finalisationRecoveryStore =
            deps.finalisationRecoveryStore ?? defaultNotesFinalisationRecoveryStore;
        this.activeInterruptionRecoveryStore =
            deps.activeInterruptionRecoveryStore ?? defaultNotesActiveInterruptionRecoveryStore;
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
        if (this.closed) return;
        if (payload.mode !== "notes") return;

        this.st.noteStyle =
            payload.noteStyle === "clinical" ||
                payload.noteStyle === "meeting" ||
                payload.noteStyle === "study" ||
                payload.noteStyle === "general"
                ? payload.noteStyle
                : "general";
        this.st.sections = Array.isArray(payload.sections)
            ? payload.sections
                .filter((section): section is string => typeof section === "string")
                .map((section) => section.trim())
                .filter((section) => section.length > 0)
            : [];
        const continuationRequested = payload.continuation === true;
        const providedNotesChars = typeof payload.currentNotesMarkdown === "string" ? payload.currentNotesMarkdown.length : 0;
        const continuationMarkdown = continuationRequested && typeof payload.currentNotesMarkdown === "string"
            ? payload.currentNotesMarkdown.trim()
            : "";
        this.st.currentMarkdown = continuationMarkdown;
        this.passCount = 0;
        this.sessionStartedAt = Date.now();
        // Seed lastNotesUpdateAt to session start so the AND-logic time gate
        // makes the first notes update wait for the early-phase interval (7.5s)
        // rather than firing immediately on the first revised segment.
        this.lastNotesUpdateAt = this.sessionStartedAt;
        this.pendingNotesTranscript = "";
        this.notesUpdateInFlight = false;
        this.notesUpdatePromise = null;
        this.notesUpdateActiveBatch = "";
        this.isStopping = false;
        this.stopPromise = null;
        this.overloadSignaled = false;
        this.capWindowClosed = false;
        this.finalisationRecoveryId = null;
        this.finalisationRecoveryEnabled = false;
        this.activeRecordingRecoveryStatus = null;

        const activeInterruptionClaim = this.tryClaimActiveInterruption(
            continuationRequested,
            continuationMarkdown
        );
        if (activeInterruptionClaim) {
            this.activeRecordingRecoveryStatus = activeInterruptionClaim.status;
        }

        if (!this.finalisationRecoveryId) {
            this.reserveFinalisationRecovery();
        }
        this.capWindow = this.authContext.userId
            ? resolveNotesCapWindow({
                userId: this.authContext.userId,
                recordingSessionId: this.authContext.recordingSessionId,
                backendSessionId: this.sessionId,
                continuationRequested,
            })
            : null;
        this.startSessionCapTimer();

        // Log resolved config only; never log notes content.
        console.log(
            `[${this.sessionId}][notes] Session start — ` +
            `noteStyleCategory: ${this.st.noteStyle}, ` +
            `sectionsCount: ${this.st.sections.length}, ` +
            `sectionsChars: ${this.st.sections.reduce((sum, section) => sum + section.length, 0)}, ` +
            `continuation: ${continuationRequested}, ` +
            `providedNotesChars: ${providedNotesChars}, ` +
            `seededNotesChars: ${this.st.currentMarkdown.length}, ` +
            `canonicalNotesChars: ${this.st.currentMarkdown.length}, ` +
            `truncatedForCanonical: false, ` +
            `activeRecordingRecovery: ${this.activeRecordingRecoveryStatus ?? "not-attempted"}, ` +
            `capWindow: ${this.capWindow !== null}, ` +
            `capWindowReused: ${this.capWindow?.capWindowReused ?? false}`
        );
        recordUsageEvent("recording_session_start", {
            mode: "notes",
            continuation: continuationRequested,
            providedNotesChars,
            currentNotesChars: this.st.currentMarkdown.length,
            sectionsCount: this.st.sections.length,
            sectionsChars: this.st.sections.reduce((sum, section) => sum + section.length, 0),
            capWindow: this.capWindow !== null,
            capWindowReused: this.capWindow?.capWindowReused ?? false,
            finalisationRecovery: this.finalisationRecoveryEnabled,
            activeRecordingRecovery: this.activeRecordingRecoveryStatus ?? "not-attempted",
        });

        const startedMessage: {
            type: "started";
            mode: "notes";
            finalisationRecoveryId?: string;
            activeRecordingRecovery?: "resumed" | "expired" | "not_found";
        } = { type: "started", mode: "notes" };
        if (this.finalisationRecoveryId) {
            startedMessage.finalisationRecoveryId = this.finalisationRecoveryId;
        }
        if (this.activeRecordingRecoveryStatus) {
            startedMessage.activeRecordingRecovery = this.activeRecordingRecoveryStatus;
        }
        this.send(startedMessage);
    }

    async onAudioChunk(chunk: Buffer): Promise<void> {
        if (this.closed) return;
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

        if (this.overloadSignaled) return;

        const queueLoad = this.queueLoad();
        if (queueLoad >= MAX_NOTES_TRANSCRIPTION_QUEUE_JOBS) {
            if (!this.overloadSignaled) {
                this.overloadSignaled = true;
                this.logOverload(queueLoad, chunk.length);
                this.send({
                    type: "error",
                    code: "transcription-overloaded",
                    message: "Recording processing is temporarily overloaded. Please stop and try again.",
                });
            }
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

        // Notes-only adaptive batch threshold: smaller batches early in the
        // session, then larger batches to reduce Whisper/revision pressure.
        const chunkThreshold = this.notesChunkThreshold();
        if (st.nchunks < chunkThreshold) return;

        if (!checkWebMIntegrity(st.audioBuffer) && st.webmHeader) {
            st.audioBuffer = Buffer.concat([st.webmHeader, st.audioBuffer]);
        }

        // Snapshot + reset so new chunks aren't blocked during async processing
        const captureBuffer = st.audioBuffer;
        const captureSize = captureBuffer.length;
        const captureChunkCount = st.nchunks;
        st.audioBuffer = Buffer.alloc(0);
        st.nchunks = 0;
        const passNum = ++this.passCount;
        recordUsageEvent("transcription_batch_accepted", {
            mode: "notes",
            reason: "batch",
            passNum,
            audioBufferBytes: captureSize,
            chunkCount: captureChunkCount,
            chunkThreshold,
            queueSize: this.queue.size,
            queuePending: this.queue.pending,
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
        });

        this.queue.add(async () => {
            if (this.closed) return;
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
                if (this.closed) return;
                if (batchResult.skipped) {
                    console.log(`[${this.sessionId}][notes] Pass ${passNum} — vad skip, no whisper (${Date.now() - passStart}ms)`);
                    recordUsageEvent("transcription_batch_processed", {
                        mode: "notes",
                        reason: "batch",
                        passNum,
                        skipped: true,
                        vadSkipped: true,
                        audioBufferBytes: captureSize,
                        chunkCount: captureChunkCount,
                        durationMs: Date.now() - passStart,
                    });
                    return;
                }
                const transcription = batchResult.transcript;
                console.log(`[${this.sessionId}][notes] Pass ${passNum} — whisper: ${Date.now() - t0}ms, chars: ${transcription.length}`);

                // Stage 2: Transcript revision
                const t1 = Date.now();
                const revised = await reviseTranscription(transcription, { mode: "notes" });
                if (this.closed) return;
                console.log(`[${this.sessionId}][notes] Pass ${passNum} — revise: ${Date.now() - t1}ms`);

                const wordCount = countWords(revised);
                if (wordCount < NOTES_MIN_WORD_COUNT) {
                    console.log(`[${this.sessionId}][notes] Pass ${passNum} — too short (${wordCount} words), skipping`);
                    recordUsageEvent("transcription_batch_processed", {
                        mode: "notes",
                        reason: "batch",
                        passNum,
                        skipped: true,
                        tooShort: true,
                        transcriptChars: transcription.length,
                        revisedChars: revised.length,
                        wordCount,
                        durationMs: Date.now() - passStart,
                    });
                    return;
                }

                [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);

                // Stage 3: Buffer revised transcript for the adaptive scheduler.
                // Live patch generation is no longer called per-pass — the
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
                recordUsageEvent("transcription_batch_processed", {
                    mode: "notes",
                    reason: "batch",
                    passNum,
                    skipped: false,
                    transcriptChars: transcription.length,
                    revisedChars: revised.length,
                    wordCount,
                    pendingNotesTranscriptChars: this.pendingNotesTranscript.length,
                    cumulativeTranscriptChars: st.transcript.length,
                    durationMs: e2eMs,
                });

                // Trigger scheduler — fires notes update if phase conditions are met.
                void this.maybeScheduleNotesUpdate();

            } catch (e) {
                recordUsageEvent("transcription_batch_failed", {
                    mode: "notes",
                    reason: "batch",
                    passNum,
                    durationMs: Date.now() - passStart,
                });
                console.error(`[${this.sessionId}][notes] Pass ${passNum} failed after ${Date.now() - passStart}ms — ${safeErrorInfo(e)}`);
                this.send({ type: "error", code: "transcription-failed" });
            }
        });
    }

    async onStop(): Promise<void> {
        await this.beginStop("client");
    }

    private beginStop(trigger: StopTrigger): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        if (this.closed) return Promise.resolve();
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
        this.markFinalisationRecoveryPending(trigger);
        console.log(
            `[${this.sessionId}][notes] Stop received — ` +
            `trigger: ${trigger}, queue: ${this.queue.size} queued, ${this.queue.pending} pending`
        );
        recordUsageEvent("recording_stop_start", {
            mode: "notes",
            stopReason: trigger,
            queueSize: this.queue.size,
            queuePending: this.queue.pending,
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
            currentNotesChars: st.currentMarkdown.length,
            pendingNotesTranscriptChars: this.pendingNotesTranscript.length,
            transcriptChars: st.transcript.length,
        });

        await this.queue.onIdle();
        if (this.closed) return;
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
                if (this.closed) return;
                const raw = remainingResult.transcript;
                console.log(`[${this.sessionId}][notes] Remaining whisper: ${Date.now() - t0}ms`);

                const wordCount = countWords(raw);
                if (wordCount >= NOTES_MIN_WORD_COUNT) {
                    const revised = await reviseTranscription(raw, { mode: "notes" });
                    if (this.closed) return;
                    [st.transcript, st.currTranscriptSize] = appendWithOverlap(st.transcript, revised);

                    this.pendingNotesTranscript +=
                        (this.pendingNotesTranscript.length > 0 ? "\n\n" : "") + revised;
                }
            } catch (err) {
                console.error(`[${this.sessionId}][notes] Error on remaining audio — ${safeErrorInfo(err)}`);
            }
        }

        if (this.closed) return;
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
        if (this.closed) return;

        if (this.pendingNotesTranscript.trim().length > 0) {
            const pendingBatch = this.pendingNotesTranscript;
            this.pendingNotesTranscript = "";

            const flushStart = Date.now();
            console.log(
                `[${this.sessionId}][notes] Stop flush start — pendingChars: ${pendingBatch.length}`
            );

            try {
                const patch = await generateNotesIncrementalPatch(
                    pendingBatch,
                    st.currentMarkdown,
                    st.noteStyle,
                    st.sections,
                );
                if (this.closed) return;
                if (patch.parseFailed) {
                    this.restorePendingNotesBatch(pendingBatch);
                    console.warn(
                        `[${this.sessionId}][notes] Stop flush patch parse failed — ` +
                        `pending transcript preserved, continuing finalisation`
                    );
                } else {
                    const updated = applyNotesLivePatch(st.currentMarkdown, patch);
                    st.currentMarkdown = updated;
                    this.send({ type: "notes_update", notesMarkdown: updated });
                    console.log(
                        `[${this.sessionId}][notes] Stop flush done — ` +
                        `duration: ${Date.now() - flushStart}ms, ` +
                        `outputChars: ${updated.length}`
                    );
                    recordUsageEvent("notes_live_stop_flush_complete", {
                        mode: "notes",
                        pendingChars: pendingBatch.length,
                        outputChars: updated.length,
                        durationMs: Date.now() - flushStart,
                    });
                }
            } catch (e) {
                recordUsageEvent("notes_live_stop_flush_failed", {
                    mode: "notes",
                    pendingChars: pendingBatch.length,
                    durationMs: Date.now() - flushStart,
                });
                console.error(
                    `[${this.sessionId}][notes] Stop flush failed after ` +
                    `${Date.now() - flushStart}ms — ${safeErrorInfo(e)}`
                );
                if (!this.closed) this.restorePendingNotesBatch(pendingBatch);
            }
        }

        if (this.closed) return;
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
            this.storeFinalisationRecoverySuccess(finalMarkdown, trigger, finalMs, stopMs, false);

            console.log(
                `[${this.sessionId}][notes] Final pass complete — ` +
                `finalizeNotes: ${finalMs}ms, stop-to-done: ${stopMs}ms, ` +
                `session: ${Math.round(sessionMs / 1000)}s, output: ${finalMarkdown.length} chars`
            );
            recordUsageEvent("recording_finalisation_complete", {
                mode: "notes",
                stopReason: trigger,
                finalMs,
                stopToDoneMs: stopMs,
                elapsedSessionMs: sessionMs,
                transcriptChars: st.transcript.length,
                currentNotesChars: st.currentMarkdown.length,
                outputChars: finalMarkdown.length,
                passCount: this.passCount,
            });

            st.currentMarkdown = finalMarkdown;
            if (this.closed) {
                this.closeCapWindow();
                return;
            }
            this.send({ type: "notes_final", notesMarkdown: finalMarkdown });
            this.closeCapWindow();
        } catch (err) {
            recordUsageEvent("recording_finalisation_failed", {
                mode: "notes",
                stopReason: trigger,
                elapsedSessionMs: Date.now() - this.sessionStartedAt,
                transcriptChars: st.transcript.length,
                currentNotesChars: st.currentMarkdown.length,
            });
            console.error(`[${this.sessionId}][notes] Final pass error — ${safeErrorInfo(err)}`);
            const stopMs = Date.now() - stopStart;
            this.storeFinalisationRecoverySuccess(
                st.currentMarkdown,
                trigger,
                Date.now() - finalStart,
                stopMs,
                true
            );
            if (this.closed) {
                this.closeCapWindow();
                return;
            }
            this.send({ type: "notes_final", notesMarkdown: st.currentMarkdown });
            this.closeCapWindow();
        }
    }

    onClose(): void {
        if (this.closed) return;
        const closeCapWindow = this.isStopping;
        const interruptionSnapshot = closeCapWindow
            ? null
            : this.buildActiveInterruptionSnapshot();
        const queueSizeAtClose = this.queue.size;
        const queuePendingAtClose = this.queue.pending;
        this.closed = true;
        this.clearSessionCapTimer();
        // Stop any future scheduling: an in-flight update's finally-block
        // follow-up checks isStopping, so it won't schedule after close.
        this.isStopping = true;
        this.queue.clear();
        // Clear pending buffer so a stale update can't fire on a closed socket.
        this.pendingNotesTranscript = "";
        this.notesUpdateActiveBatch = "";
        this.notesUpdateInFlight = false;
        this.notesUpdatePromise = null;
        if (closeCapWindow) {
            this.closeCapWindow();
        } else {
            this.saveActiveInterruptionSnapshot(interruptionSnapshot, queueSizeAtClose, queuePendingAtClose);
            this.markCapWindowReconnectable();
        }
        console.log(`[${this.sessionId}][notes] Handler closed`);
        recordUsageEvent("recording_session_closed", {
            mode: "notes",
            stopping: closeCapWindow,
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
            queueSize: this.queue.size,
            queuePending: this.queue.pending,
        });
    }

    private startSessionCapTimer(): void {
        this.clearSessionCapTimer();
        const capStartedAtMs = this.capWindow?.capStartedAtMs ?? this.sessionStartedAt;
        const capDeadlineMs = this.capWindow?.capDeadlineMs ?? (capStartedAtMs + MAX_NOTES_SESSION_MS);
        const remainingMs = capDeadlineMs - Date.now();
        if (remainingMs <= 0) {
            console.warn(
                `[${this.sessionId}][notes] Session cap reached immediately — ` +
                `maxMs: ${MAX_NOTES_SESSION_MS}, ` +
                `capElapsedMs: ${Date.now() - capStartedAtMs}`
            );
            recordUsageEvent("session_cap_reached", {
                mode: "notes",
                immediate: true,
                maxMs: MAX_NOTES_SESSION_MS,
                capElapsedMs: Date.now() - capStartedAtMs,
                logicalCap: this.capWindow !== null,
            });
            const timer = setTimeout(() => {
                void this.beginStop("session-cap");
            }, 0);
            timer.unref?.();
            return;
        }
        this.sessionCapTimer = setTimeout(() => {
            console.warn(
                `[${this.sessionId}][notes] Session cap reached — ` +
                `maxMs: ${MAX_NOTES_SESSION_MS}, capElapsedMs: ${Date.now() - capStartedAtMs}`
            );
            recordUsageEvent("session_cap_reached", {
                mode: "notes",
                immediate: false,
                maxMs: MAX_NOTES_SESSION_MS,
                capElapsedMs: Date.now() - capStartedAtMs,
                logicalCap: this.capWindow !== null,
            });
            void this.beginStop("session-cap");
        }, remainingMs);
        // Do not keep the process alive solely for a long safety timer.
        this.sessionCapTimer.unref?.();
        console.log(
            `[${this.sessionId}][notes] Session cap armed — ` +
            `maxMs: ${MAX_NOTES_SESSION_MS}, remainingMs: ${remainingMs}, ` +
            `logicalCap: ${this.capWindow !== null}`
        );
        recordUsageEvent("session_cap_armed", {
            mode: "notes",
            maxMs: MAX_NOTES_SESSION_MS,
            remainingMs,
            logicalCap: this.capWindow !== null,
        });
    }

    private clearSessionCapTimer(): void {
        if (!this.sessionCapTimer) return;
        clearTimeout(this.sessionCapTimer);
        this.sessionCapTimer = null;
    }

    // ── Notes-only adaptive audio batch threshold (T-012d) ────────────────────
    //
    // Returns the minimum number of buffered ~2s chunks required before a
    // Whisper/revision pass fires, based on elapsed session time. Later phases
    // taper to NOTES_DEFAULT_MIN_CHUNKS. Forms mode does not use this path.
    private notesChunkThreshold(): number {
        const elapsed = Date.now() - this.sessionStartedAt;
        for (const phase of NOTES_CHUNK_PHASES) {
            if (elapsed < phase.untilMs) return phase.minChunks;
        }
        return NOTES_DEFAULT_MIN_CHUNKS;
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
        if (this.closed) return;
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
        this.notesUpdateActiveBatch = batch;
        this.notesUpdateInFlight = true;

        const updateStart = Date.now();
        console.log(
            `[${this.sessionId}][notes] Scheduled update start — ` +
            `phase: ${phase.name}, pendingChars: ${batch.length}, ` +
            `currentMarkdownChars: ${this.st.currentMarkdown.length}`
        );
        recordUsageEvent("notes_live_patch_scheduled", {
            mode: "notes",
            phase: phase.name,
            pendingChars: batch.length,
            currentNotesChars: this.st.currentMarkdown.length,
            elapsedSessionMs: elapsed,
            timeSinceLastMs: timeSinceLast,
        });

        this.notesUpdatePromise = (async () => {
            try {
                const patch = await generateNotesIncrementalPatch(
                    batch,
                    this.st.currentMarkdown,
                    this.st.noteStyle,
                    this.st.sections,
                );
                if (this.closed) return;
                if (patch.parseFailed) {
                    this.restorePendingNotesBatch(batch);
                    console.warn(
                        `[${this.sessionId}][notes] Scheduled update patch parse failed — ` +
                        `pending transcript preserved`
                    );
                    return;
                }
                const updated = applyNotesLivePatch(this.st.currentMarkdown, patch);
                this.st.currentMarkdown = updated;
                this.lastNotesUpdateAt = Date.now();
                console.log(
                    `[${this.sessionId}][notes] Scheduled update done — ` +
                    `phase: ${phase.name}, duration: ${Date.now() - updateStart}ms, ` +
                    `outputChars: ${updated.length}`
                );
                recordUsageEvent("notes_live_patch_applied", {
                    mode: "notes",
                    phase: phase.name,
                    pendingChars: batch.length,
                    outputChars: updated.length,
                    durationMs: Date.now() - updateStart,
                });
                this.send({ type: "notes_update", notesMarkdown: updated });
            } catch (e) {
                recordUsageEvent("notes_live_patch_failed", {
                    mode: "notes",
                    phase: phase.name,
                    pendingChars: batch.length,
                    durationMs: Date.now() - updateStart,
                });
                console.error(
                    `[${this.sessionId}][notes] Scheduled update failed after ` +
                    `${Date.now() - updateStart}ms — ${safeErrorInfo(e)}`
                );
                if (!this.closed) this.restorePendingNotesBatch(batch);
            } finally {
                this.notesUpdateActiveBatch = "";
                this.notesUpdateInFlight = false;
                this.notesUpdatePromise = null;
                // One follow-up check: if enough transcript accumulated while
                // this update was running, fire another update immediately.
                // Guarded explicitly so that once Stop/Close has begun no
                // scheduler-created follow-up can run — Stop owns the single
                // flush + finalisation, and Close must not schedule after the
                // socket is gone. (maybeScheduleNotesUpdate also early-returns
                // on isStopping; this makes the boundary obvious at the call site.)
                if (!this.closed && !this.isStopping) {
                    this.maybeScheduleNotesUpdate();
                }
            }
        })();
    }

    private restorePendingNotesBatch(batch: string): void {
        if (batch.trim().length === 0) return;
        // Prepend so existing pending from work completed during the failed
        // update stays in chronological order.
        this.pendingNotesTranscript =
            batch + (this.pendingNotesTranscript.length > 0
                ? "\n\n" + this.pendingNotesTranscript
                : "");
    }

    private queueLoad(): number {
        return this.queue.size + this.queue.pending;
    }

    private logOverload(queueLoad: number, incomingChunkBytes: number): void {
        console.warn(
            `[${this.sessionId}][notes] Queue overloaded — ` +
            `queue.size: ${this.queue.size}, ` +
            `queue.pending: ${this.queue.pending}, ` +
            `queueLoad: ${queueLoad}, ` +
            `maxJobs: ${MAX_NOTES_TRANSCRIPTION_QUEUE_JOBS}, ` +
            `sessionAgeMs: ${Date.now() - this.sessionStartedAt}, ` +
            `currentMarkdownChars: ${this.st.currentMarkdown.length}, ` +
            `pendingNotesTranscriptChars: ${this.pendingNotesTranscript.length}, ` +
            `audioBufferBytes: ${this.st.audioBuffer.length}, ` +
            `incomingChunkBytes: ${incomingChunkBytes}, ` +
            `overloadSignaled: ${this.overloadSignaled}`
        );
        recordUsageEvent("recording_queue_overloaded", {
            mode: "notes",
            queueSize: this.queue.size,
            queuePending: this.queue.pending,
            queueLoad,
            maxJobs: MAX_NOTES_TRANSCRIPTION_QUEUE_JOBS,
            elapsedSessionMs: Date.now() - this.sessionStartedAt,
            currentNotesChars: this.st.currentMarkdown.length,
            pendingNotesTranscriptChars: this.pendingNotesTranscript.length,
            audioBufferBytes: this.st.audioBuffer.length,
            incomingChunkBytes,
            overloadSignaled: this.overloadSignaled,
        });
    }

    private tryClaimActiveInterruption(
        continuationRequested: boolean,
        continuationMarkdown: string
    ): NotesActiveInterruptionClaimResult | null {
        if (!continuationRequested) return null;
        if (!this.authContext.userId || !this.authContext.recordingSessionId) return null;

        const claim = this.activeInterruptionRecoveryStore.claim({
            userId: this.authContext.userId,
            recordingSessionId: this.authContext.recordingSessionId,
            backendSessionId: this.sessionId,
        });

        if (claim.status === "resumed") {
            this.restoreActiveInterruptionSnapshot(claim.snapshot, continuationMarkdown);
        }

        return claim;
    }

    private restoreActiveInterruptionSnapshot(
        snapshot: NotesActiveInterruptionSnapshot,
        continuationMarkdown: string
    ): void {
        this.st.noteStyle = snapshot.noteStyle;
        this.st.sections = [...snapshot.sections];
        this.st.currentMarkdown = continuationMarkdown.trim().length > 0
            ? continuationMarkdown
            : snapshot.currentMarkdown;
        this.st.transcript = snapshot.transcript;
        this.st.currTranscriptSize = snapshot.currTranscriptSize;
        this.pendingNotesTranscript = snapshot.pendingNotesTranscript;
        this.passCount = snapshot.passCount;
        this.sessionStartedAt = snapshot.sessionStartedAt;
        this.lastNotesUpdateAt = snapshot.lastNotesUpdateAt;

        if (snapshot.finalisationRecoveryId) {
            this.finalisationRecoveryId = snapshot.finalisationRecoveryId;
            this.finalisationRecoveryEnabled = true;
        }
    }

    private buildActiveInterruptionSnapshot(): NotesActiveInterruptionSnapshot {
        return {
            noteStyle: this.st.noteStyle,
            sections: [...this.st.sections],
            currentMarkdown: this.st.currentMarkdown,
            transcript: this.st.transcript,
            currTranscriptSize: this.st.currTranscriptSize,
            pendingNotesTranscript: joinNotesBatches(
                this.notesUpdateActiveBatch,
                this.pendingNotesTranscript
            ),
            passCount: this.passCount,
            sessionStartedAt: this.sessionStartedAt,
            lastNotesUpdateAt: this.lastNotesUpdateAt,
            finalisationRecoveryId: this.finalisationRecoveryId,
        };
    }

    private saveActiveInterruptionSnapshot(
        snapshot: NotesActiveInterruptionSnapshot | null,
        queueSize: number,
        queuePending: number
    ): void {
        if (!snapshot) return;
        if (!this.authContext.userId || !this.authContext.recordingSessionId) return;

        try {
            this.activeInterruptionRecoveryStore.save({
                userId: this.authContext.userId,
                recordingSessionId: this.authContext.recordingSessionId,
                backendSessionId: this.sessionId,
                snapshot,
                queueSize,
                queuePending,
            });
        } catch (err) {
            console.warn(
                `[${this.sessionId}][notes] Active interruption recovery unavailable — ${safeErrorInfo(err)}`
            );
            recordUsageEvent("notes_active_interruption_unavailable", {
                mode: "notes",
                reason: "save-failed",
            });
        }
    }

    private reserveFinalisationRecovery(): void {
        this.finalisationRecoveryId = null;
        this.finalisationRecoveryEnabled = false;
        if (!this.authContext.userId) return;

        try {
            const reserved = this.finalisationRecoveryStore.reserve({
                userId: this.authContext.userId,
                recordingSessionId: this.authContext.recordingSessionId,
                metadata: {
                    mode: "notes",
                    hasRecordingSessionId: Boolean(this.authContext.recordingSessionId),
                },
            });
            this.finalisationRecoveryId = reserved.recoveryId;
            this.finalisationRecoveryEnabled = true;
        } catch (err) {
            console.warn(
                `[${this.sessionId}][notes] Finalisation recovery disabled — ${safeErrorInfo(err)}`
            );
            recordUsageEvent("notes_final_recovery_unavailable", {
                mode: "notes",
                reason: "reserve-failed",
            });
        }
    }

    private markFinalisationRecoveryPending(trigger: StopTrigger): void {
        if (!this.finalisationRecoveryId) return;
        this.finalisationRecoveryStore.markPending(this.finalisationRecoveryId, {
            mode: "notes",
            stopReason: trigger,
            transcriptChars: this.st.transcript.length,
            currentNotesChars: this.st.currentMarkdown.length,
            pendingNotesTranscriptChars: this.pendingNotesTranscript.length,
            passCount: this.passCount,
        });
    }

    private storeFinalisationRecoverySuccess(
        notesMarkdown: string,
        trigger: StopTrigger,
        finalMs: number,
        stopToDoneMs: number,
        fallback: boolean
    ): void {
        if (!this.finalisationRecoveryId) return;
        this.finalisationRecoveryStore.succeed(this.finalisationRecoveryId, notesMarkdown, {
            mode: "notes",
            stopReason: trigger,
            finalMs,
            stopToDoneMs,
            transcriptChars: this.st.transcript.length,
            currentNotesChars: this.st.currentMarkdown.length,
            outputChars: notesMarkdown.length,
            fallback,
            passCount: this.passCount,
        });
    }

    private markCapWindowReconnectable(): void {
        if (!this.capWindow || this.capWindowClosed) return;
        this.capWindow.markReconnectable();
    }

    private closeCapWindow(): void {
        if (!this.capWindow || this.capWindowClosed) return;
        this.capWindow.close();
        this.capWindowClosed = true;
    }

    private send(msg: object): void {
        if (!this.closed && this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    }
}
