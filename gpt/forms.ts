import { type FieldDef, FORMS_MIN_TRANSCRIPT_CHARS } from "../types.js";
import {
    FORM_FINAL_TRANSCRIPT_CHAR_LIMIT,
    GPT_FLOW_CONFIG,
    GPT_REQUEST_TIMEOUT_MS,
    truncateTranscriptPreservingEdges,
} from "./model-config.js";
import { isRecord, parseJsonObjectText, readExactJsonKey } from "./json-parsing.js";
import { openai, runOpenAIResponsesJson } from "./provider.js";
import {
    formatSafeJsonKeys,
    recordUsageEvent,
    safeErrorInfo,
    safeUsageMetadata,
} from "../safe-log.js";

export const EXTRACT_SYS_TXT = `\
You are a conservative structured-data extraction specialist working across Australian professional, operational, study, clinical, and general contexts.

INPUTS:
1. allowed_keys — the exact snake_case keys permitted in the output
2. current_values — values already recorded for those keys
3. transcript_segment — the latest corrected transcript segment

OBJECTIVE:
Extract only new, corrected, or meaningfully more complete field values supported by transcript_segment.

INSTRUCTION PRIORITY:
1. Obey the required JSON schema and allowed_keys.
2. Preserve factual accuracy.
3. Avoid unsupported inference.
4. Avoid replacing a better current value with a worse one.
5. Keep the result sparse.

INTERNAL WORKFLOW — DO NOT OUTPUT:
1. Interpret each allowed key as a semantic field, not as a phrase that must be spoken literally.
2. Identify direct or unambiguous evidence in transcript_segment.
3. Resolve explicit corrections and updates using conversational context.
4. Compare each candidate against current_values.
5. Emit only candidates that are new, corrected, or more complete.
6. Verify that every emitted key appears exactly in allowed_keys.

EVIDENCE RULES:
- Use only information explicitly stated or unambiguously expressed in transcript_segment.
- Do not derive one value from another unless the requested field itself was clearly answered.
- Do not guess from stereotypes, common practice, external knowledge, or nearby context.
- Do not populate a field merely because its key is semantically similar to the information spoken.
- If information belongs to a missing, locked, excluded, or unavailable field, ignore it.
- If evidence could reasonably map to multiple allowed keys and the intended field is unclear, omit it.
- If two statements conflict and neither is clearly a correction or later confirmed value, omit the update.
- If the speaker explicitly corrects an earlier statement, use the corrected value.
- Short answers such as "yes", "no", "N/A", names, dates, times, amounts, identifiers, and phone numbers are valid when they clearly answer the field.

CURRENT VALUE RULES:
- Return a sparse object containing only changed fields.
- Omit a field when current_values already contains the same accurate and complete information.
- Update a field when transcript_segment clearly corrects the current value.
- Update a field when transcript_segment provides a meaningfully more complete or specific value.
- Combine old and new details only when both clearly belong to the same field and can be merged without contradiction.
- Never replace a specific value with a vague, partial, or less reliable value.

FIELD-BOUNDARY RULES:
- Treat keys as semantic labels rather than literal keyword matches.
- Never force information into the closest available field.
- A street or postal address must not be placed into living_situation.
- living_situation means household arrangement, such as living alone, with parents, with a partner, in supported accommodation, or without stable housing.
- Preserve names, addresses, numbers, dates, IDs, commands, product names, and technical terms accurately.
- Apply Australian date interpretation only when the spoken date is clearly expressed in that convention.

OUTPUT:
Return only a valid JSON object in exactly this shape:

{"parsedAttributes":{"allowed_key":"value"}}

OUTPUT CONSTRAINTS:
- Use only keys from allowed_keys.
- All returned values must be strings.
- No markdown.
- No code fences.
- No commentary.
- No additional keys.
- If no field should be updated, return exactly:
{"parsedAttributes":{}}`;

export const FINAL_SYS_TXT = `\
You are a senior structured-data verification specialist working across Australian professional, operational, study, clinical, and general contexts.

INPUTS:
1. allowed_keys — the exact snake_case keys required in the output
2. current_values — values accumulated during incremental extraction
3. full_transcript — the available transcript for final review; it may be incomplete or truncated

OBJECTIVE:
Return the most accurate supported value for every key in allowed_keys.

INSTRUCTION PRIORITY:
1. Return every allowed key exactly once.
2. Preserve factual accuracy.
3. Preserve reliable current values when the transcript is incomplete.
4. Apply clear corrections and more specific evidence.
5. Leave unsupported fields empty rather than guessing.

INTERNAL WORKFLOW — DO NOT OUTPUT:
1. Review current_values and transcript evidence for each allowed key.
2. Identify explicit answers, corrections, confirmations, and scattered supporting details.
3. Resolve conflicts using the evidence hierarchy below.
4. Produce the strongest supported value for every field.
5. Verify exact key coverage and JSON validity.

EVIDENCE HIERARCHY:
1. A clear later correction or explicit final answer in full_transcript.
2. A reliable current_value that is not contradicted.
3. Direct or unambiguous evidence elsewhere in full_transcript.
4. An empty string when no reliable answer exists.

CURRENT VALUE AND TRUNCATION RULES:
- full_transcript may omit parts of the session.
- Do not erase a reliable current_value merely because it is not repeated in full_transcript.
- Keep an existing value unchanged when it remains plausible and uncontradicted.
- Replace an existing value when the transcript clearly corrects it.
- Expand an existing value when the transcript provides a more complete or specific version.
- If current_values and transcript conflict without a clear correction, preserve the best-supported value and do not invent a reconciliation.
- If neither source provides reliable evidence, return an empty string.

EXTRACTION RULES:
- Use only keys from allowed_keys.
- Treat keys as semantic fields rather than literal phrases.
- Do not guess, derive, diagnose, calculate, or use outside knowledge.
- Only populate a field when the available evidence answers that field.
- Do not use a nearby allowed key as a fallback.
- Ignore information belonging to missing, locked, excluded, or unavailable fields.
- Combine scattered details only when they clearly describe the same field.
- Prefer specific supported values over vague ones.
- If the transcript clearly says a field is not applicable, return "N/A".
- Short answers such as "yes", "no", names, dates, times, amounts, identifiers, and phone numbers may be complete values.
- Do not infer age from date of birth or date of birth from age.
- Do not infer derived financial, clinical, legal, or operational values unless directly requested and explicitly supported.
- Apply Australian date interpretation only when the spoken date is clearly expressed in that convention.
- Preserve names, addresses, phone numbers, IDs, commands, product names, units, and technical terms accurately.
- Format only when the intended formatting is unambiguous.

FIELD-BOUNDARY RULES:
- Never force information into the closest available field.
- A street or postal address must not be placed into living_situation.
- living_situation means household arrangement, such as living alone, with parents, with a partner, in supported accommodation, or without stable housing.

OUTPUT:
Return only a valid JSON object in exactly this shape:

{"finalAttributes":{"allowed_key":"value"}}

OUTPUT CONSTRAINTS:
- Every key in allowed_keys must appear exactly once.
- Do not return any key outside allowed_keys.
- All values must be strings.
- Use an empty string when no reliable value exists.
- No markdown.
- No code fences.
- No commentary.
- No additional keys.`;


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
    const config = GPT_FLOW_CONFIG.formsLive;
    recordUsageEvent("forms_live_extract_start", {
        flow: "forms-live-extraction",
        provider: "chat",
        model: config.model,
        transcriptChars: correctedText.length,
        templateFields: template.length,
        maxOutputTokens,
    });

    try {
        const startedAt = Date.now();
        const completion = await openai.chat.completions.create({
            model: config.model,
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
            reasoning_effort: config.reasoning,
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
            model: config.model,
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
            model: config.model,
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
    const config = GPT_FLOW_CONFIG.formsFinal;
    recordUsageEvent("forms_final_start", {
        flow: "forms-final",
        provider: "responses",
        model: config.model,
        reasoningEffort: config.reasoning,
        transcriptChars: fullTranscript.length,
        truncatedChars: truncated.length,
        templateFields: template.length,
        maxOutputTokens,
    });

    try {
        const response = await runOpenAIResponsesJson({
            label: "forms-final",
            model: config.model,
            reasoningEffort: config.reasoning,
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

        const parsed = parseJsonObjectText(content);
        if (!parsed.ok) {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "schema-failed",
                transcriptChars: fullTranscript.length,
                outputChars: content.length,
            });
            console.warn(
                `[final] Unexpected response keys, returning candidates — ` +
                `jsonKeys: ${formatSafeJsonKeys([])}`
            );
            return candidateAttributes;
        }

        const parsedAttributes = readExactJsonKey(parsed.value, "finalAttributes");
        if (!parsedAttributes.ok && parsedAttributes.stage === "unexpected-key") {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "schema-failed",
                transcriptChars: fullTranscript.length,
                outputChars: content.length,
            });
            console.warn(
                `[final] Unexpected response keys, returning candidates — ` +
                `jsonKeys: ${formatSafeJsonKeys(parsedAttributes.keys)}`
            );
            return candidateAttributes;
        }
        if (!parsedAttributes.ok || !isRecord(parsedAttributes.value)) {
            recordUsageEvent("forms_final_failed", {
                flow: "forms-final",
                reason: "missing-key",
                transcriptChars: fullTranscript.length,
                outputChars: content.length,
            });
            console.warn("[final] Missing finalAttributes key, returning candidates");
            return candidateAttributes;
        }
        const raw = parsedAttributes.value;
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

        console.log(`[final] ${config.model} pass complete. Updated ${updatedCount} fields.`);
        recordUsageEvent("forms_final_complete", {
            flow: "forms-final",
            provider: "responses",
            model: config.model,
            reasoningEffort: config.reasoning,
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
