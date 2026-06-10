import { describe, expect, it, vi } from "vitest";
import { AsyncJobStore } from "../async-jobs.js";

describe("async job store", () => {
    it("creates queued jobs with opaque IDs", () => {
        const store = new AsyncJobStore({
            now: () => 1_000,
            createJobId: () => "job-opaque-1",
        });

        const job = store.create("notes-transform-summarise", {
            notesChars: 1200,
        });

        expect(job).toMatchObject({
            jobId: "job-opaque-1",
            type: "notes-transform-summarise",
            status: "queued",
            createdAt: 1_000,
            updatedAt: 1_000,
        });
        expect(job.jobId).not.toContain("notes");
    });

    it("transitions queued to running to succeeded", () => {
        let now = 1_000;
        const store = new AsyncJobStore({
            now: () => now,
            createJobId: () => "job-success",
        });

        const job = store.create("notes-transform-summarise");
        now = 1_100;
        expect(store.start(job.jobId)?.status).toBe("running");

        now = 1_500;
        const finished = store.succeed(job.jobId, { summaryMarkdown: "## Summary\n\n- Done." }, { resultChars: 19 });

        expect(finished).toMatchObject({
            status: "succeeded",
            completedAt: 1_500,
            expiresAt: 1_500 + 30 * 60 * 1000,
            result: { summaryMarkdown: "## Summary\n\n- Done." },
        });
    });

    it("transitions to failed with safe error metadata", () => {
        let now = 1_000;
        const store = new AsyncJobStore({
            now: () => now,
            createJobId: () => "job-failed",
        });

        const job = store.create("notes-transform-reorganise");
        store.start(job.jobId);
        now = 2_000;
        const failed = store.fail(job.jobId, {
            code: "transform-provider-error",
            message: "Notes transform failed.",
        });

        expect(failed).toMatchObject({
            status: "failed",
            error: {
                code: "transform-provider-error",
                message: "Notes transform failed.",
            },
            completedAt: 2_000,
        });
    });

    it("expires terminal jobs during cleanup", () => {
        let now = 1_000;
        const store = new AsyncJobStore({
            now: () => now,
            createJobId: () => "job-expired",
            terminalTtlMs: 100,
        });

        const job = store.create("notes-transform-summarise");
        store.start(job.jobId);
        store.succeed(job.jobId, { summaryMarkdown: "## Summary" });

        now = 1_101;
        const expired = store.get(job.jobId);

        expect(expired).toMatchObject({
            status: "expired",
            result: undefined,
        });
    });

    it("prunes terminal jobs before enforcing max stored jobs", () => {
        let now = 1_000;
        let id = 0;
        const store = new AsyncJobStore({
            now: () => now,
            createJobId: () => `job-${++id}`,
            maxStoredJobs: 2,
        });

        const first = store.create("notes-transform-summarise");
        store.start(first.jobId);
        store.succeed(first.jobId, { summaryMarkdown: "## Summary" });
        store.create("notes-transform-summarise");

        now = 2_000;
        const third = store.create("notes-transform-reorganise");

        expect(third.jobId).toBe("job-3");
        expect(store.get(first.jobId)).toBeNull();
    });

    it("enforces max stored jobs when no terminal jobs can be pruned", () => {
        let id = 0;
        const store = new AsyncJobStore({
            createJobId: () => `job-${++id}`,
            maxStoredJobs: 1,
        });

        store.create("notes-transform-summarise");
        expect(() => store.create("notes-transform-reorganise")).toThrow("job-store-full");
    });

    it("logs safe metadata without raw payload or result content", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const store = new AsyncJobStore({
            createJobId: () => "job-log",
        });

        try {
            const job = store.create("notes-transform-summarise", {
                notesChars: 1500,
                rawNotes: "## Private notes should not appear",
            });
            store.start(job.jobId);
            store.succeed(job.jobId, { summaryMarkdown: "## Generated output should not appear" }, { resultChars: 38 });

            const lines = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
            expect(lines).toContain("async_job_created");
            expect(lines).toContain("async_job_started");
            expect(lines).toContain("async_job_completed");
            expect(lines).toContain("notesChars: 1500");
            expect(lines).toContain("resultChars: 38");
            expect(lines).not.toContain("Private notes");
            expect(lines).not.toContain("Generated output");
        } finally {
            logSpy.mockRestore();
        }
    });
});
