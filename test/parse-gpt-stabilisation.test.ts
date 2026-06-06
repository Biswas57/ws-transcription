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
    generateNotesReorganisation,
    generateNotesSummary,
    generateNotesIncremental,
    parseFinalAttributes,
    reviseTranscription,
} from "../parse-gpt.js";

const LONG_NOTES = [
    "# Session Notes",
    "",
    ...Array.from(
        { length: 90 },
        (_, index) =>
            `- Detailed note ${index} captures decisions, actions, caveats, examples, definitions, dates, commands, unresolved questions, and product terms.`
    ),
].join("\n");

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

    it("generates notes summaries with final-quality reasoning and required prompt constraints", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ summaryMarkdown: "## Summary\n\n- Condensed note." }) } }],
        });

        const result = await generateNotesSummary({
            notesMarkdown: LONG_NOTES,
            noteStyle: "meeting",
        });

        expect(result).toEqual({ summaryMarkdown: "## Summary\n\n- Condensed note." });
        const request = openAiMock.create.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.5");
        expect(request.reasoning_effort).toBe("high");
        expect(request.response_format).toEqual({ type: "json_object" });
        expect(request.messages[0].content).toContain("Transform current visible notes only.");
        expect(request.messages[0].content).toContain("Do not add a \"Quick Checklist\" unless explicitly requested in the notes.");
        expect(request.messages[0].content).toContain("If a question is answered elsewhere");
        expect(request.messages[0].content).toContain("Preserve existing structure where possible.");
    });

    it("handles fenced summary JSON and common summary alias keys", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: "```json\n{\"summaryMarkdown\":\"## Summary\\n\\n- Fenced summary.\"}\n```",
                },
            }],
        });

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            summaryMarkdown: "## Summary\n\n- Fenced summary.",
        });

        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ notesMarkdown: "## Summary\n\n- Alias summary." }) } }],
        });

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            summaryMarkdown: "## Summary\n\n- Alias summary.",
        });
    });

    it("rejects malformed, missing, empty, and error-like summary output with specific codes", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: "not json" } }],
        });

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-invalid-json",
        });

        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ summary: "wrong key" }) } }],
        });

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-missing-key",
            details: expect.objectContaining({
                stage: "missing-key",
                jsonKeys: ["summary"],
                expectedKey: "summaryMarkdown",
            }),
        });

        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ summaryMarkdown: "   " }) } }],
        });

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-empty",
        });

        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ summaryMarkdown: "Error: unable to summarise." }) } }],
        });

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-error-like",
        });
    });

    it("generates notes reorganisations with required prompt constraints", async () => {
        const reorganised = `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`;
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ reorganisedMarkdown: reorganised }) } }],
        });

        const result = await generateNotesReorganisation({
            notesMarkdown: LONG_NOTES,
            noteStyle: "study",
            targetSections: ["Concepts", "Actions"],
        });

        expect(result).toEqual({ reorganisedMarkdown: reorganised });
        const request = openAiMock.create.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.5");
        expect(request.reasoning_effort).toBe("high");
        expect(request.response_format).toEqual({ type: "json_object" });
        expect(request.messages[0].content).toContain("Transform current visible notes only.");
        expect(request.messages[0].content).toContain("Do not output tables in v1.");
        expect(request.messages[0].content).toContain("- No relevant notes captured.");
        expect(request.messages[0].content).toContain("{\"reorganisedMarkdown\":\"<reorganised notes markdown>\"}");
        expect(JSON.parse(request.messages[1].content).target_sections).toEqual(["Concepts", "Actions"]);
    });

    it("rejects malformed, missing, and suspiciously short reorganise output", async () => {
        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: "not json" } }],
        });

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-invalid-json",
        });

        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ summaryMarkdown: "wrong key" }) } }],
        });

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-missing-key",
        });

        openAiMock.create.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify({ reorganisedMarkdown: "## Too short\n\n- Summary." }) } }],
        });

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "reorganise-output-too-short",
        });
    });
});
