// test/live-client.ts
import WebSocket from "ws";
import { spawn } from "node:child_process";
import readline from "node:readline";

type StartMsg = {
    action: "start";
    blocks: Record<string, string[]>;
};



type StopMsg = { action: "stop" };

const WS_URL = process.env.WS_URL ?? "ws://localhost:5551";

// --- Edit these blocks to match your form fields ---
const START_PAYLOAD: StartMsg = {
    action: "start",
    blocks: {
        id: ["full_name", "date_of_birth", "place_of_birth"],
        medical: ["symptoms", "diagnosis", "prescription"],
        financial: ["income", "expenses", "assets"],
    },
};

function makeFFmpegArgs(platform: NodeJS.Platform): string[] {
    // Produces WebM/Opus to stdout.

    return [
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "24k",
        "-application",
        "voip",
        "-vbr",
        "on",
        "-f",
        "webm",
        "pipe:1",
    ];

}

async function main() {
    const ws = new WebSocket(WS_URL);

    ws.on("open", () => {
        console.log(`[ws] connected -> ${WS_URL}`);
        console.log(`Commands:
  s = start (send blocks)
  r = record (start mic streaming)
  x = stop (stop mic + send stop action)
  q = quit
`);
    });

    ws.on("message", (data) => {
        // Server sends JSON strings for updates/finals.
        try {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const json = JSON.parse(text);
            console.log("[server]", JSON.stringify(json, null, 2));
        } catch {
            console.log("[server raw]", data.toString());
        }
    });

    ws.on("close", () => console.log("[ws] closed"));
    ws.on("error", (e) => console.error("[ws] error", e));

    // Simple keypress command UI
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    let ff: ReturnType<typeof spawn> | null = null;
    let recording = false;

    function startSession() {
        if (ws.readyState !== WebSocket.OPEN) {
            console.log("[client] ws not open yet");
            return;
        }
        ws.send(JSON.stringify(START_PAYLOAD));
        console.log("[client] sent start");
    }

    function startRecording() {
        if (ws.readyState !== WebSocket.OPEN) {
            console.log("[client] ws not open yet");
            return;
        }
        if (recording) {
            console.log("[client] already recording");
            return;
        }

        const args = makeFFmpegArgs(process.platform);
        console.log("[ffmpeg] starting:", ["ffmpeg", ...args].join(" "));

        ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        recording = true;

        ff.stderr?.on("data", (d) => {
            // Comment this out if too noisy
            const s = d.toString("utf8").trim();
            if (s) console.log("[ffmpeg]", s);
        });

        ff.on("exit", (code, signal) => {
            console.log(`[ffmpeg] exit code=${code} signal=${signal}`);
            ff = null;
            recording = false;
        });

        ff.stdout?.on("data", (chunk: Buffer) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(chunk);
        });

        console.log("[client] recording started (mic -> webm chunks -> ws)");
    }

    async function stopRecordingAndFlush() {
        if (!recording) {
            console.log("[client] not recording");
        } else {
            console.log("[client] stopping mic...");
            ff?.kill("SIGINT");
            // allow ffmpeg to exit and flush remaining bytes naturally
            await new Promise((r) => setTimeout(r, 300));
        }

        if (ws.readyState === WebSocket.OPEN) {
            const stopMsg: StopMsg = { action: "stop" };
            ws.send(JSON.stringify(stopMsg));
            console.log("[client] sent stop (server should flush & send final)");
        }
    }

    function quit() {
        console.log("[client] quitting...");
        if (recording) ff?.kill("SIGINT");
        ws.close();
        rl.close();
        process.exit(0);
    }

    process.stdin.on("keypress", async (_str, key) => {
        if (!key) return;

        if (key.name === "s") startSession();
        else if (key.name === "r") startRecording();
        else if (key.name === "x") await stopRecordingAndFlush();
        else if (key.name === "q" || (key.ctrl && key.name === "c")) quit();
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
