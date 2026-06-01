import dotenv from "dotenv";
dotenv.config();
import { getVadMode, evaluateBatchVad } from "./audio/vad.js";
import type { VadDecision } from "./audio/vad.js";
import { safeErrorInfo } from "./safe-log.js";

export const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const MIN_AUDIO_SIZE_BYTES = 1000;
const MAX_RETRIES = 2;
const WHISPER_REQUEST_TIMEOUT_MS = Number(process.env.WHISPER_REQUEST_TIMEOUT_MS ?? 60_000);

export function checkWebMIntegrity(data: Buffer): boolean {
    return data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3;
}

export function extractWebMInitSegment(data: Buffer): Buffer | null {
    if (!checkWebMIntegrity(data)) {
        return null;
    }

    const clusterMarker = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
    const clusterOffset = data.indexOf(clusterMarker);

    if (clusterOffset <= 0) {
        return data;
    }

    return data.subarray(0, clusterOffset);
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

// // Optimized audio quality check
// export function hasVoiceActivity(buffer: Buffer): boolean {
//     if (buffer.length < MIN_AUDIO_SIZE_BYTES) {
//         return false;
//     }

//     // Simple audio energy check - look for variation in the data
//     let variance = 0;
//     const sampleSize = Math.min(1000, buffer.length);
//     let sum = 0;

//     for (let i = 0; i < sampleSize; i++) {
//         sum += buffer[i];
//     }
//     const mean = sum / sampleSize;

//     for (let i = 0; i < sampleSize; i++) {
//         variance += Math.pow(buffer[i] - mean, 2);
//     }
//     variance = variance / sampleSize;

//     // If variance is too low, it's likely silence or very low quality
//     return variance > 100; // Threshold for meaningful audio content
// }

export async function runWhisperOnBuffer(buffer: Buffer): Promise<string> {
    // // Pre-flight checks to avoid unnecessary API calls
    // if (!hasVoiceActivity(buffer)) {
    //     console.log("Audio quality insufficient for transcription, skipping");
    //     return "";
    // }

    let lastError: Error | null = null;

    // Implement retry logic for resilience
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const whisperForm = new FormData();
        const blob = new Blob([new Uint8Array(buffer)], { type: "audio/webm" });
        whisperForm.append("model", "whisper-1");
        whisperForm.set("file", blob, "audio.webm");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WHISPER_REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(WHISPER_API_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
                body: whisperForm,
                signal: controller.signal,
            });

            if (!res.ok) {
                await res.text();
                const err = new Error(`Whisper API error ${res.status}`);
                (err as Error & { status?: number }).status = res.status;
                throw err;
            }

            const payload = (await res.json()) as { text?: string };
            const transcription = payload.text ?? "";

            // Log successful transcription for monitoring
            console.log(`Transcription successful (attempt ${attempt}): ${transcription.length} chars`);
            return transcription;

        } catch (error) {
            lastError = error as Error;
            console.warn(`Whisper API attempt ${attempt} failed — ${safeErrorInfo(error)}`);

            // Don't retry on client errors (4xx), only on server errors or network issues
            const status = typeof (error as { status?: unknown }).status === "number"
                ? (error as { status: number }).status
                : undefined;
            if (status !== undefined && status >= 400 && status < 500) {
                break;
            }

            if (attempt < MAX_RETRIES) {
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError || new Error("All transcription attempts failed");
}

// ─── Audio batch transcription with optional VAD (T-014b) ─────────────────────
//
// transcribeAudioBatch is the single entry point handlers use to turn an audio
// batch into transcript text. It optionally runs VAD before Whisper to skip
// obvious no-speech batches, but VAD never drops usable audio: any decode/VAD
// failure falls back to Whisper, and skip only happens in gate mode under the
// conservative rule in audio/vad.ts.

export type TranscriptionMode = "notes" | "forms";
export type TranscriptionReason = "batch" | "stop";

export type AudioBatchTranscriptionResult = {
    skipped: boolean;
    transcript: string;
    whisperMs?: number;
    vad?: VadDecision;
};

function vadErrorCategory(err: unknown): string {
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("ffmpeg")) return "decode";
    if (message.includes("frame processor") || message.includes("model")) return "model";
    return "vad";
}

export async function transcribeAudioBatch(input: {
    audioBuffer: Buffer;
    sessionId: string;
    mode: TranscriptionMode;
    passNum: number;
    reason: TranscriptionReason;
}): Promise<AudioBatchTranscriptionResult> {
    const { audioBuffer, sessionId, mode, passNum, reason } = input;
    const vadMode = getVadMode();

    // off: existing Whisper path, no VAD work, no VAD logs.
    if (vadMode === "off") {
        const whisperStart = Date.now();
        const transcript = await runWhisperOnBuffer(audioBuffer);
        return { skipped: false, transcript, whisperMs: Date.now() - whisperStart };
    }

    // dry-run / gate: run VAD, emit one compact line, fail open to Whisper.
    let decision: VadDecision | undefined;
    try {
        decision = await evaluateBatchVad({ audioBuffer, passNum, reason });
        console.log(
            `[${sessionId}][${mode}] vad ` +
            `pass=${passNum} mode=${vadMode} decision=${decision.decision} ` +
            `speechMs=${decision.speechMs} batchMs=${decision.batchMs} ` +
            `peak=${decision.peakProb.toFixed(2)} mean=${decision.meanProb.toFixed(2)} ` +
            `bytes=${audioBuffer.length} decodeMs=${decision.decodeMs} vadMs=${decision.vadMs}`
        );
    } catch (err) {
        console.warn(
            `[${sessionId}][${mode}] vad fallback=whisper ` +
            `mode=${vadMode} pass=${passNum} error=${vadErrorCategory(err)} bytes=${audioBuffer.length}`
        );
    }

    // Only gate mode acts on a skip decision; dry-run always continues to Whisper.
    if (vadMode === "gate" && decision?.decision === "skip") {
        return { skipped: true, transcript: "", vad: decision };
    }

    const whisperStart = Date.now();
    const transcript = await runWhisperOnBuffer(audioBuffer);
    return { skipped: false, transcript, whisperMs: Date.now() - whisperStart, vad: decision };
}
