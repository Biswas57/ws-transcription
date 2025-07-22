"use strict";
// No more `import FormData from "form-data";`
// If you need it for Node<18, uncomment:
// import fetch, { FormData, Blob } from "node-fetch";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPENAI_API_KEY = exports.WHISPER_API_URL = void 0;
exports.checkWebMIntegrity = checkWebMIntegrity;
exports.appendWithOverlap = appendWithOverlap;
exports.runWhisperOnBuffer = runWhisperOnBuffer;
exports.WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
exports.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
function checkWebMIntegrity(data) {
    return data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3;
}
function appendWithOverlap(base, addition) {
    const additionSize = addition.length;
    const max = Math.min(base.length, additionSize);
    for (let i = max; i > 0; i--) {
        // longest suffix of `base` that equals the prefix of `addition`
        if (base.endsWith(addition.slice(0, i))) {
            return [base + addition.slice(i), additionSize - i];
        }
    }
    return [base + addition, additionSize]; // no overlap at all
}
async function runWhisperOnBuffer(buffer) {
    const whisperForm = new FormData();
    const blob = new Blob([buffer], { type: "audio/webm" });
    whisperForm.append("model", "whisper-1");
    whisperForm.set("file", blob, "audio.webm");
    const res = await fetch(exports.WHISPER_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${exports.OPENAI_API_KEY}` },
        body: whisperForm,
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Whisper API error ${res.status}: ${err}`);
    }
    const payload = (await res.json());
    return payload.text ?? "";
}
