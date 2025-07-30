import QuickLRU from "quick-lru";
import murmur2 from "murmurhash-js";

import { TRANSCRIPTION_CACHE_TTL, MAX_CACHE_ENTRIES, WSState } from "./util"

const segmentCache = new QuickLRU<string, string>({
    maxSize: MAX_CACHE_ENTRIES,
    maxAge: TRANSCRIPTION_CACHE_TTL,
});

export function createTranscriptKey(transcript: string): string {
    return murmur2(transcript).toString();
}

export function getCachedTranscript(key: string) {
    return segmentCache.get(key) ?? null;
}
export function cacheTranscript(key: string, segment: string) {
    segmentCache.set(key, segment);
}
