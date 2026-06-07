import { OpenAI } from "openai";
import { GPT_REQUEST_TIMEOUT_MS } from "./model-config.js";
import {
    appendSafeNumber,
    safeIdentifierValue,
    safeLogValue,
    safeUsageMetadata,
} from "../safe-log.js";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type ResponsesReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ResponsesJsonCallResult = {
    outputText: string;
    status: string;
    incompleteReason: string | null;
    durationMs: number;
};

export async function runOpenAIResponsesJson(args: {
    label: string;
    model: string;
    reasoningEffort: ResponsesReasoningEffort;
    instructions: string;
    input: string;
    maxOutputTokens: number;
    metadata?: Record<string, string | number | boolean | undefined>;
}): Promise<ResponsesJsonCallResult> {
    const startedAt = Date.now();
    const response = await openai.responses.create({
        model: args.model,
        instructions: args.instructions,
        input: args.input,
        reasoning: { effort: args.reasoningEffort },
        max_output_tokens: args.maxOutputTokens,
        text: { format: { type: "json_object" } },
    }, { timeout: GPT_REQUEST_TIMEOUT_MS });

    const durationMs = Date.now() - startedAt;
    const outputText = response.output_text ?? "";
    const status = safeIdentifierValue(response.status) ?? "unknown";
    const incompleteReason = safeIdentifierValue(response.incomplete_details?.reason) ?? null;
    const usage = safeUsageMetadata(response.usage);
    const parts = [
        `api: responses`,
        `label: ${safeLogValue(args.label)}`,
        `model: ${safeLogValue(args.model)}`,
        `reasoningEffort: ${safeLogValue(args.reasoningEffort)}`,
        `status: ${status}`,
        `outputChars: ${outputText.length}`,
        `maxOutputTokens: ${args.maxOutputTokens}`,
        `duration: ${durationMs}ms`,
    ];

    if (incompleteReason) parts.push(`incompleteReason: ${incompleteReason}`);
    appendSafeNumber(parts, "inputTokens", usage.inputTokens);
    appendSafeNumber(parts, "cachedInputTokens", usage.cachedInputTokens);
    appendSafeNumber(parts, "outputTokens", usage.outputTokens);
    appendSafeNumber(parts, "reasoningTokens", usage.reasoningTokens);
    appendSafeNumber(parts, "totalTokens", usage.totalTokens);

    for (const [key, value] of Object.entries(args.metadata ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) {
            parts.push(`${safeLogValue(key)}: ${value}`);
        } else if (typeof value === "boolean") {
            parts.push(`${safeLogValue(key)}: ${value}`);
        } else if (typeof value === "string") {
            parts.push(`${safeLogValue(key)}: ${safeLogValue(value)}`);
        }
    }

    console.log(`[${args.label}] Provider — ${parts.join(", ")}`);

    return {
        outputText,
        status,
        incompleteReason,
        durationMs,
    };
}
