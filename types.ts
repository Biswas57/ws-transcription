import type { WebSocket } from "ws";

// ─── Constants ────────────────────────────────────────────────────────────────

export const TRANSCRIPTION_CACHE_TTL = 60000; // 1 minute cache
export const MAX_CACHE_ENTRIES = 500;
// MIN_CHUNK_NUM: minimum audio chunks before the first GPT pass fires.
// At 2s recorder intervals, 6 chunks = ~12s of audio before first update.
// Previously 12 chunks at 3s = ~36s — too long for meaningful real-time feel.
export const MIN_CHUNK_NUM = 10;
export const MIN_WORD_COUNT = 5;
export const MAX_AUDIO_BUFFER_SIZE = 1024 * 1024 * 5; // 5MB limit

// ─── Field definition ─────────────────────────────────────────────────────────

export interface FieldDef {
    block_name: string;
    field_name: string;
}

// ─── WS Protocol — inbound messages ──────────────────────────────────────────

export interface StartFormsPayload {
    action: "start";
    mode: "forms";
    blocks: Record<string, string[]>;
}

export interface StartNotesPayload {
    action: "start";
    mode: "notes";
    noteStyle?: "clinical" | "meeting" | "study" | "general";
    sections?: string[];
}

export type StartPayload = StartFormsPayload | StartNotesPayload;

export interface StopPayload {
    action: "stop";
}

export type InboundMessage = StartPayload | StopPayload;

// ─── WS Protocol — outbound messages ─────────────────────────────────────────

export interface StartedMessage {
    type: "started";
    mode: "forms" | "notes";
}

export interface AttributesUpdateMessage {
    type: "attributes_update";
    corrected_audio: string;
    attributes: Record<string, string>;
}

export interface FinalAttributesMessage {
    type: "final_attributes";
    corrected_audio: string;
    attributes: Record<string, string>;
}

export interface NotesUpdateMessage {
    type: "notes_update";
    notesMarkdown: string;
}

export interface NotesFinalMessage {
    type: "notes_final";
    notesMarkdown: string;
}

export interface ErrorMessage {
    type: "error";
    code: string;
    message?: string;
}

export type OutboundMessage =
    | StartedMessage
    | AttributesUpdateMessage
    | FinalAttributesMessage
    | NotesUpdateMessage
    | NotesFinalMessage
    | ErrorMessage;

// ─── Strategy interface ───────────────────────────────────────────────────────

/**
 * Every transcription mode implements this interface.
 * app.ts instantiates the correct handler on "start" and delegates
 * all subsequent events to it — it never needs to know the mode again.
 */
export interface TranscriptionHandler {
    /** Called once when the client sends { action: "start", mode: "..." } */
    onStart(payload: StartPayload): Promise<void>;

    /** Called for every audio chunk (binary WS frame) */
    onAudioChunk(chunk: Buffer): Promise<void>;

    /** Called when the client sends { action: "stop" } */
    onStop(): Promise<void>;

    /** Clean up any resources (called on socket close before stop, if needed) */
    onClose(): void;
}

// ─── Common audio state (shared by both handlers) ────────────────────────────

export interface CommonAudioState {
    nchunks: number;
    audioBuffer: Buffer;
    transcript: string;
    webmHeader: Buffer | null;
    currTranscriptSize: number;
}

export function makeAudioState(): CommonAudioState {
    return {
        nchunks: 0,
        audioBuffer: Buffer.alloc(0),
        transcript: "",
        webmHeader: null,
        currTranscriptSize: 0,
    };
}

// ─── Per-handler state shapes (for documentation / type safety) ───────────────

export interface FormFillState extends CommonAudioState {
    template: FieldDef[];
    currAttributes: Record<string, string>;
}

export interface NotesState extends CommonAudioState {
    noteStyle: string;
    sections: string[];
    currentMarkdown: string;
}

// ─── Legacy WSState alias ────────────────────────────────────────────────────
export type WSState = FormFillState;