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
    });

    it("returns raw Whisper text when revision model call throws", async () => {
        const raw = "This raw Whisper transcript should survive revision failure.";
        const err = new Error("simulated provider failure");
        (err as Error & { code?: string }).code = "ETIMEDOUT";
        openAiMock.create.mockRejectedValueOnce(err);

        await expect(reviseTranscription(raw)).resolves.toBe(raw);
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
});
