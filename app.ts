import dotenv from "dotenv";
dotenv.config();

import { WebSocket, WebSocketServer } from "ws";
import { TranscriptionHandler, StartPayload, InboundMessage } from "./types.js";
import { FormFillHandler } from "./handlers/FormFillHandler.js";
import { NotesHandler } from "./handlers/NotesHandler.js";
import { verifyWSToken } from "./ws-token.js";

const wss = new WebSocketServer({ port: 5551 });
console.log(`[app] WebSocket server listening on ws://0.0.0.0:5551`);

// ── Optional: origin check ──────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

// ── Simple monotonic session counter for log correlation ───────────────────
// Each accepted connection gets a short ID so logs from concurrent sessions
// are attributable without logging any PII.
let sessionCounter = 0;
function nextSessionId(): string {
    return `s${(++sessionCounter).toString().padStart(4, "0")}`;
}

wss.on("connection", (socket: WebSocket, req) => {
    const sessionId = nextSessionId();
    const connectedAt = Date.now();

    // ── Origin check (optional but recommended in production) ───────────────
    if (ALLOWED_ORIGIN) {
        const origin = req.headers.origin ?? "";
        if (origin !== ALLOWED_ORIGIN) {
            console.warn(`[${sessionId}] Rejected origin: ${origin}`);
            socket.close(1008, "Origin not allowed");
            return;
        }
    }

    console.log(`[${sessionId}] Connection opened`);

    // ── Per-connection state ────────────────────────────────────────────────
    let handler: TranscriptionHandler | null = null;
    let authenticated = false;

    // ── Idle-auth timeout ───────────────────────────────────────────────────
    // Pre-connected sockets that never send a "start" (e.g. page open but user
    // hasn't pressed record yet) should not be forcefully closed — that produces
    // misleading disconnect UX. We give 5 minutes of idle patience before cleanup.
    //
    // This is safe: the JWT token is minted at record time (120s TTL) and
    // verified on "start", so a 5-min idle window doesn't grant any extra
    // auth window. The token check is still the enforcement point.
    const IDLE_AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

    const authTimeout = setTimeout(() => {
        if (!authenticated) {
            const idleMs = Date.now() - connectedAt;
            console.log(`[${sessionId}] Closing idle unauthenticated connection after ${idleMs}ms`);
            socket.close(1001, "Idle timeout — no session started");
        }
    }, IDLE_AUTH_TIMEOUT_MS);

    // ── Message routing ─────────────────────────────────────────────────────
    socket.on("message", async (data, isBinary) => {

        // Binary frame → audio chunk
        if (isBinary) {
            if (!handler || !authenticated) {
                console.warn(`[${sessionId}] Audio before auth — ignoring`);
                return;
            }
            const chunk = Buffer.from(data as Buffer);
            await handler.onAudioChunk(chunk);
            return;
        }

        // Text frame → JSON command
        let msg: InboundMessage & { token?: string };
        try {
            msg = JSON.parse(data.toString()) as InboundMessage & { token?: string };
        } catch {
            socket.send(JSON.stringify({ type: "error", code: "bad-json" }));
            return;
        }

        // ── start ────────────────────────────────────────────────────────
        if (msg.action === "start") {
            const startMsg = msg as StartPayload & { token?: string };
            const authStart = Date.now();

            console.log(`[${sessionId}] start received — mode: ${startMsg.mode}`);

            if (!startMsg.token) {
                socket.send(JSON.stringify({
                    type: "error",
                    code: "missing-token",
                    message: "start payload must include a session token",
                }));
                socket.close(1008, "Missing token");
                return;
            }

            let tokenPayload: { userId: string; mode: string };
            try {
                tokenPayload = verifyWSToken(startMsg.token);
            } catch (err) {
                console.warn(`[${sessionId}] Token invalid:`, err instanceof Error ? err.message : err);
                socket.send(JSON.stringify({
                    type: "error",
                    code: "invalid-token",
                    message: "Session token is invalid or expired. Please refresh the page.",
                }));
                socket.close(1008, "Invalid token");
                return;
            }

            if (tokenPayload.mode !== startMsg.mode) {
                socket.send(JSON.stringify({
                    type: "error",
                    code: "mode-mismatch",
                    message: "Token mode does not match requested mode.",
                }));
                socket.close(1008, "Mode mismatch");
                return;
            }

            authenticated = true;
            clearTimeout(authTimeout);

            const authMs = Date.now() - authStart;
            console.log(`[${sessionId}] Auth OK — userId: ${tokenPayload.userId}, mode: ${startMsg.mode}, auth: ${authMs}ms`);

            if (handler) {
                handler.onClose();
                handler = null;
            }

            switch (startMsg.mode) {
                case "forms":
                    handler = new FormFillHandler(socket, sessionId);
                    break;
                case "notes":
                    handler = new NotesHandler(socket, sessionId);
                    break;
                default:
                    socket.send(JSON.stringify({
                        type: "error",
                        code: "unknown-mode",
                        message: `Unknown mode "${(startMsg as { mode: string }).mode}". Use 'forms' or 'notes'.`,
                    }));
                    return;
            }

            try {
                await handler.onStart(startMsg);
            } catch (err) {
                console.error(`[${sessionId}] Handler onStart error:`, err);
                socket.send(JSON.stringify({ type: "error", code: "bad-start-payload" }));
                handler = null;
            }
            return;
        }

        // ── stop ─────────────────────────────────────────────────────────
        if (msg.action === "stop") {
            if (!handler || !authenticated) {
                console.warn(`[${sessionId}] stop with no active session`);
                socket.send(JSON.stringify({ type: "error", code: "no-active-session" }));
                return;
            }
            try {
                await handler.onStop();
            } catch (err) {
                console.error(`[${sessionId}] Handler onStop error:`, err);
                socket.send(JSON.stringify({ type: "error", code: "stop-failed" }));
            }
            return;
        }

        socket.send(JSON.stringify({
            type: "error",
            code: "unknown-action",
            message: `Unknown action "${(msg as { action: string }).action}"`,
        }));
    });

    socket.on("close", (code, reason) => {
        clearTimeout(authTimeout);
        const lifetimeMs = Date.now() - connectedAt;
        console.log(`[${sessionId}] Closed — code: ${code}, lifetime: ${lifetimeMs}ms, reason: ${reason.toString() || "(none)"}`);
        if (handler) {
            handler.onClose();
            handler = null;
        }
    });

    socket.on("error", (err) => {
        clearTimeout(authTimeout);
        console.error(`[${sessionId}] Socket error:`, err.message);
        if (handler) {
            handler.onClose();
            handler = null;
        }
    });
});