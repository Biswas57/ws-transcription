// test/multi-session.ts
import { WebSocket } from "ws";
import * as fs from "fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WS_URL = "ws://0.0.0.0:5551";
const NUM_SESSIONS = 3;        // how many start/stop cycles to test
const CHUNK_PAUSE = 100;      // ms between chunks
const GAP_BETWEEN = 100;     // ms between sessions

async function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function runSession(ws: WebSocket, sessionId: number) {
    // tell server to start a new template / recording
    ws.send(JSON.stringify({
        action: "start",
        blocks: {
            id: ["name", "DOB", "place of Birth"]
        }
    }));
    console.log(`→ session #${sessionId} start`);

    //  stream one WebM file chunk-by-chunk
    const buf = await fs.readFile(path.join(__dirname, "sample.webm"));
    const chunkSize = Math.ceil(buf.length / 29);

    for (let i = 0; i < buf.length; i += chunkSize) {
        ws.send(buf.subarray(i, i + chunkSize));
        await delay(CHUNK_PAUSE);
    }

    //  stop
    ws.send(JSON.stringify({ action: "stop" }));
    console.log(`→ session #${sessionId} stop`);
}

async function main() {
    const ws = new WebSocket(WS_URL);

    ws.on("message", data => {
        console.log("←", data.toString(), "\n");
    });
    ws.on("error", console.error);

    ws.on("open", async () => {
        for (let i = 1; i <= NUM_SESSIONS; i++) {
            await runSession(ws, i);
            if (i < NUM_SESSIONS) await delay(GAP_BETWEEN);
        }
        // Optionally close after the last session
        await delay(8000);
        ws.close();
    });
}

main().catch(console.error);
