// load/scenario.ts
import { WebSocket } from "ws";
import * as fs from "fs/promises";
import * as path from "path";

export interface VuResult {
    endReason: "ok" | "timeout" | "error";
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

export async function virtualUser(cfg: VuConfig): Promise<VuResult> {
    const ws = new WebSocket(cfg.serverUrl);
    const latencies: number[] = [];
    let lastSend = 0;
    let msgs = 0;
    let cacheHits = 0;
    let done = false;

    return new Promise<VuResult>((resolve) => {
        const killer = setTimeout(() => {
            done = true;
            ws.close();
            resolve({ endReason: "timeout", msgs, latencyMs: latencies, cacheHits });
        }, cfg.maxDuration);

        ws.on("open", async () => {
            // start
            ws.send(
                JSON.stringify({
                    action: "start",
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
        });

        ws.on("message", (data) => {
            msgs++;
            latencies.push(performance.now() - lastSend);
            if (data.toString().includes('"cacheHit":true')) cacheHits++;

            // Check if this is the final transcription result
            try {
                const response = JSON.parse(data.toString());
                if (response.corrected_audio && response.attributes) {
                    // We got the final result, close the connection and mark as successful
                    done = true;
                    clearTimeout(killer);
                    ws.close();
                    resolve({ endReason: "ok", msgs, latencyMs: latencies, cacheHits });
                }
            } catch (e) {
                // Not JSON or not the final result, continue
            }
        });

        ws.on("close", () => {
            if (!done) {
                clearTimeout(killer);
                resolve({ endReason: "ok", msgs, latencyMs: latencies, cacheHits });
            }
        });

        ws.on("error", () => {
            done = true;
            clearTimeout(killer);
            resolve({ endReason: "error", msgs, latencyMs: latencies, cacheHits });
        });
    });
}
