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
const ws_1 = require("ws");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
async function main() {
    const ws = new ws_1.WebSocket("ws://0.0.0.0:5551");
    ws.on("open", async () => {
        // init schema
        ws.send(JSON.stringify({
            action: "start",
            blocks: {
                id: [
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
            await new Promise(r => setTimeout(r, 100)); // simulate real‐time pacing
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
