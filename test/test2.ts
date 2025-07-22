import { WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

async function main() {
    const ws = new WebSocket("ws://0.0.0.0:5551");

    ws.on("open", async () => {
        // init schema
        ws.send(JSON.stringify({
            action: "start",
            blocks: {
                id:
                    [
                        "name",
                        "DOB",
                        "location"
                    ]
            }
        }));

        // load a small webm
        const buf = await fs.promises.readFile(path.join(__dirname, "sample.webm"));
        const chunkSize = Math.ceil(buf.length / 50);

        for (let i = 0; i < buf.length; i += chunkSize) {
            // use subarray instead of slice
            const chunk = buf.subarray(i, i + chunkSize);
            ws.send(chunk);
            await new Promise(r => setTimeout(r, 100));  // simulate real‐time pacing
        }

        // stop
        ws.send(JSON.stringify({ action: "stop" }));
    });

    ws.on("message", data => {
        console.log("←", data.toString(), "\n\n");
    });

    ws.on("error", console.error);
}

main().catch(console.error);
