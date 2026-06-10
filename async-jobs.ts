import { randomUUID } from "node:crypto";
import { recordUsageEvent, safeLogValue } from "./safe-log.js";

export const ASYNC_JOB_TERMINAL_TTL_MS = 30 * 60 * 1000;
export const ASYNC_JOB_MAX_STORED = 100;

export type AsyncJobStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

export type AsyncJobType =
    | "notes-transform-summarise"
    | "notes-transform-reorganise"
    | "notes-final";

export type AsyncJobError = {
    code: string;
    message: string;
};

export type AsyncJobRecord<TResult = unknown> = {
    jobId: string;
    type: AsyncJobType;
    status: AsyncJobStatus;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    expiresAt?: number;
    metadata: Record<string, string | number | boolean | undefined>;
    result?: TResult;
    error?: AsyncJobError;
};

export type AsyncJobSnapshot<TResult = unknown> = AsyncJobRecord<TResult>;

type AsyncJobStoreOptions = {
    now?: () => number;
    createJobId?: () => string;
    terminalTtlMs?: number;
    maxStoredJobs?: number;
};

export class AsyncJobStore {
    private readonly jobs = new Map<string, AsyncJobRecord>();
    private readonly now: () => number;
    private readonly createJobId: () => string;
    private readonly terminalTtlMs: number;
    private readonly maxStoredJobs: number;

    constructor(options: AsyncJobStoreOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.createJobId = options.createJobId ?? (() => randomUUID());
        this.terminalTtlMs = options.terminalTtlMs ?? ASYNC_JOB_TERMINAL_TTL_MS;
        this.maxStoredJobs = options.maxStoredJobs ?? ASYNC_JOB_MAX_STORED;
    }

    create<TResult = unknown>(
        type: AsyncJobType,
        metadata: Record<string, string | number | boolean | undefined> = {}
    ): AsyncJobRecord<TResult> {
        this.cleanup();
        if (this.jobs.size >= this.maxStoredJobs) {
            this.pruneTerminalJobs();
        }
        if (this.jobs.size >= this.maxStoredJobs) {
            throw new Error("job-store-full");
        }

        const timestamp = this.now();
        let jobId = this.createJobId();
        while (this.jobs.has(jobId)) jobId = this.createJobId();

        const job: AsyncJobRecord<TResult> = {
            jobId,
            type,
            status: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            metadata,
        };

        this.jobs.set(jobId, job);
        recordJobEvent("async_job_created", job);
        return cloneJob(job);
    }

    get<TResult = unknown>(jobId: string): AsyncJobSnapshot<TResult> | null {
        this.cleanup();
        const job = this.jobs.get(jobId) as AsyncJobRecord<TResult> | undefined;
        return job ? cloneJob(job) : null;
    }

    start(jobId: string): AsyncJobSnapshot | null {
        const job = this.jobs.get(jobId);
        if (!job || isTerminal(job.status)) return job ? cloneJob(job) : null;

        job.status = "running";
        job.updatedAt = this.now();
        recordJobEvent("async_job_started", job);
        return cloneJob(job);
    }

    succeed<TResult>(jobId: string, result: TResult, metadata: { resultChars?: number } = {}): AsyncJobSnapshot<TResult> | null {
        const job = this.jobs.get(jobId) as AsyncJobRecord<TResult> | undefined;
        if (!job || isTerminal(job.status)) return job ? cloneJob(job) : null;

        const timestamp = this.now();
        job.status = "succeeded";
        job.updatedAt = timestamp;
        job.completedAt = timestamp;
        job.expiresAt = timestamp + this.terminalTtlMs;
        job.result = result;
        recordJobEvent("async_job_completed", job, metadata);
        return cloneJob(job);
    }

    fail(jobId: string, error: AsyncJobError): AsyncJobSnapshot | null {
        const job = this.jobs.get(jobId);
        if (!job || isTerminal(job.status)) return job ? cloneJob(job) : null;

        const timestamp = this.now();
        job.status = "failed";
        job.updatedAt = timestamp;
        job.completedAt = timestamp;
        job.expiresAt = timestamp + this.terminalTtlMs;
        job.error = {
            code: safeJobString(error.code, "transform-failed"),
            message: error.message,
        };
        recordJobEvent("async_job_failed", job, { errorCode: job.error.code });
        return cloneJob(job);
    }

    cleanup(): void {
        const timestamp = this.now();
        for (const job of this.jobs.values()) {
            if (isTerminal(job.status) && job.status !== "expired" && job.expiresAt && job.expiresAt <= timestamp) {
                job.status = "expired";
                job.updatedAt = timestamp;
                job.result = undefined;
                recordJobEvent("async_job_expired", job);
            }
        }
    }

    private pruneTerminalJobs(): void {
        const terminalJobs = [...this.jobs.values()]
            .filter((job) => isTerminal(job.status))
            .sort((a, b) => a.updatedAt - b.updatedAt);

        for (const job of terminalJobs) {
            if (this.jobs.size < this.maxStoredJobs) return;
            this.jobs.delete(job.jobId);
            recordJobEvent("async_job_pruned", job);
        }
    }
}

export const defaultAsyncJobStore = new AsyncJobStore();

function isTerminal(status: AsyncJobStatus): boolean {
    return status === "succeeded" || status === "failed" || status === "expired";
}

function cloneJob<TResult>(job: AsyncJobRecord<TResult>): AsyncJobRecord<TResult> {
    return {
        ...job,
        metadata: { ...job.metadata },
        error: job.error ? { ...job.error } : undefined,
    };
}

function recordJobEvent(
    eventName: string,
    job: AsyncJobRecord,
    extra: Record<string, string | number | boolean | undefined> = {}
): void {
    recordUsageEvent(eventName, {
        jobType: job.type,
        status: job.status,
        durationMs: job.completedAt ? job.completedAt - job.createdAt : undefined,
        ...sanitizeJobMetadata(job.metadata),
        ...sanitizeJobMetadata(extra),
    });
}

function sanitizeJobMetadata(
    metadata: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean | undefined> {
    const safe: Record<string, string | number | boolean | undefined> = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined) continue;
        if (typeof value === "number" || typeof value === "boolean") {
            safe[key] = value;
        } else {
            safe[key] = safeJobString(value, "unknown");
        }
    }
    return safe;
}

function safeJobString(value: string, fallback: string): string {
    const safe = safeLogValue(value);
    return safe.length > 0 ? safe : fallback;
}
