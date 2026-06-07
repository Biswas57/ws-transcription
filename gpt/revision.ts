import {
    DEFAULT_REVISION_MIN_CHARS,
    FORMS_REVISION_MIN_CHARS,
    GPT_MINI_MODEL,
    GPT_REVISION_REASONING_EFFORT,
    NOTES_REVISION_MIN_CHARS,
    NOTES_REVISION_MIN_WORDS,
    countTokens,
} from "./model-config.js";
import { runOpenAIResponsesJson } from "./provider.js";
import { safeErrorInfo } from "../safe-log.js";

const REVISE_SYS_TXT = `\
You are a transcription editor working in a professional Australian context. \
Meetings involve finance, healthcare, social work, and human resources. \
Whisper transcriptions often mishear: Australian names and suburbs, medical terms, \
medication names, legal terminology, financial jargon, and acronyms.

Your job:
- Fix spelling, grammar, and word substitution errors caused by speech-to-text mishearing.
- Preserve the original meaning, speaker intent, and all factual content exactly.
- Do NOT summarise, paraphrase, or remove any content.
- Do NOT add information not present in the original.

Return ONLY a pure JSON object: {"correctedText": "<corrected transcript>"}
No markdown, no code fences, no extra keys.`;

type RevisionMode = "forms" | "notes";

type RevisionOptions = {
    mode?: RevisionMode;
};

function countWords(text: string): number {
    const trimmed = text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function shouldSkipRevision(rawText: string, mode?: RevisionMode): boolean {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) return true;

    if (mode === "notes") {
        return trimmed.length < NOTES_REVISION_MIN_CHARS ||
            countWords(trimmed) < NOTES_REVISION_MIN_WORDS;
    }

    if (mode === "forms") {
        return trimmed.length < FORMS_REVISION_MIN_CHARS ||
            looksLikeShortFieldValue(trimmed);
    }

    return trimmed.length < DEFAULT_REVISION_MIN_CHARS;
}

function looksLikeShortFieldValue(text: string): boolean {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const wordCount = countWords(trimmed);

    if (wordCount > 4 || trimmed.length > 80) return false;
    if (/^(yes|no|yeah|yep|nope|nah|n\/?a|not applicable|none)$/i.test(trimmed)) return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
    if (/^\+?[\d\s().-]{6,}$/.test(trimmed) && /\d/.test(trimmed)) return true;
    if (/^\$?\d[\d,]*(?:\.\d+)?(?:\s*(?:dollars?|aud|usd))?$/i.test(trimmed)) return true;
    if (/^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(trimmed)) return true;
    if (/^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(trimmed)) return true;
    if (/^\d{1,2}\s+[a-z]+(?:\s+\d{2,4})?$/i.test(trimmed)) return true;
    if (/^[\p{L}'-]+(?:\s+[\p{L}'-]+){0,2}$/u.test(trimmed)) return true;

    const compact = lower.replace(/[\s,.$()+-]/g, "");
    const digitCount = (compact.match(/\d/g) ?? []).length;
    return compact.length > 0 && digitCount / compact.length >= 0.6;
}

export async function reviseTranscription(rawText: string, options: RevisionOptions = {}): Promise<string> {
    if (shouldSkipRevision(rawText, options.mode)) return rawText;

    const reviseStart = Date.now();
    const inputTokens = countTokens(rawText);
    const maxOutputTokens = Math.min(
        512,
        Math.max(64, Math.ceil(inputTokens * 1.3) + 32)
    );

    try {
        const response = await runOpenAIResponsesJson({
            label: "revise",
            model: GPT_MINI_MODEL,
            reasoningEffort: GPT_REVISION_REASONING_EFFORT,
            instructions: REVISE_SYS_TXT,
            input: rawText,
            maxOutputTokens,
            metadata: {
                inputChars: rawText.length,
                inputTokens,
            },
        });

        if (response.status === "incomplete") {
            console.warn(
                `[revise] Incomplete response, using original — ` +
                `inputChars: ${rawText.length}, ` +
                `outputChars: ${response.outputText.length}, ` +
                `reason: ${response.incompleteReason ?? "unknown"}, ` +
                `duration: ${response.durationMs}ms`
            );
            return rawText;
        }

        const content = response.outputText;
        if (!content) {
            console.warn(`[revise] Empty response, using original — inputChars: ${rawText.length}, duration: ${Date.now() - reviseStart}ms`);
            return rawText;
        }

        const parsed = JSON.parse(content) as { correctedText?: string };
        const revised = parsed.correctedText?.trim();
        if (!revised) {
            console.warn(`[revise] Missing correctedText key, using original — inputChars: ${rawText.length}, duration: ${Date.now() - reviseStart}ms`);
            return rawText;
        }
        console.log(`[revise] ${rawText.length} → ${revised.length} chars`);
        return revised;
    } catch (err) {
        console.warn(
            `[revise] Failed open, using original — ` +
            `inputChars: ${rawText.length}, duration: ${Date.now() - reviseStart}ms, error: ${safeErrorInfo(err)}`
        );
        return rawText;
    }
}
