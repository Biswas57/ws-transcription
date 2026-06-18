import { createHash, randomUUID } from "node:crypto";
import { MAX_NOTES_SESSION_MS } from "./types.js";
import { recordUsageEvent, safeLogValue } from "./safe-log.js";

export const NOTES_FINALISATION_RECOVERY_TTL_MS = 5 * 60_000;
export const NOTES_FINALISATION_RECOVERY_PENDING_TTL_MS =
    MAX_NOTES_SESSION_MS + NOTES_FINALISATION_RECOVERY_TTL_MS;
export const NOTES_FINALISATION_RECOVERY_MAX_RECORDS = 100;

export type NotesFinalisationRecoveryStatus =
    | "pending"
    | "succeeded"
    | "failed"
    | "expired"
    | "not_found";

export type NotesFinalisationRecoveryRecord = {
    recoveryId: string;
    status: Exclude<NotesFinalisationRecoveryStatus, "not_found">;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    ownerHash: string;
    ownerHashShort: string;
    recordingSessionHash?: string;
    recordingSessionHashShort?: string;
    completedAt?: number;
    notesMarkdown?: string;
    errorCode?: string;
    metadata: Record<string, string | number | boolean | undefined>;
};

export type NotesFinalisationRecoverySnapshot =
    | {
        status: "pending";
        expiresAt: number;
    }
    | {
        status: "succeeded";
        notesMarkdown: string;
        completedAt: number;
        expiresAt: number;
    }
    | {
        status: "failed";
        errorCode: string;
        completedAt: number;
        expiresAt: number;
    }
    | {
        status: "expired";
    }
    | {
        status: "not_found";
    };

export type ReserveNotesFinalisationRecoveryInput = {
    userId: string;
    recordingSessionId?: string;
    metadata?: Record<string, string | number | boolean | undefined>;
};

export type NotesFinalisationRecoveryLookup = {
    recoveryId: string;
    userId: string;
    recordingSessionId?: string;
};

type NotesFinalisationRecoveryStoreOptions = {
    now?: () => number;
    createRecoveryId?: () => string;
    ttlMs?: number;
    pendingTtlMs?: number;
    maxRecords?: number;
};

type MatchResult = "matched" | "not-found" | "owner-mismatch";

export class NotesFinalisationRecoveryStore {
    private readonly records = new Map<string, NotesFinalisationRecoveryRecord>();
    private readonly now: () => number;
    private readonly createRecoveryId: () => string;
    private readonly ttlMs: number;
    private readonly pendingTtlMs: number;
    private readonly maxRecords: number;

    constructor(options: NotesFinalisationRecoveryStoreOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.createRecoveryId = options.createRecoveryId ?? (() => randomUUID());
        this.ttlMs = options.ttlMs ?? NOTES_FINALISATION_RECOVERY_TTL_MS;
        this.pendingTtlMs = options.pendingTtlMs ?? NOTES_FINALISATION_RECOVERY_PENDING_TTL_MS;
        this.maxRecords = options.maxRecords ?? NOTES_FINALISATION_RECOVERY_MAX_RECORDS;
    }

    reserve(input: ReserveNotesFinalisationRecoveryInput): NotesFinalisationRecoverySnapshot & { recoveryId: string } {
        this.cleanup();
        this.pruneForCapacity();
        if (this.records.size >= this.maxRecords) {
            throw new Error("finalisation-recovery-store-full");
        }

        let recoveryId = this.createRecoveryId();
        while (this.records.has(recoveryId)) recoveryId = this.createRecoveryId();

        const timestamp = this.now();
        const ownerHash = hashIdentity(`user:${input.userId}`);
        const recordingSessionHash = input.recordingSessionId
            ? hashIdentity(`recording:${input.recordingSessionId}`)
            : undefined;
        const record: NotesFinalisationRecoveryRecord = {
            recoveryId,
            status: "pending",
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: timestamp + this.pendingTtlMs,
            ownerHash,
            ownerHashShort: ownerHash.slice(0, 16),
            recordingSessionHash,
            recordingSessionHashShort: recordingSessionHash?.slice(0, 16),
            metadata: sanitizeMetadata(input.metadata ?? {}),
        };
        this.records.set(recoveryId, record);
        recordRecoveryEvent("notes_final_recovery_reserved", record);
        return {
            recoveryId,
            status: "pending",
            expiresAt: record.expiresAt,
        };
    }

    markPending(
        recoveryId: string | undefined,
        metadata: Record<string, string | number | boolean | undefined> = {}
    ): NotesFinalisationRecoverySnapshot | null {
        if (!recoveryId) return null;
        const record = this.records.get(recoveryId);
        if (!record || isTerminal(record.status)) return record ? snapshot(record) : null;

        record.status = "pending";
        record.updatedAt = this.now();
        record.metadata = {
            ...record.metadata,
            ...sanitizeMetadata(metadata),
        };
        recordRecoveryEvent("notes_final_recovery_pending", record);
        return snapshot(record);
    }

    succeed(
        recoveryId: string | undefined,
        notesMarkdown: string,
        metadata: Record<string, string | number | boolean | undefined> = {}
    ): NotesFinalisationRecoverySnapshot | null {
        if (!recoveryId) return null;
        const record = this.records.get(recoveryId);
        if (!record || isTerminal(record.status)) return record ? snapshot(record) : null;

        const timestamp = this.now();
        record.status = "succeeded";
        record.updatedAt = timestamp;
        record.completedAt = timestamp;
        record.expiresAt = timestamp + this.ttlMs;
        record.notesMarkdown = notesMarkdown;
        record.errorCode = undefined;
        record.metadata = {
            ...record.metadata,
            ...sanitizeMetadata(metadata),
        };
        recordRecoveryEvent("notes_final_recovery_succeeded", record, {
            outputChars: notesMarkdown.length,
        });
        return snapshot(record);
    }

    fail(
        recoveryId: string | undefined,
        errorCode: string,
        metadata: Record<string, string | number | boolean | undefined> = {}
    ): NotesFinalisationRecoverySnapshot | null {
        if (!recoveryId) return null;
        const record = this.records.get(recoveryId);
        if (!record || isTerminal(record.status)) return record ? snapshot(record) : null;

        const timestamp = this.now();
        record.status = "failed";
        record.updatedAt = timestamp;
        record.completedAt = timestamp;
        record.expiresAt = timestamp + this.ttlMs;
        record.notesMarkdown = undefined;
        record.errorCode = safeLogValue(errorCode) || "finalisation-failed";
        record.metadata = {
            ...record.metadata,
            ...sanitizeMetadata(metadata),
        };
        recordRecoveryEvent("notes_final_recovery_failed", record, {
            errorCode: record.errorCode,
        });
        return snapshot(record);
    }

    getForOwner(input: NotesFinalisationRecoveryLookup): NotesFinalisationRecoverySnapshot {
        this.cleanup();
        const { record, match } = this.findForOwner(input);
        if (!record || match !== "matched") {
            recordUsageEvent("notes_final_recovery_polled", {
                status: "not_found",
                ownerMatched: false,
            });
            return { status: "not_found" };
        }

        recordRecoveryEvent("notes_final_recovery_polled", record);
        return snapshot(record);
    }

    getForTest(recoveryId: string): NotesFinalisationRecoverySnapshot | null {
        this.cleanup();
        const record = this.records.get(recoveryId);
        return record ? snapshot(record) : null;
    }

    cleanup(): void {
        const timestamp = this.now();
        for (const record of this.records.values()) {
            if (record.status !== "expired" && record.expiresAt <= timestamp) {
                record.status = "expired";
                record.updatedAt = timestamp;
                record.notesMarkdown = undefined;
                record.errorCode = undefined;
                recordRecoveryEvent("notes_final_recovery_expired", record);
            }
        }
    }

    clearForTest(): void {
        this.records.clear();
    }

    private findForOwner(input: NotesFinalisationRecoveryLookup): {
        record?: NotesFinalisationRecoveryRecord;
        match: MatchResult;
    } {
        const record = this.records.get(input.recoveryId);
        if (!record) return { match: "not-found" };

        const ownerHash = hashIdentity(`user:${input.userId}`);
        if (ownerHash !== record.ownerHash) return { record, match: "owner-mismatch" };

        if (record.recordingSessionHash) {
            const suppliedSessionHash = input.recordingSessionId
                ? hashIdentity(`recording:${input.recordingSessionId}`)
                : "";
            if (suppliedSessionHash !== record.recordingSessionHash) {
                return { record, match: "owner-mismatch" };
            }
        }

        return { record, match: "matched" };
    }

    private pruneForCapacity(): void {
        if (this.records.size < this.maxRecords) return;

        const prunable = [...this.records.values()]
            .filter((record) => isTerminal(record.status))
            .sort((a, b) => a.updatedAt - b.updatedAt);

        for (const record of prunable) {
            if (this.records.size < this.maxRecords) return;
            this.records.delete(record.recoveryId);
            recordRecoveryEvent("notes_final_recovery_pruned", record);
        }
    }
}

export const defaultNotesFinalisationRecoveryStore = new NotesFinalisationRecoveryStore();

function snapshot(record: NotesFinalisationRecoveryRecord): NotesFinalisationRecoverySnapshot {
    switch (record.status) {
        case "pending":
            return {
                status: "pending",
                expiresAt: record.expiresAt,
            };
        case "succeeded":
            return {
                status: "succeeded",
                notesMarkdown: record.notesMarkdown ?? "",
                completedAt: record.completedAt ?? record.updatedAt,
                expiresAt: record.expiresAt,
            };
        case "failed":
            return {
                status: "failed",
                errorCode: record.errorCode ?? "finalisation-failed",
                completedAt: record.completedAt ?? record.updatedAt,
                expiresAt: record.expiresAt,
            };
        case "expired":
            return { status: "expired" };
    }
}

function isTerminal(status: NotesFinalisationRecoveryRecord["status"]): boolean {
    return status === "succeeded" || status === "failed" || status === "expired";
}

function hashIdentity(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function sanitizeMetadata(
    metadata: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean | undefined> {
    const safe: Record<string, string | number | boolean | undefined> = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined) continue;
        if (typeof value === "number" || typeof value === "boolean") {
            safe[key] = value;
        } else if (isSafeMetadataString(value)) {
            safe[key] = value.trim();
        }
    }
    return safe;
}

function isSafeMetadataString(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.length > 0 &&
        trimmed.length <= 80 &&
        /^[A-Za-z0-9_.:-]+$/.test(trimmed);
}

function recordRecoveryEvent(
    eventName: string,
    record: NotesFinalisationRecoveryRecord,
    extra: Record<string, string | number | boolean | undefined> = {}
): void {
    recordUsageEvent(eventName, {
        status: record.status,
        ownerHash: record.ownerHashShort,
        recordingSessionHash: record.recordingSessionHashShort,
        durationMs: record.completedAt ? record.completedAt - record.createdAt : undefined,
        expiresInMs: record.expiresAt - record.updatedAt,
        ...sanitizeMetadata(record.metadata),
        ...sanitizeMetadata(extra),
    });
}
