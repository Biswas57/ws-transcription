import { createHash } from "crypto";
import { NOTES_RECONNECT_CAP_GRACE_MS } from "./notes-cap-registry.js";
import { recordUsageEvent, shortHash } from "./safe-log.js";

export const NOTES_ACTIVE_INTERRUPTION_RECOVERY_TTL_MS = NOTES_RECONNECT_CAP_GRACE_MS;
export const NOTES_ACTIVE_INTERRUPTION_MAX_RECORDS = 100;

export type NotesActiveInterruptionSnapshot = {
    noteStyle: string;
    sections: string[];
    currentMarkdown: string;
    transcript: string;
    currTranscriptSize: number;
    pendingNotesTranscript: string;
    passCount: number;
    sessionStartedAt: number;
    lastNotesUpdateAt: number;
    finalisationRecoveryId: string | null;
};

export type NotesActiveInterruptionClaimResult =
    | { status: "resumed"; snapshot: NotesActiveInterruptionSnapshot }
    | { status: "expired" }
    | { status: "not_found" };

type StoredInterruption = {
    key: string;
    ownerHash: string;
    recordingSessionHash: string;
    interruptedAtMs: number;
    expiresAtMs: number;
    backendSessionId: string;
    snapshot: NotesActiveInterruptionSnapshot;
};

type StoreOptions = {
    now?: () => number;
    ttlMs?: number;
    maxRecords?: number;
};

type SaveInput = {
    userId: string;
    recordingSessionId: string;
    backendSessionId: string;
    snapshot: NotesActiveInterruptionSnapshot;
    queueSize: number;
    queuePending: number;
};

type ClaimInput = {
    userId: string;
    recordingSessionId: string;
    backendSessionId: string;
};

export class NotesActiveInterruptionRecoveryStore {
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly maxRecords: number;
    private readonly records = new Map<string, StoredInterruption>();

    constructor(options: StoreOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.ttlMs = options.ttlMs ?? NOTES_ACTIVE_INTERRUPTION_RECOVERY_TTL_MS;
        this.maxRecords = Math.max(1, options.maxRecords ?? NOTES_ACTIVE_INTERRUPTION_MAX_RECORDS);
    }

    save(input: SaveInput): void {
        const nowMs = this.now();
        this.cleanup(nowMs);

        while (this.records.size >= this.maxRecords) {
            this.pruneOldest();
        }

        const key = registryKey(input.userId, input.recordingSessionId);
        const record: StoredInterruption = {
            key,
            ownerHash: shortHash(`user:${input.userId}`),
            recordingSessionHash: shortHash(`recording:${input.recordingSessionId}`),
            interruptedAtMs: nowMs,
            expiresAtMs: nowMs + this.ttlMs,
            backendSessionId: input.backendSessionId,
            snapshot: cloneSnapshot(input.snapshot),
        };

        this.records.set(key, record);
        recordInterruptionEvent("notes_active_interruption_saved", record, {
            queueSize: input.queueSize,
            queuePending: input.queuePending,
            currentNotesChars: record.snapshot.currentMarkdown.length,
            transcriptChars: record.snapshot.transcript.length,
            pendingNotesTranscriptChars: record.snapshot.pendingNotesTranscript.length,
            sectionsCount: record.snapshot.sections.length,
            hasFinalisationRecoveryId: Boolean(record.snapshot.finalisationRecoveryId),
        });
    }

    claim(input: ClaimInput): NotesActiveInterruptionClaimResult {
        const nowMs = this.now();
        const key = registryKey(input.userId, input.recordingSessionId);
        const record = this.records.get(key);

        if (!record) {
            recordUsageEvent("notes_active_interruption_claim_miss", {
                mode: "notes",
                backendSessionId: input.backendSessionId,
                reason: "not_found",
                userHash: shortHash(`user:${input.userId}`),
                recordingSessionHash: shortHash(`recording:${input.recordingSessionId}`),
            });
            return { status: "not_found" };
        }

        this.records.delete(key);

        if (nowMs > record.expiresAtMs) {
            recordInterruptionEvent("notes_active_interruption_expired", record, {
                claimBackendSessionId: input.backendSessionId,
            });
            return { status: "expired" };
        }

        recordInterruptionEvent("notes_active_interruption_claimed", record, {
            claimBackendSessionId: input.backendSessionId,
            ageMs: nowMs - record.interruptedAtMs,
            remainingMs: record.expiresAtMs - nowMs,
        });
        return { status: "resumed", snapshot: cloneSnapshot(record.snapshot) };
    }

    clearForTest(): void {
        this.records.clear();
    }

    getForTest(userId: string, recordingSessionId: string): StoredInterruption | null {
        const record = this.records.get(registryKey(userId, recordingSessionId));
        return record
            ? {
                ...record,
                snapshot: cloneSnapshot(record.snapshot),
            }
            : null;
    }

    private cleanup(nowMs = this.now()): void {
        for (const [key, record] of this.records) {
            if (nowMs > record.expiresAtMs) {
                this.records.delete(key);
                recordInterruptionEvent("notes_active_interruption_pruned", record);
            }
        }
    }

    private pruneOldest(): void {
        let oldest: StoredInterruption | null = null;
        for (const record of this.records.values()) {
            if (!oldest || record.interruptedAtMs < oldest.interruptedAtMs) {
                oldest = record;
            }
        }
        if (!oldest) return;
        this.records.delete(oldest.key);
        recordInterruptionEvent("notes_active_interruption_pruned", oldest);
    }
}

export const defaultNotesActiveInterruptionRecoveryStore = new NotesActiveInterruptionRecoveryStore();

function registryKey(userId: string, recordingSessionId: string): string {
    return createHash("sha256")
        .update("notes-active-interruption")
        .update("\0")
        .update(userId)
        .update("\0")
        .update(recordingSessionId)
        .digest("hex");
}

function cloneSnapshot(snapshot: NotesActiveInterruptionSnapshot): NotesActiveInterruptionSnapshot {
    return {
        ...snapshot,
        sections: [...snapshot.sections],
    };
}

function recordInterruptionEvent(
    eventName: string,
    record: StoredInterruption,
    extra: Record<string, string | number | boolean | null | undefined> = {}
): void {
    recordUsageEvent(eventName, {
        mode: "notes",
        ownerHash: record.ownerHash,
        recordingSessionHash: record.recordingSessionHash,
        backendSessionId: record.backendSessionId,
        interruptedAtMs: record.interruptedAtMs,
        expiresAtMs: record.expiresAtMs,
        ...extra,
    });
}
