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

async function withTransformHandler(
    deps: Parameters<typeof createNotesTransformRequestHandler>[0],
    fn: (request: RequestFn) => Promise<void>
): Promise<void> {
    const handler = createNotesTransformRequestHandler({
        getSecret: () => TEST_SECRET,
        now: () => 1_000,
        ...deps,
    });
    await fn((path, body, authHeader) => postJson(handler, path, body, authHeader));
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
            throw codedError("transform-output-missing-key");
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
                    code: "transform-output-missing-key",
                    message: "Notes transform output was invalid.",
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
});
