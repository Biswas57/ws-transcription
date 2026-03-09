import dotenv from "dotenv";
dotenv.config();

import { WebSocket, WebSocketServer } from "ws";
import { MAX_AUDIO_BUFFER_SIZE } from "./types.js";
import { TranscriptionHandler, StartPayload, InboundMessage } from "./types.js";
import { FormFillHandler } from "./handlers/FormFillHandler.js";
import { NotesHandler } from "./handlers/NotesHandler.js";
import { verifyWSToken } from "./ws-token.js";

const wss = new WebSocketServer({ port: 5551 });
console.log(`WebSocket server listening on ws://0.0.0.0:5551`);

// ── Optional: origin check ─────────────────────────────────────────────────
// Set ALLOWED_ORIGIN in .env to restrict connections to your web app only.
// e.g. ALLOWED_ORIGIN=https://formify-webapp.vercel.app
// Leave unset to allow all origins (useful for local dev).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

wss.on("connection", (socket: WebSocket, req) => {
    // ── Origin check (optional but recommended in production) ───────────────
    if (ALLOWED_ORIGIN) {
        const origin = req.headers.origin ?? "";
        if (origin !== ALLOWED_ORIGIN) {
            console.warn(`[app] Rejected connection from origin: ${origin}`);
            socket.close(1008, "Origin not allowed");
            return;
        }
    }

    console.log("new client connected");

    // ── Per-connection state ────────────────────────────────────────────────
    // Before a valid "start" is received, handler is null and the connection
    // will not process any audio or commands.
    let handler: TranscriptionHandler | null = null;
    let authenticated = false;

    // Safety: auto-close connections that never authenticate within 30s
    const authTimeout = setTimeout(() => {
        if (!authenticated) {
            console.warn("[app] Connection timed out waiting for authenticated start");
            socket.close(1008, "Authentication timeout");
        }
    }, 30_000);

    // ── Message routing ─────────────────────────────────────────────────────
    socket.on("message", async (data, isBinary) => {

        // Binary frame → audio chunk (only allowed after authenticated start)
        if (isBinary) {
            if (!handler || !authenticated) {
                console.warn("[app] Audio chunk received before authenticated start — ignoring");
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

        // ── start ─────────────────────────────────────────────────────────
        if (msg.action === "start") {
            const startMsg = msg as StartPayload & { token?: string };

            // ── Token validation ─────────────────────────────────────────
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
                console.warn("[app] Invalid token:", err instanceof Error ? err.message : err);
                socket.send(JSON.stringify({
                    type: "error",
                    code: "invalid-token",
                    message: "Session token is invalid or expired. Please refresh the page.",
                }));
                socket.close(1008, "Invalid token");
                return;
            }

            // Token mode must match payload mode (prevent mode-switching attacks)
            if (tokenPayload.mode !== startMsg.mode) {
                socket.send(JSON.stringify({
                    type: "error",
                    code: "mode-mismatch",
                    message: "Token mode does not match requested mode.",
                }));
                socket.close(1008, "Mode mismatch");
                return;
            }

            // Token is valid — mark authenticated and clear the auth timeout
            authenticated = true;
            clearTimeout(authTimeout);

            console.log(`[app] Authenticated — userId: ${tokenPayload.userId}, mode: ${startMsg.mode}`);

            if (!startMsg.mode) {
                socket.send(JSON.stringify({
                    type: "error",
                    code: "missing-mode",
                    message: "start payload must include 'mode': 'forms' | 'notes'",
                }));
                return;
            }

            // Clean up previous handler if reconnecting mid-session
            if (handler) {
                handler.onClose();
                handler = null;
            }

            switch (startMsg.mode) {
                case "forms":
                    handler = new FormFillHandler(socket);
                    break;
                case "notes":
                    handler = new NotesHandler(socket);
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
                console.error("[app] Handler onStart error:", err);
                socket.send(JSON.stringify({ type: "error", code: "bad-start-payload" }));
                handler = null;
            }
            return;
        }

        // ── stop ──────────────────────────────────────────────────────────
        if (msg.action === "stop") {
            if (!handler || !authenticated) {
                console.warn("[app] Received stop with no active authenticated handler");
                socket.send(JSON.stringify({ type: "error", code: "no-active-session" }));
                return;
            }

            try {
                await handler.onStop();
            } catch (err) {
                console.error("[app] Handler onStop error:", err);
                socket.send(JSON.stringify({ type: "error", code: "stop-failed" }));
            }
            return;
        }

        // Unknown action
        socket.send(JSON.stringify({
            type: "error",
            code: "unknown-action",
            message: `Unknown action "${(msg as { action: string }).action}"`,
        }));
    });

    // ── Cleanup on disconnect ───────────────────────────────────────────────
    socket.on("close", () => {
        clearTimeout(authTimeout);
        console.log("Client disconnected, cleaning up");
        if (handler) {
            handler.onClose();
            handler = null;
        }
    });

    socket.on("error", (err) => {
        clearTimeout(authTimeout);
        console.error("Socket error:", err);
        if (handler) {
            handler.onClose();
            handler = null;
        }
    });
});
