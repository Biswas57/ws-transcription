import { OpenAI } from "openai";
import { GPT_REQUEST_TIMEOUT_MS } from "./model-config.js";
import {
    type SafeUsageMetadata,
    appendSafeNumber,
    recordUsageEvent,
    safeIdentifierValue,
    safeLogValue,
    safeUsageMetadata,
} from "../safe-log.js";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type ResponsesReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ResponsesJsonSchema = {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
};

export type ResponsesJsonCallResult = {
    outputText: string;
    status: string;
    incompleteReason: string | null;
    durationMs: number;
    usage: SafeUsageMetadata;
};

export async function runOpenAIResponsesJson(args: {
    label: string;
    model: string;
    reasoningEffort: ResponsesReasoningEffort;
    instructions: string;
    input: string;
    maxOutputTokens: number;
    jsonSchema: ResponsesJsonSchema;
    metadata?: Record<string, string | number | boolean | undefined>;
}): Promise<ResponsesJsonCallResult> {
    const startedAt = Date.now();
    let response;
    try {
        response = await openai.responses.create({
            model: args.model,
            store: false,
            instructions: args.instructions,
            input: args.input,
            reasoning: { effort: args.reasoningEffort },
            max_output_tokens: args.maxOutputTokens,
            text: {
                format: {
                    type: "json_schema",
                    name: args.jsonSchema.name,
                    schema: args.jsonSchema.schema,
                    strict: args.jsonSchema.strict ?? true,
                },
            },
        }, { timeout: GPT_REQUEST_TIMEOUT_MS });
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        const metadata = safeProviderErrorMetadata(err);
        recordUsageEvent("provider_call_failed", {
            api: "responses",
            flow: args.label,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            maxOutputTokens: args.maxOutputTokens,
            durationMs,
            status: metadata.status,
            providerCode: metadata.code,
            providerType: metadata.type,
            providerParam: metadata.param,
        });
        logResponsesProviderError(args, err, durationMs);
        throw err;
    }

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
    recordUsageEvent("provider_call_complete", {
        api: "responses",
        flow: args.label,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        status,
        incompleteReason: incompleteReason ?? undefined,
        outputChars: outputText.length,
        maxOutputTokens: args.maxOutputTokens,
        durationMs,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
    });

    return {
        outputText,
        status,
        incompleteReason,
        durationMs,
        usage,
    };
}

function logResponsesProviderError(
    args: {
        label: string;
        model: string;
        reasoningEffort: ResponsesReasoningEffort;
        input: string;
        instructions: string;
        maxOutputTokens: number;
        jsonSchema: ResponsesJsonSchema;
    },
    err: unknown,
    durationMs: number
): void {
    const parts = [
        "api: responses",
        `label: ${safeLogValue(args.label)}`,
        `model: ${safeLogValue(args.model)}`,
        `reasoningEffort: ${safeLogValue(args.reasoningEffort)}`,
        `maxOutputTokens: ${args.maxOutputTokens}`,
        "textFormat: json_schema",
        `schemaName: ${safeLogValue(args.jsonSchema.name)}`,
        `inputShape: ${inputShape(args.input)}`,
        `hasInstructions: ${args.instructions.trim().length > 0}`,
        `duration: ${durationMs}ms`,
    ];

    const metadata = safeProviderErrorMetadata(err);
    appendSafeNumber(parts, "status", metadata.status);
    if (metadata.code) parts.push(`providerCode: ${metadata.code}`);
    if (metadata.type) parts.push(`providerType: ${metadata.type}`);
    if (metadata.param) parts.push(`providerParam: ${metadata.param}`);
    if (metadata.requestId) parts.push(`requestId: ${metadata.requestId}`);
    if (metadata.message) parts.push(`providerMessage: ${metadata.message}`);
    if (metadata.messageOmitted) parts.push(`providerMessage: omitted`);

    console.error(`[${args.label}] Provider request failed — ${parts.join(", ")}`);
}

function inputShape(input: unknown): string {
    if (typeof input === "string") return "string";
    if (Array.isArray(input)) return "array";
    if (input && typeof input === "object") return "object";
    return typeof input;
}

function safeProviderErrorMetadata(err: unknown): {
    status?: number;
    code?: string;
    type?: string;
    param?: string;
    requestId?: string;
    message?: string;
    messageOmitted?: boolean;
} {
    if (!err || typeof err !== "object") return {};

    const record = err as Record<string, unknown>;
    const headers = record.headers && typeof record.headers === "object"
        ? record.headers as Record<string, unknown>
        : undefined;
    const message = safeProviderMessage(record.message);

    return {
        status: typeof record.status === "number" && Number.isFinite(record.status)
            ? record.status
            : undefined,
        code: safeIdentifierValue(record.code) ?? undefined,
        type: safeIdentifierValue(record.type) ?? undefined,
        param: typeof record.param === "string" && record.param.length > 0
            ? safeLogValue(record.param)
            : undefined,
        requestId: safeIdentifierValue(record.request_id) ??
            safeIdentifierValue(record.requestID) ??
            safeIdentifierValue(record.requestId) ??
            safeIdentifierValue(headers?.["x-request-id"]) ??
            undefined,
        message: message ?? undefined,
        messageOmitted: typeof record.message === "string" && !message,
    };
}

function safeProviderMessage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 300 || /[{}\[\]'"`\r\n]/.test(trimmed)) return null;

    const safe = trimmed
        .replace(/[^A-Za-z0-9 _.,:;'"()/_=-]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 240)
        .trim();

    return safe.length > 0 ? safe : null;
}
