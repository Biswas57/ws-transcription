// No more `import FormData from "form-data";`
// If you need it for Node<18, uncomment:
// import fetch, { FormData, Blob } from "node-fetch";

export const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

export function checkWebMIntegrity(data: Buffer): boolean {
    return data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3;
}

export function appendWithOverlap(base: string, addition: string): [string, number] {
    const additionSize = addition.length
    const max = Math.min(base.length, additionSize);
    for (let i = max; i > 0; i--) {
        // longest suffix of `base` that equals the prefix of `addition`
        if (base.endsWith(addition.slice(0, i))) {
            return [base + addition.slice(i), additionSize - i];
        }
    }
    return [base + addition, additionSize];          // no overlap at all
}

export async function runWhisperOnBuffer(buffer: Buffer): Promise<string> {
    const whisperForm = new FormData();
    const blob = new Blob([buffer], { type: "audio/webm" });
    whisperForm.append("model", "whisper-1");
    whisperForm.set("file", blob, "audio.webm");

    const res = await fetch(WHISPER_API_URL, {   // ← no error now
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: whisperForm,
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Whisper API error ${res.status}: ${err}`);
    }

    const payload = (await res.json()) as { text?: string };
    return payload.text ?? "";
}
