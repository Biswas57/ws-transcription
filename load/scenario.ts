// load/scenario.ts
import { WebSocket } from "ws";
import dotenv from "dotenv";
import { mintWSToken } from "../ws-token.js";

dotenv.config();

export interface VuResult {
    id: number;
    endReason: "ok" | "timeout" | "connection-error" | "auth-failure" | "server-error" | "unexpected-close" | "client-error";
    failure?: string;
    msgs: number;
    latencyMs: number[];
    cacheHits: number;
}

export interface VuConfig {
    id: number;
    audio: Buffer;
    serverUrl: string;
    maxDuration: number;        // ms
    chaos: boolean;             // enable random early closes / bad frames
}

function describeError(err: unknown): string {
    if (err && typeof err === "object") {
        const obj = err as {
            message?: unknown;
            name?: unknown;
            code?: unknown;
            address?: unknown;
            port?: unknown;
            errors?: unknown;
        };

        if (Array.isArray(obj.errors)) {
            return obj.errors.map(describeError).join("; ");
        }

        const parts: string[] = [];
        if (typeof obj.code === "string") parts.push(obj.code);
        if (typeof obj.message === "string" && obj.message) parts.push(obj.message);
        if (typeof obj.address === "string" && obj.port !== undefined) parts.push(`${obj.address}:${String(obj.port)}`);
        if (parts.length > 0) return parts.join(" ");
        if (typeof obj.name === "string") return obj.name;
    }

    return String(err) || "unknown error";
}

export async function virtualUser(cfg: VuConfig): Promise<VuResult> {
    const ws = new WebSocket(cfg.serverUrl);
    const latencies: number[] = [];
    let lastSend = 0;
    let msgs = 0;
    let cacheHits = 0;
    let done = false;
    let settled = false;
    let lastServerError = "";

    return new Promise<VuResult>((resolve) => {
        let killer: NodeJS.Timeout | undefined;

        const finish = (endReason: VuResult["endReason"], failure?: string) => {
            if (settled) return;
            settled = true;
            done = true;
            if (killer) clearTimeout(killer);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
            resolve({ id: cfg.id, endReason, failure, msgs, latencyMs: latencies, cacheHits });
        };

        killer = setTimeout(() => {
            const suffix = lastServerError ? ` Last server error: ${lastServerError}` : "";
            finish("timeout", `Timed out after ${cfg.maxDuration}ms waiting for final_attributes.${suffix}`);
        }, cfg.maxDuration);

        ws.on("open", async () => {
            try {
                // start
                ws.send(
                    JSON.stringify({
                        action: "start",
                        mode: "forms",
                        token: mintWSToken(`load-user-${cfg.id}`, "forms"),
                        blocks: { personal: ["name", "age"], contact: ["email"] },
                    })
                );

                // stream audio in 20 chunks
                const { audio } = cfg;
                const chunkSize = Math.ceil(audio.length / 20);
                for (let i = 0; i < audio.length && !done; i += chunkSize) {
                    lastSend = performance.now();
                    const slice = audio.subarray(i, i + chunkSize);
                    ws.send(slice);

                    // chaos: occasionally send garbage json
                    if (cfg.chaos && Math.random() < 0.02) ws.send("{bad json");

                    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
                }

                if (!done) ws.send(JSON.stringify({ action: "stop" }));
                // chaos: random early close
                if (cfg.chaos && Math.random() < 0.05) ws.close();
            } catch (err) {
                finish("client-error", describeError(err));
            }
        });

        ws.on("message", (data) => {
            msgs++;
            latencies.push(performance.now() - lastSend);
            if (data.toString().includes('"cacheHit":true')) cacheHits++;

            // Check if this is the final transcription result
            try {
                const response = JSON.parse(data.toString());
                if (response.type === "error") {
                    const code = String(response.code ?? "unknown");
                    const message = response.message ? `: ${response.message}` : "";
                    lastServerError = `${code}${message}`;
                    const authFailure = /token|auth|mode-mismatch/.test(code);
                    finish(authFailure ? "auth-failure" : "server-error", `Server error ${lastServerError}`);
                    return;
                }
                if (response.type === "final_attributes" && response.attributes) {
                    // We got the final result, close the connection and mark as successful
                    finish("ok");
                }
            } catch {
                // Not JSON or not the final result, continue
            }
        });

        ws.on("close", (code, reason) => {
            if (!settled) {
                const reasonText = reason.toString() || "no close reason";
                const suffix = lastServerError ? ` Last server error: ${lastServerError}` : "";
                finish("unexpected-close", `Socket closed before final_attributes. code=${code}, reason=${reasonText}.${suffix}`);
            }
        });

        ws.on("error", (err) => {
            finish("connection-error", `Could not connect to ${cfg.serverUrl}: ${describeError(err)}`);
        });
    });
}
