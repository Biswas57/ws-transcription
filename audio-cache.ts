import QuickLRU from 'quick-lru';
import { TRANSCRIPTION_CACHE_TTL, MAX_CACHE_ENTRIES } from "./util.js"

// INCLUDE AUDIO NORMALISATION SO THE AUDIO BYTES DON'T HAVE TO BE EXACT TO PRODUCE A CACHE HIT

const transcriptionCache = new QuickLRU<string, string>({
    maxSize: MAX_CACHE_ENTRIES,
    maxAge: TRANSCRIPTION_CACHE_TTL,
});

// Helper function to create cache key from buffer
export function createAudioKey(buffer: Buffer): string {
    return buffer.toString('base64').slice(0, 64); // Use first 64 chars as key
}

export function getCachedAudio(cacheKey: string): string | null {
    return transcriptionCache.get(cacheKey) ?? null;
}

export function cacheAudio(cacheKey: string, transcription: string): void {
    transcriptionCache.set(cacheKey, transcription);
}
