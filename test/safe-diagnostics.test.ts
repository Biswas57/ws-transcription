import { describe, expect, it } from "vitest";
import {
    appendSafeNumber,
    formatSafeJsonKeys,
    safeErrorInfo,
    safeIdentifierValue,
    safeJsonKeys,
    safeLogValue,
    safeUsageMetadata,
    shortHash,
} from "../safe-log.js";

describe("safe diagnostics helpers", () => {
    it("formats normal errors without exposing messages", () => {
        expect(safeErrorInfo(new Error("raw sensitive-ish detail"))).toBe("name=Error");
    });

    it("formats custom error codes and status metadata", () => {
        const err = Object.assign(new Error("provider details"), {
            code: "ETIMEDOUT",
            status: 504,
            statusCode: 504,
        });

        expect(safeErrorInfo(err)).toBe("name=Error code=ETIMEDOUT status=504 statusCode=504");
    });

    it("handles non-error values safely", () => {
        expect(safeErrorInfo("raw thrown value")).toBe("type=string");
        expect(safeErrorInfo(null)).toBe("type=object");
        expect(safeErrorInfo(undefined)).toBe("type=undefined");
    });

    it("returns and formats first-level JSON keys only", () => {
        const value = {
            safe_key: "do-not-include-this-value",
            "unsafe key!": { nested: "also hidden" },
        };

        expect(safeJsonKeys(value)).toEqual(["safe_key", "unsafe key!"]);
        expect(formatSafeJsonKeys(value)).toBe("[safe_key,unsafekey]");
    });

    it("extracts Responses usage metadata", () => {
        expect(safeUsageMetadata({
            input_tokens: 12,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens: 8,
            output_tokens_details: { reasoning_tokens: 2 },
            total_tokens: 20,
        })).toEqual({
            inputTokens: 12,
            cachedInputTokens: 3,
            outputTokens: 8,
            reasoningTokens: 2,
            totalTokens: 20,
        });
    });

    it("extracts Chat Completions usage metadata", () => {
        expect(safeUsageMetadata({
            prompt_tokens: 5,
            prompt_tokens_details: { cached_tokens: 1 },
            completion_tokens: 7,
            completion_tokens_details: { reasoning_tokens: 4 },
            total_tokens: 12,
        })).toEqual({
            inputTokens: 5,
            cachedInputTokens: 1,
            outputTokens: 7,
            reasoningTokens: 4,
            totalTokens: 12,
        });
    });

    it("keeps log values bounded to safe characters", () => {
        expect(safeIdentifierValue("max_output_tokens!")).toBe("max_output_tokens");
        expect(safeLogValue("label,with spaces")).toBe("labelwithspaces");
    });

    it("appends only finite numeric metadata and produces stable short hashes", () => {
        const parts: string[] = [];
        appendSafeNumber(parts, "inputTokens", 42);
        appendSafeNumber(parts, "bad", Number.NaN);

        expect(parts).toEqual(["inputTokens: 42"]);
        expect(shortHash("same-value")).toBe(shortHash("same-value"));
        expect(shortHash("same-value")).toHaveLength(16);
    });
});
