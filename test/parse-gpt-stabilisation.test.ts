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

function provider400Error(): Error {
    const err = new Error("Invalid parameter: text.format.type");
    Object.assign(err, {
        status: 400,
        code: "invalid_request_error",
        type: "invalid_request_error",
        param: "text.format.type",
        request_id: "req_safe123",
    });
    return err;
}

function expectJsonSchemaFormat(
    request: { text?: { format?: Record<string, unknown> } },
    name: string,
    key: string
) {
    expect(request).toMatchObject({ store: false });
    expect(request.text?.format).toMatchObject({
        type: "json_schema",
        name,
        strict: true,
    });
    expect(request.text?.format?.schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: [key],
        properties: expect.objectContaining({
            [key]: expect.any(Object),
        }),
    });
}

function expectNoPromptExcludedLanguage(instructions: string) {
    expect(instructions).not.toMatch(/\bmarkdown tables?\b/i);
    expect(instructions).not.toMatch(/\btables?\b/i);
    expect(instructions).not.toMatch(/\b(sponsors?|promos?|promotions?)\b/i);
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
        expect(openAiMock.create.mock.calls[0][0].store).toBe(false);
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("low");
        const instructions = openAiMock.create.mock.calls[0][0].messages[0].content;
        expect(instructions).toContain("Short values such as \"yes\", \"no\", names, dates, times, dollar amounts, phone numbers, and \"N/A\" can be complete valid answers");
        expectNoPromptExcludedLanguage(instructions);
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
        expectJsonSchemaFormat(request, "forms_final_attributes_response", "finalAttributes");
        expect(request.text.format.schema.properties.finalAttributes.properties).toHaveProperty("answer");
        expect(request.text.format.schema.properties.finalAttributes.required).toEqual(["answer"]);
        expect(request.instructions).toContain("Short values such as \"yes\", \"no\", names, dates, times, dollar amounts, phone numbers, and \"N/A\" can be complete valid answers");
        expect(request.instructions).toContain("If the transcript clearly states that a field is not applicable, return \"N/A\".");
        expect(request.instructions).toContain("If no information exists for a field, return an empty string.");
        expectNoPromptExcludedLanguage(request.instructions);
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

        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
        await expect(parseFinalAttributes(
            transcript,
            [{ block_name: "main", field_name: "answer" }],
            candidates
        )).resolves.toBe(candidates);
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(5);
    });

    it("returns raw Whisper text when revision model call throws", async () => {
        const raw = "This raw Whisper transcript should survive revision failure.";
        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
        const providerLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

        try {
            await expect(reviseTranscription(raw)).resolves.toBe(raw);
            expect(openAiMock.chatCreate).not.toHaveBeenCalled();
            expect(openAiMock.responsesCreate.mock.calls[0][0].model).toBe("gpt-5.4-mini");
            expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "none" });
            expectJsonSchemaFormat(openAiMock.responsesCreate.mock.calls[0][0], "revision_response", "correctedText");
            expect(providerLog.mock.calls[0]?.[0]).toContain("Provider request failed");
            expect(providerLog.mock.calls[0]?.[0]).toContain("status: 400");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerCode: invalid_request_error");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerType: invalid_request_error");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerParam: text.format.type");
            expect(providerLog.mock.calls[0]?.[0]).toContain("requestId: req_safe123");
            expect(providerLog.mock.calls[0]?.[0]).toContain("textFormat: json_schema");
            expect(providerLog.mock.calls[0]?.[0]).toContain("schemaName: revision_response");
            expect(providerLog.mock.calls[0]?.[0]).not.toContain(raw);
        } finally {
            providerLog.mockRestore();
        }
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
        expectJsonSchemaFormat(request, "revision_response", "correctedText");
        expect(request.instructions).toContain("If unsure, preserve the original wording.");
        expectNoPromptExcludedLanguage(request.instructions);
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
        expect(openAiMock.create.mock.calls[0][0].store).toBe(false);
        expect(openAiMock.create.mock.calls[0][0].max_completion_tokens).toBe(1024);
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("low");
        const instructions = openAiMock.create.mock.calls[0][0].messages[0].content;
        expect(instructions).toContain("Create useful structure once enough signal exists");
        expect(instructions).toContain("As the session develops, prefer content-specific headings over generic headings.");
        expect(instructions).toContain("When transcript_segment introduces a clear new major topic, create or use an appropriate ## heading.");
        expect(instructions).toContain("After the first few updates, avoid continuing under one broad or generic section when clearer topic sections are available.");
        expect(instructions).toContain("Prefer headings based on the actual content");
        expect(instructions).toContain("fallbackAppendMarkdown with a concise new ## heading");
        expect(instructions).toContain("Do not create a # document title in live updates.");
        expect(instructions).toContain("Return append instructions only.");
        expect(instructions).not.toMatch(/fallback.*bullet-only/i);
        expectNoPromptExcludedLanguage(instructions);
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
        expect(request.max_output_tokens).toBe(2048);
        expectJsonSchemaFormat(request, "notes_final_response", "notesMarkdown");
        expect(request.instructions).toContain("Treat current_notes as the canonical draft");
        expect(request.instructions).toContain("Manual edits are not separately marked as immutable");
        expect(request.instructions).toContain("Do not keep a \"Live updates\" section in the final notes.");
        expect(request.instructions).toContain("- No relevant notes captured.");
        expectNoPromptExcludedLanguage(request.instructions);
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

        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
        await expect(finalizeNotes(
            transcript,
            currentNotes,
            "meeting",
            ["Summary"]
        )).resolves.toBe(currentNotes);
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(5);
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
        expect(request.max_output_tokens).toBeGreaterThan(2532);
        expectJsonSchemaFormat(request, "notes_summary_response", "summaryMarkdown");
        expect(request.instructions).toContain("Transform current visible notes only.");
        expect(request.instructions).toContain("Do not add a Quick Checklist unless explicitly requested in the notes.");
        expect(request.instructions).toContain("Compression should be adaptive");
        expect(request.instructions).toContain("preserving the existing structure where it is already useful, and simplifying it where it is overly detailed or repetitive");
        expect(request.instructions).toContain("Preserve existing structure where it improves reviewability.");
        expect(request.instructions).toContain("produce a visibly shorter review version");
        expect(request.instructions).toContain("Long notes should usually be meaningfully shorter");
        expect(request.instructions).toContain("do not force an exact percentage");
        expect(request.instructions).toContain("a useful summary may be around 60-75% of the original length");
        expect(request.instructions).toContain("accuracy and reviewability are more important than hitting a fixed ratio");
        expect(request.instructions).toContain("reduce both wording and structure");
        expect(request.instructions).toContain("avoid preserving a one-to-one outline of the source");
        expect(request.instructions).toContain("clearly different from a reorganised version of the same notes");
        expect(request.instructions).toContain("Remove repeated framing, duplicated explanation, transcript-like wording, and overly granular supporting detail.");
        expect(request.instructions).toContain("Merge small or overlapping bullets where meaning is preserved.");
        expect(request.instructions).toContain("Compress supporting detail while preserving key facts, dates, numbers, names, definitions, actions, caveats, risks, commands, IDs, technical terms, product names, and representative examples.");
        expect(request.instructions).toContain("If a question is answered elsewhere in current_visible_notes");
        expect(request.instructions).toContain("For long notes, merge clearly related or lower-priority headings when doing so preserves the key meaning and makes the result easier to review.");
        expect(request.instructions).toContain("Use only current_visible_notes.");
        expect(request.instructions).not.toContain("Preserve important facts, definitions, actions, caveats, risks, dates, numbers, commands, IDs, technical terms, product names, names, and relevant examples.");
        expectNoPromptExcludedLanguage(request.instructions);
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

    it("maps transform provider 400s to safe transform errors", async () => {
        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-provider-error",
            details: expect.objectContaining({
                stage: "provider-error",
            }),
        });
        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
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
        expect(request.max_output_tokens).toBeGreaterThan(3289);
        expectJsonSchemaFormat(request, "notes_reorganise_response", "reorganisedMarkdown");
        expect(request.instructions).toContain("Transform current visible notes only.");
        expect(request.instructions).toContain("Preserve more useful detail and examples than Summarise would.");
        expect(request.instructions).toContain("- No relevant notes captured.");
        expect(request.instructions).toContain("{\"reorganisedMarkdown\":\"<reorganised notes markdown>\"}");
        expectNoPromptExcludedLanguage(request.instructions);
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
