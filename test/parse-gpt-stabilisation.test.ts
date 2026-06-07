import { describe, it, expect, beforeEach, vi } from "vitest";

const openAiMock = vi.hoisted(() => {
    const chatCreate = vi.fn();
    const responsesCreate = vi.fn();
    return {
        chatCreate,
        responsesCreate,
        create: chatCreate,
    };
});

vi.mock("openai", () => ({
    OpenAI: vi.fn(() => ({
        chat: {
            completions: {
                create: openAiMock.chatCreate,
            },
        },
        responses: {
            create: openAiMock.responsesCreate,
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

function responsesJson(content: string, overrides: Record<string, unknown> = {}) {
    return {
        output_text: content,
        status: "completed",
        incomplete_details: null,
        usage: {
            input_tokens: 12,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 8,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 20,
        },
        ...overrides,
    };
}

describe("parse-gpt stabilisation", () => {
    beforeEach(() => {
        openAiMock.chatCreate.mockReset();
        openAiMock.responsesCreate.mockReset();
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
        expect(openAiMock.create.mock.calls[0][0].model).toBe("gpt-5.4-mini");
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("low");
    });

    it("runs final extraction for one-word Forms values", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ finalAttributes: { answer: "yes" } }))
        );

        const result = await parseFinalAttributes(
            "yes",
            [{ block_name: "main", field_name: "answer" }],
            { answer: "" }
        );

        expect(result).toEqual({ answer: "yes" });
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(1);
        const request = openAiMock.responsesCreate.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.text).toEqual({ format: { type: "json_object" } });
        expect(JSON.parse(request.input).full_transcript).toBe("yes");
    });

    it("returns candidate attributes for incomplete, empty, invalid, and missing-key final extraction output", async () => {
        const transcript = "The answer is yes and the follow-up is tomorrow.";
        const candidates = { answer: "maybe" };

        for (const response of [
            responsesJson(
                JSON.stringify({ finalAttributes: { answer: "yes" } }),
                {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                }
            ),
            responsesJson(""),
            responsesJson("not json"),
            responsesJson(JSON.stringify({ wrongKey: { answer: "yes" } })),
        ]) {
            openAiMock.responsesCreate.mockResolvedValueOnce(response);
            await expect(parseFinalAttributes(
                transcript,
                [{ block_name: "main", field_name: "answer" }],
                candidates
            )).resolves.toBe(candidates);
        }

        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(4);
    });

    it("returns raw Whisper text when revision model call throws", async () => {
        const raw = "This raw Whisper transcript should survive revision failure.";
        const err = new Error("simulated provider failure");
        (err as Error & { code?: string }).code = "ETIMEDOUT";
        openAiMock.responsesCreate.mockRejectedValueOnce(err);

        await expect(reviseTranscription(raw)).resolves.toBe(raw);
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate.mock.calls[0][0].model).toBe("gpt-5.4-mini");
        expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "none" });
        expect(openAiMock.responsesCreate.mock.calls[0][0].text).toEqual({ format: { type: "json_object" } });
    });

    it("uses Responses API for revision and returns corrected text on valid JSON", async () => {
        const raw = "This raw Whisper transcript needs spelling correction today.";
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ correctedText: "This revised transcript keeps the intended meaning." }))
        );

        await expect(reviseTranscription(raw)).resolves.toBe(
            "This revised transcript keeps the intended meaning."
        );
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        const request = openAiMock.responsesCreate.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.4-mini");
        expect(request.reasoning).toEqual({ effort: "none" });
        expect(request.text).toEqual({ format: { type: "json_object" } });
        expect(request.max_output_tokens).toBeGreaterThan(0);
    });

    it("fails open for invalid, empty, missing-key, and incomplete revision Responses output", async () => {
        const raw = "This raw Whisper transcript should survive every bad revision output.";

        for (const response of [
            responsesJson("not json"),
            responsesJson(""),
            responsesJson(JSON.stringify({ wrongKey: "No corrected text." })),
            responsesJson(
                JSON.stringify({ correctedText: "Partial" }),
                {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                }
            ),
        ]) {
            openAiMock.responsesCreate.mockResolvedValueOnce(response);
            await expect(reviseTranscription(raw)).resolves.toBe(raw);
        }

        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(4);
    });

    it("skips Notes revision for short or sparse transcript batches", async () => {
        await expect(reviseTranscription(
            "Short Notes fragment with under forty chars.",
            { mode: "notes" }
        )).resolves.toBe("Short Notes fragment with under forty chars.");

        const sparse = "Architecture stabilisation requires precise rollout sequencing.";
        await expect(reviseTranscription(sparse, { mode: "notes" })).resolves.toBe(sparse);

        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).not.toHaveBeenCalled();
    });

    it("skips Forms revision for short field-like values without dropping them", async () => {
        for (const value of ["yes", "John", "$500", "12 June", "3pm", "N/A", "sam@example.com", "+61 400 123 456"]) {
            await expect(reviseTranscription(value, { mode: "forms" })).resolves.toBe(value);
        }

        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).not.toHaveBeenCalled();
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
        expect(openAiMock.create.mock.calls[0][0].model).toBe("gpt-5.4-mini");
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
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ notesMarkdown: "## Summary\n\n- Final note." }))
        );

        const result = await finalizeNotes(
            "This is a sufficiently detailed transcript for the final notes pass.",
            "## Draft\n\n- Existing note.",
            "meeting",
            ["Summary"]
        );

        expect(result).toBe("## Summary\n\n- Final note.");
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        const request = openAiMock.responsesCreate.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.text).toEqual({ format: { type: "json_object" } });
        expect(JSON.parse(request.input).current_notes).toBe("## Draft\n\n- Existing note.");
    });

    it("returns current notes for incomplete, empty, invalid, and missing-key Notes final output", async () => {
        const transcript = "This is a sufficiently detailed transcript for the final notes pass.";
        const currentNotes = "## Draft\n\n- Existing note.";

        for (const response of [
            responsesJson(
                JSON.stringify({ notesMarkdown: "## Partial" }),
                {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                }
            ),
            responsesJson(""),
            responsesJson("not json"),
            responsesJson(JSON.stringify({ wrongKey: "## Missing" })),
        ]) {
            openAiMock.responsesCreate.mockResolvedValueOnce(response);
            await expect(finalizeNotes(
                transcript,
                currentNotes,
                "meeting",
                ["Summary"]
            )).resolves.toBe(currentNotes);
        }

        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(4);
    });

    it("generates notes summaries with final-quality reasoning and required prompt constraints", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ summaryMarkdown: "## Summary\n\n- Condensed note." }))
        );

        const result = await generateNotesSummary({
            notesMarkdown: LONG_NOTES,
            noteStyle: "meeting",
        });

        expect(result).toEqual({ summaryMarkdown: "## Summary\n\n- Condensed note." });
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        const request = openAiMock.responsesCreate.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.text).toEqual({ format: { type: "json_object" } });
        expect(request.instructions).toContain("Transform current visible notes only.");
        expect(request.instructions).toContain("Do not add a \"Quick Checklist\" unless explicitly requested in the notes.");
        expect(request.instructions).toContain("If a question is answered elsewhere");
        expect(request.instructions).toContain("Preserve existing structure where possible.");
        expect(JSON.parse(request.input).current_visible_notes).toBe(LONG_NOTES);
    });

    it("handles fenced summary JSON and common summary alias keys", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson("```json\n{\"summaryMarkdown\":\"## Summary\\n\\n- Fenced summary.\"}\n```")
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            summaryMarkdown: "## Summary\n\n- Fenced summary.",
        });

        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ notesMarkdown: "## Summary\n\n- Alias summary." }))
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            summaryMarkdown: "## Summary\n\n- Alias summary.",
        });
    });

    it("rejects malformed, missing, empty, and error-like summary output with specific codes", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(responsesJson("not json"));

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-invalid-json",
        });

        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ summary: "wrong key" }))
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-missing-key",
            details: expect.objectContaining({
                stage: "missing-key",
                jsonKeys: ["summary"],
                expectedKey: "summaryMarkdown",
            }),
        });

        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ summaryMarkdown: "   " }))
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-empty",
        });

        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ summaryMarkdown: "Error: unable to summarise." }))
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-error-like",
        });
    });

    it("rejects incomplete summary Responses output without returning partial markdown", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(
                JSON.stringify({ summaryMarkdown: "## Partial" }),
                {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                }
            )
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-incomplete",
            details: expect.objectContaining({
                stage: "incomplete-response",
                expectedKey: "summaryMarkdown",
                incompleteReason: "max_output_tokens",
            }),
        });
    });

    it("generates notes reorganisations with required prompt constraints", async () => {
        const reorganised = `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`;
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ reorganisedMarkdown: reorganised }))
        );

        const result = await generateNotesReorganisation({
            notesMarkdown: LONG_NOTES,
            noteStyle: "study",
            targetSections: ["Concepts", "Actions"],
        });

        expect(result).toEqual({ reorganisedMarkdown: reorganised });
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        const request = openAiMock.responsesCreate.mock.calls[0][0];
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.text).toEqual({ format: { type: "json_object" } });
        expect(request.instructions).toContain("Transform current visible notes only.");
        expect(request.instructions).toContain("Do not output tables in v1.");
        expect(request.instructions).toContain("- No relevant notes captured.");
        expect(request.instructions).toContain("{\"reorganisedMarkdown\":\"<reorganised notes markdown>\"}");
        expect(JSON.parse(request.input).target_sections).toEqual(["Concepts", "Actions"]);
    });

    it("rejects malformed, missing, and suspiciously short reorganise output", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(responsesJson("not json"));

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-invalid-json",
        });

        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ summaryMarkdown: "wrong key" }))
        );

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-missing-key",
        });

        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ reorganisedMarkdown: "## Too short\n\n- Summary." }))
        );

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "reorganise-output-too-short",
        });
    });

    it("rejects incomplete reorganise Responses output without returning partial markdown", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(
                JSON.stringify({ reorganisedMarkdown: `${LONG_NOTES}\n\n## Partial` }),
                {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                }
            )
        );

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-incomplete",
            details: expect.objectContaining({
                stage: "incomplete-response",
                expectedKey: "reorganisedMarkdown",
                incompleteReason: "max_output_tokens",
            }),
        });
    });
});
