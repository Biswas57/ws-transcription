export function extractJsonObjectText(content: string): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

export type JsonObjectParseResult =
    | { ok: true; value: Record<string, unknown>; keys: string[] }
    | { ok: false; stage: "invalid-json" | "invalid-json-shape" };

export type ExactJsonKeyResult =
    | { ok: true; value: unknown; keys: string[] }
    | { ok: false; stage: "missing-key" | "unexpected-key"; keys: string[] };

export type ExactStringKeyResult =
    | { ok: true; value: string; keys: string[] }
    | { ok: false; stage: "missing-key" | "unexpected-key" | "empty-output"; keys: string[] };

export function parseJsonObjectText(content: string): JsonObjectParseResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonObjectText(content));
    } catch {
        return { ok: false, stage: "invalid-json" };
    }

    if (!isRecord(parsed)) return { ok: false, stage: "invalid-json-shape" };
    return { ok: true, value: parsed, keys: Object.keys(parsed) };
}

export function readExactJsonKey(
    object: Record<string, unknown>,
    expectedKey: string
): ExactJsonKeyResult {
    const keys = Object.keys(object);
    const value = object[expectedKey];

    if (typeof value === "undefined") {
        return { ok: false, stage: "missing-key", keys };
    }

    if (keys.length !== 1 || keys[0] !== expectedKey) {
        return { ok: false, stage: "unexpected-key", keys };
    }

    return { ok: true, value, keys };
}

export function readExactStringKey(
    object: Record<string, unknown>,
    expectedKey: string
): ExactStringKeyResult {
    const keys = Object.keys(object);
    const value = object[expectedKey];

    if (typeof value !== "string") {
        return { ok: false, stage: "missing-key", keys };
    }

    if (keys.length !== 1 || keys[0] !== expectedKey) {
        return { ok: false, stage: "unexpected-key", keys };
    }

    const trimmed = value.trim();
    if (!trimmed) return { ok: false, stage: "empty-output", keys };

    return { ok: true, value: trimmed, keys };
}
