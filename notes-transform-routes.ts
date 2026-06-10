import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    generateNotesReorganisation,
    generateNotesSummary,
    isNotesTransformError,
    type GenerateNotesReorganisationArgs,
    type GenerateNotesSummaryArgs,
} from "./parse-gpt.js";
import { safeErrorInfo } from "./safe-log.js";

type TransformType = "summarise" | "reorganise";

type TransformErrorResponse = {
    error: {
        code: string;
        message: string;
    };
};

type TransformRouteDeps = {
    generateSummary?: (args: GenerateNotesSummaryArgs) => Promise<{ summaryMarkdown: string }>;
    generateReorganisation?: (args: GenerateNotesReorganisationArgs) => Promise<{ reorganisedMarkdown: string }>;
    getSecret?: () => string | undefined;
    now?: () => number;
};

type ValidatedSharedRequest = {
    notesMarkdown: string;
    noteStyle?: string;
    notesWords: number;
};

type ValidatedReorganiseRequest = ValidatedSharedRequest & {
    targetSections: string[];
};

class HttpTransformError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "HttpTransformError";
    }
}

const BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const MIN_NOTES_CHARS = 500;
const MIN_NOTES_WORDS = 80;
const MAX_TARGET_SECTIONS = 12;
const SUMMARISE_PATH = "/notes/transform/summarise";
const REORGANISE_PATH = "/notes/transform/reorganise";

const SAFE_ERROR_MESSAGES: Record<string, string> = {
    "empty-notes": "Notes markdown is required.",
    "invalid-request": "Request body is invalid.",
    "notes-too-short-to-summarise": "Notes are too short to summarise.",
    "notes-too-short-to-reorganise": "Notes are too short to reorganise.",
    "reorganise-output-too-short": "Reorganised notes were unexpectedly short.",
    "too-many-target-sections": "Too many target sections were supplied.",
    "transform-failed": "Notes transform failed.",
    "transform-output-empty": "Notes transform output was empty.",
    "transform-output-error-like": "Notes transform output was invalid.",
    "transform-output-incomplete": "Notes transform output was incomplete.",
    "transform-output-invalid-json": "Notes transform output was invalid.",
    "transform-output-missing-key": "Notes transform output was invalid.",
    "transform-output-unexpected-key": "Notes transform output was invalid.",
    "transform-provider-error": "Notes transform failed.",
    "transform-service-unavailable": "Notes transform service is unavailable.",
    unauthorised: "Unauthorised.",
};

export function createNotesTransformRequestHandler(deps: TransformRouteDeps = {}) {
    const generateSummary = deps.generateSummary ?? generateNotesSummary;
    const generateReorganisation = deps.generateReorganisation ?? generateNotesReorganisation;
    const getSecret = deps.getSecret ?? (() => process.env.NOTES_TRANSFORM_SECRET);
    const now = deps.now ?? (() => Date.now());

    return async function handleNotesTransformRequest(
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> {
        const startedAt = now();
        const url = new URL(req.url ?? "/", "http://localhost");
        const transformType = routeToTransformType(url.pathname);

        if (!transformType || req.method !== "POST") {
            sendJson(res, 404, { error: { code: "not-found", message: "Route not found." } });
            return;
        }

        let notesChars = 0;
        let notesWords = 0;
        let targetSectionCount = 0;
        let noteStyleCategory = "absent";

        try {
            verifyBearerSecret(req, getSecret());
            const body = await readJsonBody(req);

            if (transformType === "summarise") {
                const validated = validateSharedRequest(body, "summarise");
                notesChars = validated.notesMarkdown.length;
                notesWords = validated.notesWords;
                noteStyleCategory = safeNoteStyleCategory(validated.noteStyle);

                const result = await generateSummary({
                    notesMarkdown: validated.notesMarkdown,
                    noteStyle: validated.noteStyle,
                });

                logTransform("success", transformType, startedAt, now(), {
                    notesChars,
                    notesWords,
                    noteStyleCategory,
                    targetSectionCount,
                    code: "ok",
                });
                sendJson(res, 200, { summaryMarkdown: result.summaryMarkdown });
                return;
            }

            const validated = validateReorganiseRequest(body);
            notesChars = validated.notesMarkdown.length;
            notesWords = validated.notesWords;
            noteStyleCategory = safeNoteStyleCategory(validated.noteStyle);
            targetSectionCount = validated.targetSections.length;

            const result = await generateReorganisation({
                notesMarkdown: validated.notesMarkdown,
                noteStyle: validated.noteStyle,
                targetSections: validated.targetSections,
            });

            logTransform("success", transformType, startedAt, now(), {
                notesChars,
                notesWords,
                noteStyleCategory,
                targetSectionCount,
                code: "ok",
            });
            sendJson(res, 200, { reorganisedMarkdown: result.reorganisedMarkdown });
        } catch (err) {
            const httpError = toHttpError(err);
            logTransform("failure", transformType, startedAt, now(), {
                notesChars,
                notesWords,
                noteStyleCategory,
                targetSectionCount,
                code: httpError.code,
                errorInfo: safeErrorInfo(err),
            });
            sendJson(res, httpError.status, {
                error: {
                    code: httpError.code,
                    message: httpError.message,
                },
            });
        }
    };
}

export const handleNotesTransformRequest = createNotesTransformRequestHandler();

function routeToTransformType(pathname: string): TransformType | null {
    if (pathname === SUMMARISE_PATH) return "summarise";
    if (pathname === REORGANISE_PATH) return "reorganise";
    return null;
}

function verifyBearerSecret(req: IncomingMessage, expectedSecret: string | undefined): void {
    const expected = expectedSecret?.trim();
    if (!expected) {
        throw new HttpTransformError(503, "transform-service-unavailable", SAFE_ERROR_MESSAGES["transform-service-unavailable"]);
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        throw new HttpTransformError(401, "unauthorised", SAFE_ERROR_MESSAGES.unauthorised);
    }

    const supplied = header.slice("Bearer ".length);
    if (!constantTimeEquals(supplied, expected)) {
        throw new HttpTransformError(401, "unauthorised", SAFE_ERROR_MESSAGES.unauthorised);
    }
}

function constantTimeEquals(supplied: string, expected: string): boolean {
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > BODY_LIMIT_BYTES) {
            throw new HttpTransformError(400, "invalid-request", "Request body is too large.");
        }
        chunks.push(buffer);
    }

    if (chunks.length === 0 || totalBytes === 0) {
        throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }
}

function validateSharedRequest(body: unknown, transformType: TransformType): ValidatedSharedRequest {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    const raw = body as {
        notesMarkdown?: unknown;
        noteStyle?: unknown;
    };

    if (typeof raw.notesMarkdown !== "string") {
        throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    const notesMarkdown = raw.notesMarkdown.trim();
    if (!notesMarkdown) {
        throw new HttpTransformError(400, "empty-notes", SAFE_ERROR_MESSAGES["empty-notes"]);
    }

    const notesWords = countWords(notesMarkdown);
    if (notesMarkdown.length < MIN_NOTES_CHARS || notesWords < MIN_NOTES_WORDS) {
        const code = transformType === "summarise"
            ? "notes-too-short-to-summarise"
            : "notes-too-short-to-reorganise";
        throw new HttpTransformError(400, code, SAFE_ERROR_MESSAGES[code]);
    }

    let noteStyle: string | undefined;
    if (raw.noteStyle !== undefined) {
        if (typeof raw.noteStyle !== "string") {
            throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
        }
        const trimmed = raw.noteStyle.trim();
        noteStyle = trimmed.length > 0 ? trimmed : undefined;
    }

    return {
        notesMarkdown,
        noteStyle,
        notesWords,
    };
}

function validateReorganiseRequest(body: unknown): ValidatedReorganiseRequest {
    const shared = validateSharedRequest(body, "reorganise");
    const raw = body as { targetSections?: unknown };
    const targetSections = normalizeTargetSections(raw.targetSections);

    return {
        ...shared,
        targetSections,
    };
}

function normalizeTargetSections(rawTargetSections: unknown): string[] {
    if (rawTargetSections === undefined) return [];
    if (!Array.isArray(rawTargetSections)) {
        throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    const seen = new Set<string>();
    const result: string[] = [];

    for (const entry of rawTargetSections) {
        if (typeof entry !== "string") {
            throw new HttpTransformError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
        }

        const trimmed = entry.trim().replace(/\s+/g, " ");
        if (!trimmed) continue;

        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(trimmed);
    }

    if (result.length > MAX_TARGET_SECTIONS) {
        throw new HttpTransformError(400, "too-many-target-sections", SAFE_ERROR_MESSAGES["too-many-target-sections"]);
    }

    return result;
}

function toHttpError(err: unknown): HttpTransformError {
    if (err instanceof HttpTransformError) return err;

    if (isNotesTransformError(err)) {
        const status = err.code === "reorganise-output-too-short" ? 400 : 500;
        return new HttpTransformError(
            status,
            err.code,
            SAFE_ERROR_MESSAGES[err.code] ?? SAFE_ERROR_MESSAGES["transform-failed"]
        );
    }

    return new HttpTransformError(500, "transform-failed", SAFE_ERROR_MESSAGES["transform-failed"]);
}

function countWords(text: string): number {
    const trimmed = text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function safeNoteStyleCategory(noteStyle: string | undefined): string {
    if (!noteStyle) return "absent";
    const normalized = noteStyle.trim().toLowerCase();
    return ["clinical", "meeting", "study", "general"].includes(normalized) ? normalized : "custom";
}

function logTransform(
    status: "success" | "failure",
    transformType: TransformType,
    startedAt: number,
    finishedAt: number,
    metadata: {
        notesChars: number;
        notesWords: number;
        targetSectionCount: number;
        noteStyleCategory: string;
        code: string;
        errorInfo?: string;
    }
): void {
    const parts = [
        `[notes-transform] ${status}`,
        `type: ${transformType}`,
        `code: ${metadata.code}`,
        `notesChars: ${metadata.notesChars}`,
        `notesWords: ${metadata.notesWords}`,
        `targetSectionCount: ${metadata.targetSectionCount}`,
        `noteStyle: ${metadata.noteStyleCategory}`,
        `duration: ${finishedAt - startedAt}ms`,
    ];
    if (metadata.errorInfo) parts.push(`error: ${metadata.errorInfo}`);

    const line = parts.join(", ");
    if (status === "success") console.log(line);
    else console.warn(line);
}

function sendJson(res: ServerResponse, status: number, body: object): void {
    if (res.headersSent) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(json),
    });
    res.end(json);
}
