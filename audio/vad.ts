import type { NonRealTimeVAD } from "@ricky0123/vad-node";
import { decodeWebmOpusToPcm16kMonoFloat } from "./decode.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type VadMode = "off" | "dry-run" | "gate";
export type VadReason = "batch" | "stop";

export type VadDecision = {
    decision: "whisper" | "skip";
    speechMs: number;
    batchMs: number;
    peakProb: number;
    meanProb: number;
    decodeMs: number;
    vadMs: number;
};

// ─── v1 conservative thresholds ───────────────────────────────────────────────
// Bias strongly toward false negatives (extra Whisper calls) over false
// positives (dropping speech). A batch is only skipped when it is very clearly
// silence/no-speech.

const VAD_MIN_BATCH_MS = 3000;
const VAD_WARMUP_PASSES = 2;
const VAD_MIN_SPEECH_MS = 250;
const VAD_SKIP_MAX_MEAN_PROB = 0.08;
const VAD_SKIP_MAX_PEAK_PROB = 0.20;

// 16kHz mono PCM → 16 samples per millisecond.
const SAMPLES_PER_MS = 16;

// ─── Mode ─────────────────────────────────────────────────────────────────────

let cachedMode: VadMode | null = null;

export function getVadMode(): VadMode {
    if (cachedMode !== null) return cachedMode;
    const raw = (process.env.VAD_MODE ?? "off").trim().toLowerCase();
    cachedMode = raw === "dry-run" || raw === "gate" ? raw : "off";
    return cachedMode;
}

// ─── Lazy model init (singleton) ──────────────────────────────────────────────
// The model + onnxruntime are only loaded when VAD is actually used, so
// VAD_MODE=off never initialises anything.

let vadInitPromise: Promise<NonRealTimeVAD> | null = null;

async function getVadInstance(): Promise<NonRealTimeVAD> {
    if (!vadInitPromise) {
        vadInitPromise = (async () => {
            const mod = await import("@ricky0123/vad-node");
            // The library emits a couple of console.debug init lines; keep the
            // backend log minimal (one VAD line per batch) by muting debug only
            // during model init. warn/error are preserved.
            const originalDebug = console.debug;
            console.debug = () => undefined;
            try {
                return await mod.NonRealTimeVAD.new();
            } finally {
                console.debug = originalDebug;
            }
        })().catch((err) => {
            // Do not cache a rejected init — allow a later batch to retry.
            vadInitPromise = null;
            throw err;
        });
    }
    return vadInitPromise;
}

// ─── Serialise inference ──────────────────────────────────────────────────────
// The Silero model and frame processor hold mutable per-run state (LSTM hidden
// state, speaking flags). Concurrent sessions share one instance, so inference
// must run one batch at a time. Decode runs outside this lock.

let vadChain: Promise<unknown> = Promise.resolve();

function withVadLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = vadChain.then(fn, fn);
    vadChain = result.then(
        () => undefined,
        () => undefined
    );
    return result;
}

type FrameMetrics = { speechMs: number; peakProb: number; meanProb: number };

async function runFrameMetrics(vad: NonRealTimeVAD, pcm: Float32Array): Promise<FrameMetrics> {
    const frameProcessor = vad.frameProcessor;
    if (!frameProcessor) {
        throw new Error("VAD frame processor not initialised");
    }

    const frameSamples = vad.options.frameSamples;
    const positiveSpeechThreshold = vad.options.positiveSpeechThreshold;
    const frameMs = frameSamples / SAMPLES_PER_MS;

    let peakProb = 0;
    let probSum = 0;
    let frameCount = 0;
    let speechFrames = 0;

    frameProcessor.resume();

    for (let offset = 0; offset + frameSamples <= pcm.length; offset += frameSamples) {
        const frame = pcm.subarray(offset, offset + frameSamples);
        const { probs } = await frameProcessor.process(frame);
        if (!probs) continue;
        const isSpeech = probs.isSpeech;
        frameCount++;
        probSum += isSpeech;
        if (isSpeech > peakProb) peakProb = isSpeech;
        if (isSpeech >= positiveSpeechThreshold) speechFrames++;
    }

    // Reset model/frame state so the next batch starts clean.
    frameProcessor.endSegment();

    return {
        speechMs: Math.round(speechFrames * frameMs),
        peakProb,
        meanProb: frameCount > 0 ? probSum / frameCount : 0,
    };
}

function decideSkip(
    metrics: { speechMs: number; batchMs: number; peakProb: number; meanProb: number },
    passNum: number,
    reason: VadReason
): "whisper" | "skip" {
    const clearlyNoSpeech =
        passNum > VAD_WARMUP_PASSES &&
        reason !== "stop" &&
        metrics.batchMs >= VAD_MIN_BATCH_MS &&
        metrics.speechMs < VAD_MIN_SPEECH_MS &&
        metrics.meanProb <= VAD_SKIP_MAX_MEAN_PROB &&
        metrics.peakProb <= VAD_SKIP_MAX_PEAK_PROB;

    return clearlyNoSpeech ? "skip" : "whisper";
}

// Decode + run VAD + apply the conservative skip rule.
//
// THROWS on decode/model failure. Callers must catch and fall back to Whisper
// so VAD never drops usable audio (fail open, never fail closed).
export async function evaluateBatchVad(input: {
    audioBuffer: Buffer;
    passNum: number;
    reason: VadReason;
}): Promise<VadDecision> {
    const decodeStart = Date.now();
    const pcm = await decodeWebmOpusToPcm16kMonoFloat(input.audioBuffer);
    const decodeMs = Date.now() - decodeStart;
    const batchMs = Math.round(pcm.length / SAMPLES_PER_MS);

    const vad = await getVadInstance();

    const vadStart = Date.now();
    const metrics = await withVadLock(() => runFrameMetrics(vad, pcm));
    const vadMs = Date.now() - vadStart;

    const decision = decideSkip(
        { speechMs: metrics.speechMs, batchMs, peakProb: metrics.peakProb, meanProb: metrics.meanProb },
        input.passNum,
        input.reason
    );

    return {
        decision,
        speechMs: metrics.speechMs,
        batchMs,
        peakProb: metrics.peakProb,
        meanProb: metrics.meanProb,
        decodeMs,
        vadMs,
    };
}
