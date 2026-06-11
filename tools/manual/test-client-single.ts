import { WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { mintWSToken } from "../../ws-token.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const ws = new WebSocket(process.env.WS_URL ?? "ws://localhost:5551");

    ws.on("open", async () => {
        // init schema
        ws.send(JSON.stringify({
            action: "start",
            mode: "forms",
            token: mintWSToken("test-user", "forms"),
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
        const buf = await fs.promises.readFile(path.join(__dirname, "../../test/fixtures/sample.webm"));
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
