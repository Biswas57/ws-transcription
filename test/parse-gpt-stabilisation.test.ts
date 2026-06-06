import { describe, it, expect, beforeEach, vi } from "vitest";

const openAiMock = vi.hoisted(() => ({
    create: vi.fn(),
}));

vi.mock("openai", () => ({
    OpenAI: vi.fn(() => ({
        chat: {
            completions: {
                create: openAiMock.create,
            },
        },
    })),
}));

import {
    extractAttributesFromText,
    finalizeNotes,
    generateNotesIncremental,
    parseFinalAttributes,
    reviseTranscription,
} from "../parse-gpt.js";

describe("parse-gpt stabilisation", () => {
    beforeEach(() => {
        openAiMock.create.mockReset();
    });

    it("runs incremental extraction for one-word Forms values", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ parsedAttributes: { answer: "yes" } }) } }],
        });

        const result = await extractAttributesFromText(
            "yes",
            [{ block_name: "main", field_name: "answer" }],
            { answer: "" }
        );

        expect(result).toEqual({ answer: "yes" });
        expect(openAiMock.create).toHaveBeenCalledTimes(1);
    });

    it("runs final extraction for one-word Forms values", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ finalAttributes: { answer: "yes" } }) } }],
        });

        const result = await parseFinalAttributes(
            "yes",
            [{ block_name: "main", field_name: "answer" }],
            { answer: "" }
        );

        expect(result).toEqual({ answer: "yes" });
        expect(openAiMock.create).toHaveBeenCalledTimes(1);
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("high");
    });

    it("returns raw Whisper text when revision model call throws", async () => {
        const raw = "This raw Whisper transcript should survive revision failure.";
        const err = new Error("simulated provider failure");
        (err as Error & { code?: string }).code = "ETIMEDOUT";
        openAiMock.create.mockRejectedValueOnce(err);

        await expect(reviseTranscription(raw)).resolves.toBe(raw);
    });

    it("skips Notes revision for short or sparse transcript batches", async () => {
        await expect(reviseTranscription(
            "Short Notes fragment with under forty chars.",
            { mode: "notes" }
        )).resolves.toBe("Short Notes fragment with under forty chars.");

        const sparse = "Architecture stabilisation requires precise rollout sequencing.";
        await expect(reviseTranscription(sparse, { mode: "notes" })).resolves.toBe(sparse);

        expect(openAiMock.create).not.toHaveBeenCalled();
    });

    it("skips Forms revision for short field-like values without dropping them", async () => {
        for (const value of ["yes", "John", "$500", "12 June", "3pm", "N/A", "sam@example.com", "+61 400 123 456"]) {
            await expect(reviseTranscription(value, { mode: "forms" })).resolves.toBe(value);
        }

        expect(openAiMock.create).not.toHaveBeenCalled();
    });

    it("keeps the legacy notes incremental return value as full markdown", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: JSON.stringify({
                        updates: [{
                            targetHeading: "Decisions",
                            targetLevel: 2,
                            appendMarkdown: "- Confirmed the backend keeps the old response shape.",
                        }],
                    }),
                },
            }],
        });

        const result = await generateNotesIncremental(
            "The backend keeps the old response shape.",
            "## Decisions\n\n- Existing decision.",
            "meeting",
            ["Decisions"]
        );

        expect(result).toContain("## Decisions");
        expect(result).toContain("- Existing decision.");
        expect(result).toContain("- Confirmed the backend keeps the old response shape.");
        expect(result).not.toContain("\"updates\"");
        expect(openAiMock.create.mock.calls[0][0].max_completion_tokens).toBe(1024);
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("low");
    });

    it("keeps current notes unchanged when notes incremental patch JSON is invalid", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: "not valid json" } }],
        });

        const current = "## Decisions\n\n- Existing decision.";
        await expect(generateNotesIncremental(
            "This segment should not become raw model output.",
            current,
            "meeting",
            ["Decisions"]
        )).resolves.toBe(current);
    });

    it("uses final reasoning effort for Notes finalisation", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ notesMarkdown: "## Summary\n\n- Final note." }) } }],
        });

        const result = await finalizeNotes(
            "This is a sufficiently detailed transcript for the final notes pass.",
            "## Draft\n\n- Existing note.",
            "meeting",
            ["Summary"]
        );

        expect(result).toBe("## Summary\n\n- Final note.");
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("high");
    });
});
