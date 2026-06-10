import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../parse-gpt.js", () => ({
    generateNotesSummary: vi.fn(),
    generateNotesReorganisation: vi.fn(),
    isNotesTransformError: (err: unknown) =>
        !!err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string",
}));

import { createNotesTransformRequestHandler } from "../notes-transform-routes.js";
import { AsyncJobStore } from "../async-jobs.js";

const TEST_SECRET = "notes-transform-test-secret";
const LONG_NOTES = [
    "# Project Notes",
    "",
    ...Array.from(
        { length: 90 },
        (_, index) =>
            `- Important detail ${index} includes context, actions, caveats, owners, examples, decisions, and verification notes for later review.`
    ),
].join("\n");

type RouteResult = { status: number; body: unknown };
type RequestFn = (path: string, body: unknown, authHeader?: string | null) => Promise<RouteResult>;
type GetFn = (path: string, authHeader?: string | null) => Promise<RouteResult>;

async function withTransformHandler(
    deps: Parameters<typeof createNotesTransformRequestHandler>[0],
    fn: (request: RequestFn, get: GetFn) => Promise<void>
): Promise<void> {
    const handler = createNotesTransformRequestHandler({
        getSecret: () => TEST_SECRET,
        now: () => 1_000,
        ...deps,
    });
    await fn(
        (path, body, authHeader) => postJson(handler, path, body, authHeader),
        (path, authHeader) => getJson(handler, path, authHeader)
    );
}

async function postJson(
    handler: ReturnType<typeof createNotesTransformRequestHandler>,
    path: string,
    body: unknown,
    authHeader: string | null = `Bearer ${TEST_SECRET}`
): Promise<RouteResult> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    if (authHeader !== null) headers.authorization = authHeader;

    const req = Readable.from([
        Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    ]) as IncomingMessage;
    req.method = "POST";
    req.url = path;
    req.headers = headers;

    let status = 0;
    let rawBody = "";
    const resDouble = {
        headersSent: false,
        writeHead(code: number) {
            status = code;
            resDouble.headersSent = true;
            return resDouble;
        },
        end(chunk?: unknown) {
            rawBody += chunk ? String(chunk) : "";
            return resDouble;
        },
    };
    const res = resDouble as unknown as ServerResponse;

    await handler(req, res);
    return {
        status,
        body: JSON.parse(rawBody),
    };
}

async function getJson(
    handler: ReturnType<typeof createNotesTransformRequestHandler>,
    path: string,
    authHeader: string | null = `Bearer ${TEST_SECRET}`
): Promise<RouteResult> {
    const headers: Record<string, string> = {};
    if (authHeader !== null) headers.authorization = authHeader;

    const req = Readable.from([]) as IncomingMessage;
    req.method = "GET";
    req.url = path;
    req.headers = headers;

    let status = 0;
    let rawBody = "";
    const resDouble = {
        headersSent: false,
        writeHead(code: number) {
            status = code;
            resDouble.headersSent = true;
            return resDouble;
        },
        end(chunk?: unknown) {
            rawBody += chunk ? String(chunk) : "";
            return resDouble;
        },
    };
    const res = resDouble as unknown as ServerResponse;

    await handler(req, res);
    return {
        status,
        body: JSON.parse(rawBody),
    };
}

async function flushPromises(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

function codedError(code: string): Error {
    return Object.assign(new Error(code), { code });
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("notes transform HTTP routes", () => {
    it("fails closed for missing, malformed, and invalid auth", async () => {
        const generateSummary = vi.fn(async () => ({ summaryMarkdown: "## Summary\n\n- Condensed." }));

        await withTransformHandler({ generateSummary }, async (request) => {
            for (const authHeader of [null, "Basic abc", "Bearer wrong-secret"]) {
                const result = await request(
                    "/notes/transform/summarise",
                    { notesMarkdown: LONG_NOTES },
                    authHeader
                );
                expect(result.status).toBe(401);
                expect(result.body).toEqual({
                    error: {
                        code: "unauthorised",
                        message: "Unauthorised.",
                    },
                });
            }
        });

        expect(generateSummary).not.toHaveBeenCalled();
    });

    it("fails closed when the transform secret is not configured", async () => {
        const generateSummary = vi.fn(async () => ({ summaryMarkdown: "## Summary\n\n- Condensed." }));

        await withTransformHandler({
            generateSummary,
            getSecret: () => undefined,
        }, async (request) => {
            const result = await request(
                "/notes/transform/summarise",
                { notesMarkdown: LONG_NOTES }
            );

            expect(result.status).toBe(503);
            expect(result.body).toEqual({
                error: {
                    code: "transform-service-unavailable",
                    message: "Notes transform service is unavailable.",
                },
            });
        });

        expect(generateSummary).not.toHaveBeenCalled();
    });

    it("lets valid auth reach the summarise route and returns only summaryMarkdown", async () => {
        const generateSummary = vi.fn(async () => ({ summaryMarkdown: "## Summary\n\n- Condensed." }));

        await withTransformHandler({ generateSummary }, async (request) => {
            const result = await request(
                "/notes/transform/summarise",
                { notesMarkdown: LONG_NOTES, noteStyle: "meeting" }
            );

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ summaryMarkdown: "## Summary\n\n- Condensed." });
            expect(generateSummary).toHaveBeenCalledWith({
                notesMarkdown: LONG_NOTES,
                noteStyle: "meeting",
            });
        });
    });

    it("rejects empty and too-short notes with transform-specific codes", async () => {
        await withTransformHandler({}, async (request) => {
            const empty = await request(
                "/notes/transform/summarise",
                { notesMarkdown: "   " }
            );
            expect(empty.status).toBe(400);
            expect(empty.body).toMatchObject({ error: { code: "empty-notes" } });

            const short = await request(
                "/notes/transform/reorganise",
                { notesMarkdown: "## Tiny\n\n- Not enough content." }
            );
            expect(short.status).toBe(400);
            expect(short.body).toMatchObject({ error: { code: "notes-too-short-to-reorganise" } });
        });
    });

    it("normalises duplicate and empty target sections before reorganising", async () => {
        const generateReorganisation = vi.fn(async () => ({
            reorganisedMarkdown: `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`,
        }));

        await withTransformHandler({ generateReorganisation }, async (request) => {
            const result = await request(
                "/notes/transform/reorganise",
                {
                    notesMarkdown: LONG_NOTES,
                    noteStyle: "custom-style",
                    targetSections: [" Plan ", "plan", "", "Actions", "Actions  "],
                }
            );

            expect(result.status).toBe(200);
            expect(result.body).toEqual({
                reorganisedMarkdown: `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`,
            });
            expect(generateReorganisation).toHaveBeenCalledWith({
                notesMarkdown: LONG_NOTES,
                noteStyle: "custom-style",
                targetSections: ["Plan", "Actions"],
            });
        });
    });

    it("runs auto-organise when target sections are absent or empty", async () => {
        const generateReorganisation = vi.fn(async () => ({
            reorganisedMarkdown: `${LONG_NOTES}\n\n## Next\n\n- Reorganised.`,
        }));

        await withTransformHandler({ generateReorganisation }, async (request) => {
            const absent = await request(
                "/notes/transform/reorganise",
                { notesMarkdown: LONG_NOTES }
            );
            expect(absent.status).toBe(200);
            expect(generateReorganisation).toHaveBeenLastCalledWith({
                notesMarkdown: LONG_NOTES,
                noteStyle: undefined,
                targetSections: [],
            });

            const empty = await request(
                "/notes/transform/reorganise",
                { notesMarkdown: LONG_NOTES, targetSections: ["  "] }
            );
            expect(empty.status).toBe(200);
            expect(generateReorganisation).toHaveBeenLastCalledWith({
                notesMarkdown: LONG_NOTES,
                noteStyle: undefined,
                targetSections: [],
            });
        });
    });

    it("rejects too many target sections", async () => {
        const generateReorganisation = vi.fn(async () => ({
            reorganisedMarkdown: LONG_NOTES,
        }));

        await withTransformHandler({ generateReorganisation }, async (request) => {
            const result = await request(
                "/notes/transform/reorganise",
                {
                    notesMarkdown: LONG_NOTES,
                    targetSections: Array.from({ length: 13 }, (_, index) => `Section ${index}`),
                }
            );

            expect(result.status).toBe(400);
            expect(result.body).toMatchObject({ error: { code: "too-many-target-sections" } });
        });

        expect(generateReorganisation).not.toHaveBeenCalled();
    });

    it("maps transform helper errors to safe JSON errors", async () => {
        const generateSummary = vi.fn(async () => {
            throw codedError("transform-output-incomplete");
        });
        const generateReorganisation = vi.fn(async () => {
            throw codedError("reorganise-output-too-short");
        });

        await withTransformHandler({ generateSummary, generateReorganisation }, async (request) => {
            const summary = await request(
                "/notes/transform/summarise",
                { notesMarkdown: LONG_NOTES }
            );
            expect(summary.status).toBe(500);
            expect(summary.body).toEqual({
                error: {
                    code: "transform-output-incomplete",
                    message: "Notes transform output was incomplete.",
                },
            });

            const reorganise = await request(
                "/notes/transform/reorganise",
                { notesMarkdown: LONG_NOTES }
            );
            expect(reorganise.status).toBe(400);
            expect(reorganise.body).toEqual({
                error: {
                    code: "reorganise-output-too-short",
                    message: "Reorganised notes were unexpectedly short.",
                },
            });
        });
    });

    it("creates and polls an async Summarise job", async () => {
        const jobStore = new AsyncJobStore({
            now: () => 1_000,
            createJobId: () => "job-summary-1",
        });
        const generateSummary = vi.fn(async () => ({ summaryMarkdown: "## Summary\n\n- Condensed." }));

        await withTransformHandler({ generateSummary, jobStore }, async (request, get) => {
            const created = await request(
                "/notes/transform-jobs",
                { operation: "summarise", notesMarkdown: LONG_NOTES, noteStyle: "meeting" }
            );

            expect(created.status).toBe(202);
            expect(created.body).toEqual({ jobId: "job-summary-1", status: "queued" });

            await flushPromises();
            const polled = await get("/notes/transform-jobs/job-summary-1");

            expect(polled.status).toBe(200);
            expect(polled.body).toMatchObject({
                jobId: "job-summary-1",
                type: "notes-transform-summarise",
                status: "succeeded",
                result: { summaryMarkdown: "## Summary\n\n- Condensed." },
            });
            expect(generateSummary).toHaveBeenCalledWith({
                notesMarkdown: LONG_NOTES,
                noteStyle: "meeting",
            });
        });
    });

    it("creates and polls an async Reorganise job", async () => {
        const jobStore = new AsyncJobStore({
            now: () => 1_000,
            createJobId: () => "job-reorganise-1",
        });
        const generateReorganisation = vi.fn(async () => ({
            reorganisedMarkdown: "## Reorganised\n\n- Preserved detail.",
        }));

        await withTransformHandler({ generateReorganisation, jobStore }, async (request, get) => {
            const created = await request(
                "/notes/transform-jobs",
                {
                    operation: "reorganise",
                    notesMarkdown: LONG_NOTES,
                    targetSections: ["Actions", "Risks"],
                }
            );

            expect(created.status).toBe(202);
            expect(created.body).toEqual({ jobId: "job-reorganise-1", status: "queued" });

            await flushPromises();
            const polled = await get("/notes/transform-jobs/job-reorganise-1");

            expect(polled.status).toBe(200);
            expect(polled.body).toMatchObject({
                jobId: "job-reorganise-1",
                type: "notes-transform-reorganise",
                status: "succeeded",
                result: { reorganisedMarkdown: "## Reorganised\n\n- Preserved detail." },
            });
            expect(generateReorganisation).toHaveBeenCalledWith({
                notesMarkdown: LONG_NOTES,
                noteStyle: undefined,
                targetSections: ["Actions", "Risks"],
            });
        });
    });

    it("exposes running async job state before completion", async () => {
        const jobStore = new AsyncJobStore({
            now: () => 1_000,
            createJobId: () => "job-running-1",
        });
        let resolveSummary: ((value: { summaryMarkdown: string }) => void) | undefined;
        const generateSummary = vi.fn(() => new Promise<{ summaryMarkdown: string }>((resolve) => {
            resolveSummary = resolve;
        }));

        await withTransformHandler({ generateSummary, jobStore }, async (request, get) => {
            await request(
                "/notes/transform-jobs",
                { operation: "summarise", notesMarkdown: LONG_NOTES }
            );
            await flushPromises();

            const running = await get("/notes/transform-jobs/job-running-1");
            expect(running.status).toBe(200);
            expect(running.body).toMatchObject({
                jobId: "job-running-1",
                status: "running",
            });
            expect(running.body).not.toHaveProperty("result");

            resolveSummary?.({ summaryMarkdown: "## Summary\n\n- Done." });
            await flushPromises();

            const succeeded = await get("/notes/transform-jobs/job-running-1");
            expect(succeeded.body).toMatchObject({
                status: "succeeded",
                result: { summaryMarkdown: "## Summary\n\n- Done." },
            });
        });
    });

    it("stores async transform failures safely", async () => {
        const jobStore = new AsyncJobStore({
            now: () => 1_000,
            createJobId: () => "job-failed-1",
        });
        const generateSummary = vi.fn(async () => {
            throw codedError("transform-output-incomplete");
        });

        await withTransformHandler({ generateSummary, jobStore }, async (request, get) => {
            const created = await request(
                "/notes/transform-jobs",
                { operation: "summarise", notesMarkdown: LONG_NOTES }
            );
            expect(created.status).toBe(202);

            await flushPromises();
            const failed = await get("/notes/transform-jobs/job-failed-1");

            expect(failed.status).toBe(200);
            expect(failed.body).toMatchObject({
                jobId: "job-failed-1",
                status: "failed",
                error: {
                    code: "transform-output-incomplete",
                    message: "Notes transform output was incomplete.",
                },
            });
            expect(failed.body).not.toHaveProperty("result");
        });
    });

    it("returns safe not-found for unknown async jobs", async () => {
        const jobStore = new AsyncJobStore();

        await withTransformHandler({ jobStore }, async (_request, get) => {
            const result = await get("/notes/transform-jobs/missing-job");

            expect(result.status).toBe(404);
            expect(result.body).toEqual({
                error: {
                    code: "job-not-found",
                    message: "Job not found or expired.",
                },
            });
        });
    });

    it("fails closed for async job auth and missing secret", async () => {
        const generateSummary = vi.fn(async () => ({ summaryMarkdown: "## Summary" }));

        await withTransformHandler({ generateSummary }, async (request, get) => {
            const createUnauthorised = await request(
                "/notes/transform-jobs",
                { operation: "summarise", notesMarkdown: LONG_NOTES },
                "Bearer wrong-secret"
            );
            expect(createUnauthorised.status).toBe(401);

            const pollUnauthorised = await get("/notes/transform-jobs/job-1", null);
            expect(pollUnauthorised.status).toBe(401);
        });

        await withTransformHandler({
            generateSummary,
            getSecret: () => undefined,
        }, async (request, get) => {
            const createUnavailable = await request(
                "/notes/transform-jobs",
                { operation: "summarise", notesMarkdown: LONG_NOTES }
            );
            expect(createUnavailable.status).toBe(503);

            const pollUnavailable = await get("/notes/transform-jobs/job-1");
            expect(pollUnavailable.status).toBe(503);
        });
    });

    it("does not log raw async job notes or generated markdown", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const jobStore = new AsyncJobStore({
            now: () => 1_000,
            createJobId: () => "job-log-route",
        });
        const generateSummary = vi.fn(async () => ({
            summaryMarkdown: "## Generated summary should not be logged",
        }));

        try {
            await withTransformHandler({ generateSummary, jobStore }, async (request, get) => {
                await request(
                    "/notes/transform-jobs",
                    {
                        operation: "summarise",
                        notesMarkdown: `${LONG_NOTES}\n\n- Private route note should not appear.`,
                    }
                );
                await flushPromises();
                await get("/notes/transform-jobs/job-log-route");
            });

            const lines = [
                ...logSpy.mock.calls.map((call) => String(call[0])),
                ...warnSpy.mock.calls.map((call) => String(call[0])),
            ].join("\n");

            expect(lines).toContain("job-created");
            expect(lines).toContain("async_job_completed");
            expect(lines).not.toContain("Private route note");
            expect(lines).not.toContain("Generated summary");
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });
});
