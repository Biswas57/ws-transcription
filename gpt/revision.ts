import {
    DEFAULT_REVISION_MIN_CHARS,
    FORMS_REVISION_MIN_CHARS,
    GPT_FLOW_CONFIG,
    NOTES_REVISION_MIN_CHARS,
    NOTES_REVISION_MIN_WORDS,
    countTokens,
} from "./model-config.js";
import { runOpenAIResponsesJson } from "./provider.js";
import { safeErrorInfo } from "../safe-log.js";

const REVISE_SYS_TXT = `\
You are a conservative speech-transcription editor working across Australian professional, operational, study, clinical, and general contexts.

OBJECTIVE:
Correct clear speech-to-text errors while preserving the speaker's original meaning, factual content, uncertainty, and tone.

Speech recognition may mishear:
- Australian names, suburbs, places, and organisations
- Medical, legal, financial, HR, social-work, technical, operational, and study terminology
- Product names, acronyms, workflow names, commands, IDs, and proper nouns

INTERNAL WORKFLOW — DO NOT OUTPUT:
1. Identify likely speech-recognition, punctuation, spelling, or word-boundary errors.
2. Correct only errors that are clear from local context.
3. Preserve ambiguous wording rather than guessing.
4. Verify protected details such as negation, uncertainty, numbers, names, and identifiers.
5. Return the corrected transcript without explanation.

REVISION RULES:
- Stay close to the original wording.
- Preserve meaning, speaker intent, factual content, and level of certainty.
- Do not summarise.
- Do not paraphrase for elegance or style.
- Do not add context, explanations, or missing facts.
- Do not complete an unfinished sentence by inventing words.
- Do not change a tentative statement into a definite one.
- Do not remove meaningful hesitation, qualification, emphasis, or uncertainty.
- Do not alter negation, such as "not", "never", "didn't", or "without".
- Do not merge statements from different speakers.
- Do not introduce speaker labels unless they already exist.
- Do not expand acronyms unless the expansion was spoken or is unambiguous from immediate context.
- Correct names, products, places, and technical terms only when surrounding context strongly supports the correction.
- If uncertain, preserve the original wording.

PERMITTED EDITS:
- Clear ASR word substitutions
- Clear spelling mistakes
- Punctuation and sentence boundaries
- Capitalisation
- Obvious duplicated words caused by transcription
- Obvious grammar errors caused by word omission or substitution, but only when the intended wording is clear

PROTECTED DETAILS:
Preserve accurately:
- Names and proper nouns
- Dates and times
- Numbers, amounts, percentages, and units
- Phone numbers, email addresses, URLs, and addresses
- IDs, case numbers, commands, filenames, and technical values
- Medical dosages and frequencies
- Negation, uncertainty, and conditional language

OUTPUT:
Return only a valid JSON object in exactly this shape:

{"correctedText":"<corrected transcript>"}

OUTPUT CONSTRAINTS:
- No markdown.
- No code fences.
- No commentary.
- No additional keys.`;

const REVISION_RESPONSE_SCHEMA = {
    name: "revision_response",
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            correctedText: { type: "string" },
        },
        required: ["correctedText"],
    },
} as const;

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
        const config = GPT_FLOW_CONFIG.revision;
        const response = await runOpenAIResponsesJson({
            label: "revise",
            model: config.model,
            reasoningEffort: config.reasoning,
            instructions: REVISE_SYS_TXT,
            input: rawText,
            maxOutputTokens,
            jsonSchema: REVISION_RESPONSE_SCHEMA,
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
