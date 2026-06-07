import { get_encoding } from "@dqbd/tiktoken";
import dotenv from "dotenv";

dotenv.config();

export const GPT_MINI_MODEL = "gpt-5.4-mini";
export const GPT_FINAL_MODEL = "gpt-5.4";
export const GPT_REVISION_REASONING_EFFORT = "none" as const;
export const GPT_LIVE_REASONING_EFFORT = "low" as const;
export const GPT_FINAL_REASONING_EFFORT = "medium" as const;
export const GPT_REQUEST_TIMEOUT_MS = Number(process.env.GPT_REQUEST_TIMEOUT_MS ?? 120_000);

export const DEFAULT_REVISION_MIN_CHARS = 15;
export const NOTES_REVISION_MIN_CHARS = 40;
export const NOTES_REVISION_MIN_WORDS = 8;
export const FORMS_REVISION_MIN_CHARS = 25;

// Forms extract discrete fields, so keep a conservative final transcript window.
export const FORM_FINAL_TRANSCRIPT_CHAR_LIMIT = 6000;

// T-005 (Phase 1): Notes summarise whole sessions, so the final pass needs to see
// the entire revised transcript. The 60-minute session cap (MAX_NOTES_SESSION_MS)
// bounds a single backend recording session; this window remains intentionally
// generous while rolling checkpoint digests (T-005 Phase 2 / Option B) are deferred.
// Sessions that approach the cap still log `truncated: true`; if the cap is ever
// raised/removed, switch to rolling checkpoint digests.
export const NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT = 80000;

// Final notes are roughly the size of the notes document, not the transcript, so
// cap the requested output regardless of how large the input transcript grows.
export const NOTES_FINAL_MAX_OUTPUT_TOKENS = 16000;
export const NOTES_FINAL_OUTPUT_TOKEN_MULTIPLIER = 1.8;
export const NOTES_FINAL_MIN_OUTPUT_TOKENS = 2048;
export const NOTES_TRANSFORM_MIN_OUTPUT_TOKENS = 1536;
export const NOTES_TRANSFORM_OUTPUT_TOKEN_PADDING = 768;
export const NOTES_SUMMARY_OUTPUT_TOKEN_MULTIPLIER = 1.1;
export const NOTES_REORGANISE_OUTPUT_TOKEN_MULTIPLIER = 1.4;

// The bundled tiktoken version in this repo does not recognize GPT-5.5 aliases yet.
const tokenCounter = get_encoding("o200k_base");

export function countTokens(text: string): number {
    return tokenCounter.encode(text).length;
}

// Preserves the beginning and end for final passes, but may drop middle content.
// With the T-005 Phase 1 window this should only trigger for unusually dense
// capped sessions; rolling checkpoint digests would remove the drop.
export function truncateTranscriptPreservingEdges(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const half = Math.floor(maxChars / 2);
    const start = text.slice(0, half);
    const end = text.slice(-half);
    return `${start}\n\n[... middle section omitted for length ...]\n\n${end}`;
}

export function notesTransformOutputBudget(inputTokens: number, multiplier: number): number {
    return Math.min(
        NOTES_FINAL_MAX_OUTPUT_TOKENS,
        Math.max(
            NOTES_TRANSFORM_MIN_OUTPUT_TOKENS,
            Math.ceil(inputTokens * multiplier) + NOTES_TRANSFORM_OUTPUT_TOKEN_PADDING
        )
    );
}

export function notesFinalOutputBudget(inputTokens: number): number {
    return Math.min(
        NOTES_FINAL_MAX_OUTPUT_TOKENS,
        Math.max(
            NOTES_FINAL_MIN_OUTPUT_TOKENS,
            Math.ceil(inputTokens * NOTES_FINAL_OUTPUT_TOKEN_MULTIPLIER)
        )
    );
}
