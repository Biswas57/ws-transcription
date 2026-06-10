import { type FieldDef, FORMS_MIN_TRANSCRIPT_CHARS } from "../types.js";
import {
    FORM_FINAL_TRANSCRIPT_CHAR_LIMIT,
    GPT_FINAL_MODEL,
    GPT_FINAL_REASONING_EFFORT,
    GPT_LIVE_REASONING_EFFORT,
    GPT_MINI_MODEL,
    GPT_REQUEST_TIMEOUT_MS,
    truncateTranscriptPreservingEdges,
} from "./model-config.js";
import { extractJsonObjectText, isRecord } from "./json-parsing.js";
import { openai, runOpenAIResponsesJson } from "./provider.js";
import {
    formatSafeJsonKeys,
    recordUsageEvent,
    safeErrorInfo,
    safeJsonKeys,
    safeUsageMetadata,
} from "../safe-log.js";

export const EXTRACT_SYS_TXT = `\
You are a structured data extraction agent working across Australian professional, operational, study, and general contexts.

You are given:
1. allowed_keys — the EXACT list of snake_case field keys you are allowed to return.
2. current_values — already-recorded values for each field (may be empty strings).
3. transcript_segment — a corrected segment of a meeting/transcript.

KEY RULES:
- You MUST use ONLY keys from allowed_keys. Do not invent, rename, or reformat any key.
- Keys are SEMANTIC LABELS, not literal phrases. People do not usually say field names.
  Examples of how people express information:
  • "date_of_birth" → "I was born on the 3rd of March 1985" or "I'm 38 years old"
  • "chief_complaint" → "the reason I came in today is..." or "I've been having chest pain"
  • "medications" → "I'm currently on metformin and lisinopril"
  • "occupation" → "I work as a..." or "I'm a nurse at RPA"
  • "address" → "I live at 14 Smith Street, Penrith"

EXTRACTION RULES:
- Return a SPARSE object — only include fields where you found new or updated information.
- Do NOT return a field if the current_value is already correct and complete.
- Do NOT guess or infer beyond what is explicitly stated or strongly implied in the transcript.
- Only fill a field if the transcript clearly answers that exact field.
- Short values such as "yes", "no", names, dates, times, dollar amounts, phone numbers, and "N/A" can be complete valid answers when they clearly answer the field.
- If information appears to belong to a missing, locked, or excluded field, ignore it rather than forcing it into another available field.
- Do NOT use a semantically nearby allowed key as a fallback.
- A street address must not be placed into living_situation. living_situation means household arrangement, such as lives alone, with parents, with spouse, supported accommodation, homeless, etc.
- Do NOT populate a field from vague, ambiguous, or off-topic speech.
- If a returned value would be worse, less complete, or less specific than the existing current_value, omit that field.
- Live extraction should be conservative. It is better to omit uncertain information than to fill the wrong field.

Return ONLY a pure JSON object:
{"parsedAttributes": {"snake_case_key": "value", ...}}

Only keys from allowed_keys. No markdown, no code fences, no extra keys.`;

export const FINAL_SYS_TXT = `\
You are a final verification agent for structured form extraction across Australian professional, operational, study, and general contexts.

You are given:
1. allowed_keys — the EXACT list of snake_case field keys you must return. Every key must appear in output.
2. current_values — current extracted values from incremental passes.
3. full_transcript — the complete meeting/transcript available for final review. It may be truncated in the middle for length.

YOUR TASK:
Do a careful final pass over the transcript and current values.
Produce the most accurate, complete value for every field in allowed_keys.

KEY RULES:
- You MUST return EVERY key in allowed_keys — no omissions.
- Use ONLY keys from allowed_keys. Do not invent, rename, or reformat any key.
- Keys are SEMANTIC LABELS. Extract from natural language, not literal key name matches.
- Important: the start of the transcript often contains critical details such as names, dates, addresses, and context that may not be repeated.

EXTRACTION RULES:
- Do NOT guess.
- Only fill or update a field if the transcript clearly answers that exact field.
- Short values such as "yes", "no", names, dates, times, dollar amounts, phone numbers, and "N/A" can be complete valid answers when they clearly answer the field.
- If information appears to belong to a missing, locked, or excluded field, ignore it rather than forcing it into another available field.
- Do NOT use a semantically nearby allowed key as a fallback.
- A street address must not be placed into living_situation. living_situation means household arrangement, such as lives alone, with parents, with spouse, supported accommodation, homeless, etc.
- Do NOT infer from vague or ambiguous speech.
- If a current_value is already correct and complete, return it unchanged.
- If the transcript contains a correction, more complete, or more specific value, use that.
- Prefer specific values: "metformin 500mg twice daily" over "medication".
- Combine scattered details into one field when they clearly belong together.
- If the transcript clearly states that a field is not applicable, return "N/A".
- If no information exists for a field, return an empty string.
- Do NOT infer age from DOB, DOB from age, or any derived value unless the field specifically asks for that value and the transcript supports it.
- Use Australian date interpretation where dates are clearly spoken in Australian format.
- Preserve phone numbers, addresses, IDs, names, and other identifiers accurately. Format cleanly only when unambiguous.

Return ONLY a pure JSON object:
{"finalAttributes": {"snake_case_key": "value", ...}}

Every key in allowed_keys must appear. No markdown, no code fences, no extra keys.`;

function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

function allowedKeySet(template: FieldDef[]): string[] {
    return template.map((f) => normalizeKey(f.field_name));
}

export function finalAttributesResponseSchema(allowedKeys: string[]) {
    const finalAttributeProperties = Object.fromEntries(
        allowedKeys.map((key) => [key, { type: "string" }])
    );

    return {
        name: "forms_final_attributes_response",
        schema: {
            type: "object",
            additionalProperties: false,
            properties: {
                finalAttributes: {
                    type: "object",
                    additionalProperties: false,
                    properties: finalAttributeProperties,
                    required: allowedKeys,
                },
            },
            required: ["finalAttributes"],
        },
    } as const;
}

export function liveAttributesResponseSchema(allowedKeys: string[]) {
    return {
        name: "forms_live_attribute_updates_response",
        schema: {
            type: "object",
            additionalProperties: false,
            properties: {
                updates: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            fieldKey: { type: "string", enum: allowedKeys },
                            value: { type: "string" },
                        },
                        required: ["fieldKey", "value"],
                    },
                },
            },
            required: ["updates"],
        },
    } as const;
}

function isMeaningfulFormText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length >= FORMS_MIN_TRANSCRIPT_CHARS && /[A-Za-z0-9$]/.test(trimmed);
}

function filterAndNormalizeOutput(
    raw: Record<string, string>,
    allowed: Set<string>,
    context: string
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [rawKey, val] of Object.entries(raw)) {
        const key = normalizeKey(rawKey);
        if (!allowed.has(key)) {
            console.warn(
                `[${context}] Dropping unknown key — ` +
                `rawKeyChars: ${rawKey.length}, normalizedKeyChars: ${key.length}`
            );
            continue;
        }
        if (val && val !== "N/A" && val.trim() !== "") {
            result[key] = val;
        }
    }
    return result;
}

export async function extractAttributesFromText(
    correctedText: string,
    template: FieldDef[],
    currAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (!isMeaningfulFormText(correctedText) || template.length === 0) return {};

    const allowed = allowedKeySet(template);
    const allowedSet = new Set(allowed);

    const normalizedCurrent: Record<string, string> = {};
    for (const [k, v] of Object.entries(currAttributes)) {
        normalizedCurrent[normalizeKey(k)] = v;
    }

    const maxOutputTokens = Math.max(512, template.length * 60);
    recordUsageEvent("forms_live_extract_start", {
        flow: "forms-live-extraction",
        provider: "chat",
        model: GPT_MINI_MODEL,
        transcriptChars: correctedText.length,
        templateFields: template.length,
        maxOutputTokens,
    });

    try {
        const startedAt = Date.now();
        const completion = await openai.chat.completions.create({
            model: GPT_MINI_MODEL,
            store: false,
            messages: [
                { role: "system", content: EXTRACT_SYS_TXT },
                {
                    role: "user",
                    content: JSON.stringify({
                        allowed_keys: allowed,
                        current_values: normalizedCurrent,
                        transcript_segment: correctedText,
                    }),
                },
            ],
            max_completion_tokens: maxOutputTokens,
            response_format: { type: "json_object" },
            reasoning_effort: GPT_LIVE_REASONING_EFFORT,
        }, { timeout: GPT_REQUEST_TIMEOUT_MS });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) { console.warn("[extract] Empty response"); return {}; }

        const parsed = JSON.parse(content) as { parsedAttributes?: Record<string, string> };
        const raw = parsed.parsedAttributes ?? {};
        const cleaned = filterAndNormalizeOutput(raw, allowedSet, "extract");
        console.log(`[extract] Got ${Object.keys(cleaned).length}/${template.length} fields`);
        const usage = safeUsageMetadata(completion.usage);
        recordUsageEvent("forms_live_extract_complete", {
            flow: "forms-live-extraction",
            provider: "chat",
            model: GPT_MINI_MODEL,
            transcriptChars: correctedText.length,
            templateFields: template.length,
            attrsReturned: Object.keys(cleaned).length,
            maxOutputTokens,
            durationMs: Date.now() - startedAt,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            totalTokens: usage.totalTokens,
        });
        return cleaned;
    } catch (err) {
        recordUsageEvent("forms_live_extract_failed", {
            flow: "forms-live-extraction",
            provider: "chat",
            model: GPT_MINI_MODEL,
            transcriptChars: correctedText.length,
            templateFields: template.length,
            maxOutputTokens,
        });
        console.warn(`[extract] Failed, returning sparse empty result — error: ${safeErrorInfo(err)}`);
        return {};
    }
}

export async function parseFinalAttributes(
    fullTranscript: string,
    template: FieldDef[],
    candidateAttributes: Record<string, string>
): Promise<Record<string, string>> {
    if (!isMeaningfulFormText(fullTranscript)) {
        console.log("[final] Transcript empty/noise, returning candidates as-is");
        return candidateAttributes;
    }

    const allowed = allowedKeySet(template);
    const allowedSet = new Set(allowed);
    const truncated = truncateTranscriptPreservingEdges(fullTranscript, FORM_FINAL_TRANSCRIPT_CHAR_LIMIT);

    const normalizedCandidates: Record<string, string> = {};
    for (const [k, v] of Object.entries(candidateAttributes)) {
        normalizedCandidates[normalizeKey(k)] = v;
    }

    const maxOutputTokens = Math.max(1024, template.length * 80);
    recordUsageEvent("forms_final_start", {
        flow: "forms-final",
        provider: "responses",
        model: GPT_FINAL_MODEL,
        reasoningEffort: GPT_FINAL_REASONING_EFFORT,
        transcriptChars: fullTranscript.length,
        truncatedChars: truncated.length,
        templateFields: template.length,
        maxOutputTokens,
    });

    try {
        const response = await runOpenAIResponsesJson({
            label: "forms-final",
            model: GPT_FINAL_MODEL,
            reasoningEffort: GPT_FINAL_REASONING_EFFORT,
            instructions: FINAL_SYS_TXT,
            input: JSON.stringify({
                allowed_keys: allowed,
                current_values: normalizedCandidates,
                full_transcript: truncated,
            }),
            maxOutputTokens,
            jsonSchema: finalAttributesResponseSchema(allowed),
            metadata: {
                transcriptChars: fullTranscript.length,
                truncatedChars: truncated.length,
                templateFields: template.length,
            },
        });

        if (response.status === "incomplete") {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "incomplete",
                transcriptChars: fullTranscript.length,
                outputChars: response.outputText.length,
                durationMs: response.durationMs,
                incompleteReason: response.incompleteReason ?? undefined,
            });
            console.warn(
                `[final] Incomplete response, returning candidates — ` +
                `transcriptChars: ${fullTranscript.length}, ` +
                `outputChars: ${response.outputText.length}, ` +
                `reason: ${response.incompleteReason ?? "unknown"}, ` +
                `duration: ${response.durationMs}ms`
            );
            return candidateAttributes;
        }

        const content = response.outputText;
        if (!content) {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "empty-output",
                transcriptChars: fullTranscript.length,
                outputChars: 0,
            });
            console.warn("[final] Empty response, returning candidates");
            return candidateAttributes;
        }

        const parsed = JSON.parse(extractJsonObjectText(content)) as { finalAttributes?: unknown };
        const parsedKeys = safeJsonKeys(parsed);
        if (parsedKeys.length !== 1 || parsedKeys[0] !== "finalAttributes") {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "schema-failed",
                transcriptChars: fullTranscript.length,
                outputChars: content.length,
            });
            console.warn(
                `[final] Unexpected response keys, returning candidates — ` +
                `jsonKeys: ${formatSafeJsonKeys(parsedKeys)}`
            );
            return candidateAttributes;
        }
        if (!isRecord(parsed.finalAttributes)) {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "missing-key",
                transcriptChars: fullTranscript.length,
                outputChars: content.length,
            });
            console.warn("[final] Missing finalAttributes key, returning candidates");
            return candidateAttributes;
        }
        const raw = parsed.finalAttributes;
        const merged = { ...normalizedCandidates };
        let updatedCount = 0;

        for (const [rawKey, value] of Object.entries(raw)) {
            const key = normalizeKey(rawKey);
            if (!allowedSet.has(key)) {
                console.warn(`[final] Dropping unknown key — rawKeyChars: ${rawKey.length}, normalizedKeyChars: ${key.length}`);
                continue;
            }
            if (typeof value === "string" && value && value !== "N/A" && value.trim() !== "") {
                if (merged[key] !== value) { merged[key] = value; updatedCount++; }
            }
        }

        console.log(`[final] ${GPT_FINAL_MODEL} pass complete. Updated ${updatedCount} fields.`);
        recordUsageEvent("forms_final_complete", {
            flow: "forms-final",
            provider: "responses",
            model: GPT_FINAL_MODEL,
            reasoningEffort: GPT_FINAL_REASONING_EFFORT,
            transcriptChars: fullTranscript.length,
            truncatedChars: truncated.length,
            templateFields: template.length,
            updatedCount,
            outputChars: content.length,
            durationMs: response.durationMs,
            inputTokens: response.usage.inputTokens,
            cachedInputTokens: response.usage.cachedInputTokens,
            outputTokens: response.usage.outputTokens,
            reasoningTokens: response.usage.reasoningTokens,
            totalTokens: response.usage.totalTokens,
        });
        return merged;
    } catch (err) {
        recordUsageEvent("forms_final_failed", {
            flow: "forms-final",
            reason: "exception",
            transcriptChars: fullTranscript.length,
            templateFields: template.length,
        });
        console.error(`[final] Error — ${safeErrorInfo(err)}`);
        return candidateAttributes;
    }
}
