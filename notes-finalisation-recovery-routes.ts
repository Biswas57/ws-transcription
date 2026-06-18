import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    defaultNotesFinalisationRecoveryStore,
    type NotesFinalisationRecoveryLookup,
    type NotesFinalisationRecoverySnapshot,
    type NotesFinalisationRecoveryStore,
} from "./notes-finalisation-recovery.js";
import { safeErrorInfo } from "./safe-log.js";

const RECOVERY_PATH = "/notes/finalisation-recovery";
const BODY_LIMIT_BYTES = 1024 * 1024;

const SAFE_ERROR_MESSAGES: Record<string, string> = {
    "finalisation-recovery-service-unavailable": "Notes finalisation recovery service is unavailable.",
    "invalid-request": "Request body is invalid.",
    unauthorised: "Unauthorised.",
};

type FinalisationRecoveryRouteDeps = {
    getSecret?: () => string | undefined;
    store?: NotesFinalisationRecoveryStore;
};

class HttpRecoveryError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "HttpRecoveryError";
    }
}

export function createNotesFinalisationRecoveryRequestHandler(
    deps: FinalisationRecoveryRouteDeps = {}
) {
    const getSecret = deps.getSecret ?? (() => process.env.NOTES_TRANSFORM_SECRET);
    const store = deps.store ?? defaultNotesFinalisationRecoveryStore;

    return async function handleNotesFinalisationRecoveryRequest(
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<boolean> {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== RECOVERY_PATH) return false;

        if (req.method !== "POST") {
            sendJson(res, 404, { error: { code: "not-found", message: "Route not found." } });
            return true;
        }

        try {
            verifyBearerSecret(req, getSecret());
            const body = await readJsonBody(req);
            const lookup = validateRecoveryRequest(body);
            const result = store.getForOwner(lookup);
            sendJson(res, 200, serializeRecoveryResult(result));
        } catch (err) {
            const httpError = toHttpError(err);
            console.warn(
                `[notes-finalisation-recovery] failure — ` +
                `code: ${httpError.code}, error: ${safeErrorInfo(err)}`
            );
            sendJson(res, httpError.status, {
                error: {
                    code: httpError.code,
                    message: httpError.message,
                },
            });
        }
        return true;
    };
}

export const handleNotesFinalisationRecoveryRequest =
    createNotesFinalisationRecoveryRequestHandler();

function serializeRecoveryResult(result: NotesFinalisationRecoverySnapshot): object {
    switch (result.status) {
        case "pending":
            return {
                status: "pending",
                expiresAt: new Date(result.expiresAt).toISOString(),
            };
        case "succeeded":
            return {
                status: "succeeded",
                notesMarkdown: result.notesMarkdown,
                completedAt: new Date(result.completedAt).toISOString(),
                expiresAt: new Date(result.expiresAt).toISOString(),
            };
        case "failed":
            return {
                status: "failed",
                errorCode: result.errorCode,
                completedAt: new Date(result.completedAt).toISOString(),
                expiresAt: new Date(result.expiresAt).toISOString(),
            };
        case "expired":
            return { status: "expired" };
        case "not_found":
            return { status: "not_found" };
    }
}

function validateRecoveryRequest(body: unknown): NotesFinalisationRecoveryLookup {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpRecoveryError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    const raw = body as {
        recoveryId?: unknown;
        userId?: unknown;
        recordingSessionId?: unknown;
    };

    const recoveryId = validateIdentifier(raw.recoveryId);
    const userId = validateIdentifier(raw.userId);
    let recordingSessionId: string | undefined;
    if (raw.recordingSessionId !== undefined) {
        recordingSessionId = validateIdentifier(raw.recordingSessionId);
    }

    return { recoveryId, userId, recordingSessionId };
}

function validateIdentifier(value: unknown): string {
    if (typeof value !== "string") {
        throw new HttpRecoveryError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
        throw new HttpRecoveryError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }
    return trimmed;
}

function verifyBearerSecret(req: IncomingMessage, expectedSecret: string | undefined): void {
    const expected = expectedSecret?.trim();
    if (!expected) {
        throw new HttpRecoveryError(
            503,
            "finalisation-recovery-service-unavailable",
            SAFE_ERROR_MESSAGES["finalisation-recovery-service-unavailable"]
        );
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        throw new HttpRecoveryError(401, "unauthorised", SAFE_ERROR_MESSAGES.unauthorised);
    }

    const supplied = header.slice("Bearer ".length);
    if (!constantTimeEquals(supplied, expected)) {
        throw new HttpRecoveryError(401, "unauthorised", SAFE_ERROR_MESSAGES.unauthorised);
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
            throw new HttpRecoveryError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
        }
        chunks.push(buffer);
    }

    if (chunks.length === 0 || totalBytes === 0) {
        throw new HttpRecoveryError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpRecoveryError(400, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
    }
}

function toHttpError(err: unknown): HttpRecoveryError {
    if (err instanceof HttpRecoveryError) return err;
    return new HttpRecoveryError(500, "invalid-request", SAFE_ERROR_MESSAGES["invalid-request"]);
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
