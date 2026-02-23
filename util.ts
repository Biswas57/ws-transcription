export const TRANSCRIPTION_CACHE_TTL = 60000; // 1 minute cache
export const MAX_CACHE_ENTRIES = 500;
export const MIN_CHUNK_NUM = 8;
export const MIN_WORD_COUNT = 5;
export const MAX_AUDIO_BUFFER_SIZE = 1024 * 1024 * 5; // 5MB limit

export interface FieldDef {
    block_name: string;
    field_name: string;
}

export interface WSState {
    nchunks: number;
    audioBuffer: Buffer;
    transcript: string;
    currAttributes: Record<string, string>;
    template: FieldDef[];
    webmHeader: Buffer | null;
    currTranscriptSize: number;
}

