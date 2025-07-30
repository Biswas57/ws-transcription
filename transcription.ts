export const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const MIN_AUDIO_SIZE_BYTES = 1000;
const MAX_RETRIES = 2;

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

// Optimized audio quality check
export function hasVoiceActivity(buffer: Buffer): boolean {
    if (buffer.length < MIN_AUDIO_SIZE_BYTES) {
        return false;
    }

    // Simple audio energy check - look for variation in the data
    let variance = 0;
    const sampleSize = Math.min(1000, buffer.length);
    let sum = 0;

    for (let i = 0; i < sampleSize; i++) {
        sum += buffer[i];
    }
    const mean = sum / sampleSize;

    for (let i = 0; i < sampleSize; i++) {
        variance += Math.pow(buffer[i] - mean, 2);
    }
    variance = variance / sampleSize;

    // If variance is too low, it's likely silence or very low quality
    return variance > 100; // Threshold for meaningful audio content
}

export async function runWhisperOnBuffer(buffer: Buffer): Promise<string> {
    // Pre-flight checks to avoid unnecessary API calls
    if (!hasVoiceActivity(buffer)) {
        console.log("Audio quality insufficient for transcription, skipping");
        return "";
    }

    const whisperForm = new FormData();
    const blob = new Blob([buffer], { type: "audio/webm" });
    whisperForm.append("model", "whisper-1");
    whisperForm.set("file", blob, "audio.webm");

    let lastError: Error | null = null;

    // Implement retry logic for resilience
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(WHISPER_API_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
                body: whisperForm,
            });

            if (!res.ok) {
                const err = await res.text();
                throw new Error(`Whisper API error ${res.status}: ${err}`);
            }

            const payload = (await res.json()) as { text?: string };
            const transcription = payload.text ?? "";

            // Log successful transcription for monitoring
            console.log(`Transcription successful (attempt ${attempt}): ${transcription.length} chars`);
            return transcription;

        } catch (error) {
            lastError = error as Error;
            console.warn(`Whisper API attempt ${attempt} failed:`, error);

            // Don't retry on client errors (4xx), only on server errors or network issues
            if (error instanceof Error && error.message.includes('400')) {
                break;
            }

            if (attempt < MAX_RETRIES) {
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    throw lastError || new Error("All transcription attempts failed");
}
