import { createHash } from "crypto";

export type SafeUsageMetadata = {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
};

export type SafeUsageEventMetadata = Record<
    string,
    string | number | boolean | null | undefined
>;

export function safeErrorInfo(err: unknown): string {
    if (!err || typeof err !== "object") return `type=${typeof err}`;

    const obj = err as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
    };

    const parts: string[] = [];
    const name = typeof obj.name === "string" && obj.name ? obj.name : err.constructor?.name;
    if (name) parts.push(`name=${name}`);
    if (typeof obj.code === "string" || typeof obj.code === "number") parts.push(`code=${String(obj.code)}`);
    if (typeof obj.status === "string" || typeof obj.status === "number") parts.push(`status=${String(obj.status)}`);
    if (typeof obj.statusCode === "string" || typeof obj.statusCode === "number") parts.push(`statusCode=${String(obj.statusCode)}`);

    return parts.length > 0 ? parts.join(" ") : "type=object";
}

export function safeJsonKeys(value: unknown): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.keys(value);
}

export function formatSafeJsonKeys(keysOrValue: string[] | unknown): string {
    const keys = Array.isArray(keysOrValue)
        ? keysOrValue
        : safeJsonKeys(keysOrValue);
    if (keys.length === 0) return "[]";

    return `[${keys
        .map((key) => key.replace(/[^A-Za-z0-9_-]/g, ""))
        .filter(Boolean)
        .join(",")}]`;
}

export function safeIdentifierValue(value: unknown): string | null {
    return typeof value === "string" && value.length > 0
        ? value.replace(/[^A-Za-z0-9_-]/g, "")
        : null;
}

export function safeLogValue(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "");
}

export function appendSafeNumber(parts: string[], key: string, value: unknown): void {
    if (typeof value === "number" && Number.isFinite(value)) {
        parts.push(`${key}: ${value}`);
    }
}

export function safeUsageMetadata(usage: unknown): SafeUsageMetadata {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};

    const record = usage as Record<string, unknown>;
    const inputDetails = safeRecord(record.input_tokens_details) ?? safeRecord(record.prompt_tokens_details);
    const outputDetails = safeRecord(record.output_tokens_details) ?? safeRecord(record.completion_tokens_details);

    return {
        inputTokens: safeNumber(record.input_tokens) ?? safeNumber(record.prompt_tokens),
        cachedInputTokens: safeNumber(inputDetails?.cached_tokens),
        outputTokens: safeNumber(record.output_tokens) ?? safeNumber(record.completion_tokens),
        reasoningTokens: safeNumber(outputDetails?.reasoning_tokens),
        totalTokens: safeNumber(record.total_tokens),
    };
}

export function formatUsageEvent(
    eventName: string,
    metadata: SafeUsageEventMetadata = {}
): string {
    const event = safeUsageString(eventName) ?? "unknown";
    const parts = [`event: ${event}`];

    for (const [rawKey, value] of Object.entries(metadata)) {
        if (value === null || value === undefined) continue;
        const key = safeLogValue(rawKey);
        if (!key) continue;

        if (typeof value === "number") {
            if (Number.isFinite(value)) parts.push(`${key}: ${value}`);
            continue;
        }

        if (typeof value === "boolean") {
            parts.push(`${key}: ${value}`);
            continue;
        }

        const safeValue = safeUsageString(value);
        if (safeValue) parts.push(`${key}: ${safeValue}`);
    }

    return `[usage] ${parts.join(", ")}`;
}

export function recordUsageEvent(
    eventName: string,
    metadata: SafeUsageEventMetadata = {}
): void {
    console.log(formatUsageEvent(eventName, metadata));
}

export function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function safeNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeUsageString(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80) return null;
    if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return null;
    return trimmed;
}
