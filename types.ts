import type { WebSocket } from "ws";

// ─── Constants ────────────────────────────────────────────────────────────────

export const FORMS_MIN_CHUNK_NUM = 10;
export const NOTES_MIN_WORD_COUNT = 5;
export const FORMS_MIN_TRANSCRIPT_CHARS = 1;
export const MAX_AUDIO_BUFFER_SIZE = 1024 * 1024 * 5; // 5MB limit
export const MAX_NOTES_SESSION_MS = 60 * 60_000; // 60-minute reliability/cost-safety cap
export const MAX_FORMS_TRANSCRIPTION_QUEUE_JOBS = 4;
export const MAX_NOTES_TRANSCRIPTION_QUEUE_JOBS = 6;
export const NOTES_DEFAULT_MIN_CHUNKS = 15;

// NOTES_CHUNK_PHASES: Notes-only audio batching. At ~2s recorder chunks, the
// first update can still arrive quickly, then batching tapers to reduce
// Whisper/revision pressure during established sessions. Forms mode is
// unaffected and uses FORMS_MIN_CHUNK_NUM.
export const NOTES_CHUNK_PHASES: { untilMs: number; minChunks: number }[] = [
    { untilMs: 30_000, minChunks: 3 },
    { untilMs: 60_000, minChunks: 5 },
    { untilMs: 5 * 60_000, minChunks: 10 },
];

// ─── Field definition ─────────────────────────────────────────────────────────

export interface FieldDef {
    block_name: string;
    field_name: string;
}

// ─── WS Protocol — inbound messages ──────────────────────────────────────────

export interface StartFormsPayload {
    action: "start";
    mode: "forms";
    token: string;
    blocks: Record<string, string[]>;
}

export interface StartNotesPayload {
    action: "start";
    mode: "notes";
    token: string;
    noteStyle?: "clinical" | "meeting" | "study" | "general";
    sections?: string[];
    continuation?: boolean;
    currentNotesMarkdown?: string;
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
    // Contract note: corrected_audio is intentionally not sent by this backend.
    attributes: Record<string, string>;
}

export interface FinalAttributesMessage {
    type: "final_attributes";
    // Contract note: corrected_audio is intentionally not sent by this backend.
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
