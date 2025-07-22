"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// test/multi-session.ts
const ws_1 = require("ws");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const WS_URL = "ws://0.0.0.0:5551";
const NUM_SESSIONS = 2; // how many start/stop cycles to test
const CHUNK_PAUSE = 800; // ms between chunks
const GAP_BETWEEN = 1000; // ms between sessions
async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}
async function runSession(ws, sessionId) {
    // tell server to start a new template / recording
    ws.send(JSON.stringify({
        action: "start",
        blocks: {
            id: ["name", "DOB", "location"]
        }
    }));
    console.log(`→ session #${sessionId} start`);
    //  stream one WebM file chunk-by-chunk
    const buf = await fs.readFile(path.join(__dirname, "sample.webm"));
    const chunkSize = Math.ceil(buf.length / 25);
    for (let i = 0; i < buf.length; i += chunkSize) {
        ws.send(buf.subarray(i, i + chunkSize));
        await delay(CHUNK_PAUSE);
    }
    //  stop
    ws.send(JSON.stringify({ action: "stop" }));
    console.log(`→ session #${sessionId} stop`);
}
async function main() {
    const ws = new ws_1.WebSocket(WS_URL);
    ws.on("message", data => {
        console.log("←", data.toString(), "\n");
    });
    ws.on("error", console.error);
    ws.on("open", async () => {
        for (let i = 1; i <= NUM_SESSIONS; i++) {
            await runSession(ws, i);
            if (i < NUM_SESSIONS)
                await delay(GAP_BETWEEN);
        }
        // Optionally close after the last session
        // await delay(500); ws.close();
    });
}
main().catch(console.error);
