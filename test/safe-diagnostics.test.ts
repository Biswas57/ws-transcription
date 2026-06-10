import { describe, expect, it, vi } from "vitest";
import {
    appendSafeNumber,
    formatSafeJsonKeys,
    formatUsageEvent,
    recordUsageEvent,
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

    it("handles missing cached-token metadata safely", () => {
        expect(safeUsageMetadata({
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
        })).toEqual({
            inputTokens: 12,
            cachedInputTokens: undefined,
            outputTokens: 8,
            reasoningTokens: undefined,
            totalTokens: 20,
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

    it("formats usage events with safe metadata only", () => {
        const formatted = formatUsageEvent("notes_live_patch_complete", {
            flow: "notes-live-patch",
            provider: "responses",
            model: "gpt-5.4-mini",
            durationMs: 123,
            currentNotesChars: 456,
            fallbackUsed: false,
            rawTranscript: "Patient said this sentence should never appear",
            rawNotes: "## Notes\n\n- This note body should never appear",
            empty: undefined,
        });

        expect(formatted).toContain("[usage] event: notes_live_patch_complete");
        expect(formatted).toContain("flow: notes-live-patch");
        expect(formatted).toContain("provider: responses");
        expect(formatted).toContain("model: gpt-5.4-mini");
        expect(formatted).toContain("durationMs: 123");
        expect(formatted).toContain("fallbackUsed: false");
        expect(formatted).not.toContain("Patient");
        expect(formatted).not.toContain("sentence");
        expect(formatted).not.toContain("## Notes");
        expect(formatted).not.toContain("note body");
    });

    it("formats cached-token usage metadata without prompt or content values", () => {
        const formatted = formatUsageEvent("provider_call_complete", {
            api: "responses",
            flow: "notes-final",
            inputTokens: 1200,
            cachedInputTokens: 850,
            outputTokens: 300,
            reasoningTokens: 42,
            totalTokens: 1500,
            prompt: "system prompt text must not appear",
            currentNotes: "## Private notes must not appear",
        });

        expect(formatted).toContain("cachedInputTokens: 850");
        expect(formatted).toContain("inputTokens: 1200");
        expect(formatted).toContain("outputTokens: 300");
        expect(formatted).toContain("reasoningTokens: 42");
        expect(formatted).toContain("totalTokens: 1500");
        expect(formatted).not.toContain("system prompt");
        expect(formatted).not.toContain("Private notes");
    });

    it("records usage events through console.log", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
            recordUsageEvent("recording_session_start", {
                mode: "notes",
                currentNotesChars: 0,
            });
            expect(logSpy).toHaveBeenCalledWith(
                "[usage] event: recording_session_start, mode: notes, currentNotesChars: 0"
            );
        } finally {
            logSpy.mockRestore();
        }
    });
});
