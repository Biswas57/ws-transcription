import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    generateNotesIncrementalPatch,
    parseFinalAttributes,
    reviseTranscription,
} from "../parse-gpt.js";
import {
    GPT_FLOW_CONFIG,
    GPT_FLOW_PROFILES,
    GPT_MODEL_PROFILE,
} from "../gpt/model-config.js";
import { buildNotesLivePatchRequest } from "../gpt/notes-live.js";

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

function provider400Error(message = "Invalid parameter: text.format.type"): Error {
    const err = new Error(message);
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
        expect(openAiMock.create.mock.calls[0][0].model).toBe(GPT_FLOW_CONFIG.formsLive.model);
        expect(openAiMock.create.mock.calls[0][0].store).toBe(false);
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("low");
        const instructions = openAiMock.create.mock.calls[0][0].messages[0].content;
        expect(instructions).toContain("Short answers such as \"yes\", \"no\", \"N/A\", names, dates, times, amounts, identifiers, and phone numbers are valid");
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
        expect(request.model).toBe(GPT_FLOW_CONFIG.formsFinal.model);
        expect(request.reasoning).toEqual({ effort: "medium" });
        expectJsonSchemaFormat(request, "forms_final_attributes_response", "finalAttributes");
        expect(request.text.format.schema.properties.finalAttributes.properties).toHaveProperty("answer");
        expect(request.text.format.schema.properties.finalAttributes.required).toEqual(["answer"]);
        expect(request.instructions).toContain("Short answers such as \"yes\", \"no\", names, dates, times, amounts, identifiers, and phone numbers may be complete values.");
        expect(request.instructions).toContain("If the transcript clearly says a field is not applicable, return \"N/A\".");
        expect(request.instructions).toContain("Use an empty string when no reliable value exists.");
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
            responsesJson(JSON.stringify({ finalAttributes: { answer: "yes" }, extra: "unexpected" })),
        ]) {
            openAiMock.responsesCreate.mockResolvedValueOnce(response);
            await expect(parseFinalAttributes(
                transcript,
                [{ block_name: "main", field_name: "answer" }],
                candidates
            )).resolves.toBe(candidates);
        }

        expect(openAiMock.chatCreate).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(5);

        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
        await expect(parseFinalAttributes(
            transcript,
            [{ block_name: "main", field_name: "answer" }],
            candidates
        )).resolves.toBe(candidates);
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(6);
    });

    it("returns raw Whisper text when revision model call throws", async () => {
        const raw = "This raw Whisper transcript should survive revision failure.";
        const rawProviderMessage = "UNIQUE_PROVIDER_MESSAGE_SHOULD_NOT_APPEAR text.format.type includes raw details";
        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error(rawProviderMessage));
        const providerLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const usageLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
            await expect(reviseTranscription(raw)).resolves.toBe(raw);
            expect(openAiMock.chatCreate).not.toHaveBeenCalled();
            expect(openAiMock.responsesCreate.mock.calls[0][0].model).toBe(GPT_FLOW_CONFIG.revision.model);
            expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "none" });
            expectJsonSchemaFormat(openAiMock.responsesCreate.mock.calls[0][0], "revision_response", "correctedText");
            expect(providerLog.mock.calls[0]?.[0]).toContain("Provider request failed");
            expect(providerLog.mock.calls[0]?.[0]).toContain("status: 400");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerCode: invalid_request_error");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerType: invalid_request_error");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerParam: text.format.type");
            expect(providerLog.mock.calls[0]?.[0]).toContain("requestId: req_safe123");
            expect(providerLog.mock.calls[0]?.[0]).toContain("providerCategory: provider_bad_request");
            expect(providerLog.mock.calls[0]?.[0]).toContain("textFormat: json_schema");
            expect(providerLog.mock.calls[0]?.[0]).toContain("schemaName: revision_response");
            expect(providerLog.mock.calls[0]?.[0]).not.toContain(raw);
            expect(providerLog.mock.calls[0]?.[0]).not.toContain(rawProviderMessage);
            expect(providerLog.mock.calls[0]?.[0]).not.toContain("providerMessage");
            const usageOutput = usageLog.mock.calls.flat().join("\n");
            expect(usageOutput).toContain("providerCategory: provider_bad_request");
            expect(usageOutput).not.toContain(rawProviderMessage);
        } finally {
            providerLog.mockRestore();
            usageLog.mockRestore();
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
        expect(request.model).toBe(GPT_FLOW_CONFIG.revision.model);
        expect(request.reasoning).toEqual({ effort: "none" });
        expectJsonSchemaFormat(request, "revision_response", "correctedText");
        expect(request.instructions).toContain("If uncertain, preserve the original wording.");
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
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({
                updates: [{
                    targetHeading: "Decisions",
                    targetLevel: 2,
                    appendMarkdown: "- Confirmed the backend keeps the old response shape.",
                }],
                fallbackAppendMarkdown: "",
            }))
        );

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
        expect(openAiMock.create).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate.mock.calls[0][0].model).toBe(GPT_FLOW_CONFIG.notesLive.model);
        expect(openAiMock.responsesCreate.mock.calls[0][0].store).toBe(false);
        expect(openAiMock.responsesCreate.mock.calls[0][0].max_output_tokens).toBe(1024);
        expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "low" });
        const instructions = openAiMock.responsesCreate.mock.calls[0][0].instructions;
        expect(instructions).toContain("The output is a delta, not a replacement document.");
        expect(instructions).toContain("usually within the first 2-4 meaningful updates");
        expect(instructions).toContain("Prefer 2-5 content-specific sections rather than one generic running list.");
        expect(instructions).toContain("Use fallbackAppendMarkdown when no existing heading fits");
        expect(instructions).toContain("Do not create a # document title.");
        expect(instructions).toContain('{"updates":[],"fallbackAppendMarkdown":""}');
        expect(instructions).not.toMatch(/fallback.*bullet-only/i);
        expectNoPromptExcludedLanguage(instructions);
    });

    it("builds bounded current-notes context for long Notes live patch requests", () => {
        const request = buildNotesLivePatchRequest(
            "The newest segment adds one action item.",
            LONG_NOTES,
            "meeting",
            ["Actions"]
        );
        const input = JSON.parse(request.input) as {
            current_notes: string;
            transcript_segment: string;
        };

        expect(request.currentNotesChars).toBe(LONG_NOTES.length);
        expect(request.contextCompacted).toBe(true);
        expect(request.currentNotesContextChars).toBeLessThan(request.currentNotesChars);
        expect(request.contextSavedChars).toBeGreaterThan(0);
        expect(request.headingCount).toBeGreaterThan(0);
        expect(input.current_notes.length).toBe(request.currentNotesContextChars);
        expect(input.current_notes).toContain("Compact current notes context for live patching");
        expect(input.current_notes).toContain("## Existing note outline");
        expect(input.current_notes).toContain("## Recent note tail");
        expect(input.current_notes).not.toContain("Detailed note 0 captures");
        expect(input.transcript_segment).toBe("The newest segment adds one action item.");
    });

    it("keeps short current notes unchanged in Notes live patch requests", () => {
        const current = "## Decisions\n\n- Existing decision.";
        const request = buildNotesLivePatchRequest(
            "The newest segment adds one action item.",
            current,
            "meeting",
            ["Decisions"]
        );
        const input = JSON.parse(request.input) as { current_notes: string };

        expect(request.currentNotesChars).toBe(current.length);
        expect(request.currentNotesContextChars).toBe(current.length);
        expect(request.contextCompacted).toBe(false);
        expect(request.contextSavedChars).toBe(0);
        expect(input.current_notes).toBe(current);
    });

    it("keeps current notes unchanged when notes incremental patch JSON is invalid", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(responsesJson("not valid json"));

        const current = "## Decisions\n\n- Existing decision.";
        await expect(generateNotesIncremental(
            "This segment should not become raw model output.",
            current,
            "meeting",
            ["Decisions"]
        )).resolves.toBe(current);
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(1);
        expect(openAiMock.create).not.toHaveBeenCalled();
    });

    it("returns a no-op patch when Notes live Responses provider fails", async () => {
        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());

        const patch = await generateNotesIncrementalPatch(
            "Responses failure should not mutate live notes.",
            "## Decisions\n\n- Existing decision.",
            "meeting",
            ["Decisions"]
        );

        expect(patch).toEqual({ updates: [] });
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(1);
        expect(openAiMock.create).not.toHaveBeenCalled();
    });

    it("passes bounded current-notes context through the Responses-only live path on failure", async () => {
        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());

        await expect(generateNotesIncrementalPatch(
            "Responses path used bounded context before failing.",
            LONG_NOTES,
            "meeting",
            ["Actions"]
        )).resolves.toMatchObject({
            updates: [],
        });

        const request = openAiMock.responsesCreate.mock.calls[0][0];
        const input = JSON.parse(request.input) as { current_notes: string };
        expect(input.current_notes).toContain("Compact current notes context for live patching");
        expect(input.current_notes.length).toBeLessThan(LONG_NOTES.length);
        expect(input.current_notes).not.toContain("Detailed note 0 captures");
        expect(openAiMock.create).not.toHaveBeenCalled();
    });

    it("uses the selected GPT workflow profile consistently", () => {
        expect(GPT_FLOW_CONFIG.notesLive).toBe(GPT_FLOW_PROFILES[GPT_MODEL_PROFILE].notesLive);
        expect(GPT_FLOW_CONFIG.reorganise).toBe(GPT_FLOW_PROFILES[GPT_MODEL_PROFILE].reorganise);
    });

    it("uses the Notes live Responses strict-schema provider by default", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({
                updates: [{
                    targetHeading: "Decisions",
                    targetLevel: 2,
                    appendMarkdown: "- Responses path can produce the same patch shape.",
                }],
                fallbackAppendMarkdown: "",
            }))
        );

        const patch = await generateNotesIncrementalPatch(
            "Responses path can produce the same patch shape.",
            "## Decisions\n\n- Existing decision.",
            "meeting",
            ["Decisions"]
        );

        expect(patch).toEqual({
            updates: [{
                targetHeading: "Decisions",
                targetLevel: 2,
                appendMarkdown: "- Responses path can produce the same patch shape.",
            }],
            fallbackAppendMarkdown: "",
        });
        expect(openAiMock.create).not.toHaveBeenCalled();
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(1);
        const request = openAiMock.responsesCreate.mock.calls[0][0];
        expect(request.model).toBe(GPT_FLOW_CONFIG.notesLive.model);
        expect(request.store).toBe(false);
        expect(request.reasoning).toEqual({ effort: "low" });
        expect(request.text?.format).toMatchObject({
            type: "json_schema",
            name: "notes_live_patch_response",
            strict: true,
        });
        expect(request.text?.format?.schema).toMatchObject({
            type: "object",
            additionalProperties: false,
            required: ["updates", "fallbackAppendMarkdown"],
        });
    });

    it("passes bounded current-notes context through the Responses live path", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({
                updates: [{
                    targetHeading: "Actions",
                    targetLevel: 2,
                    appendMarkdown: "- Responses path used bounded context.",
                }],
                fallbackAppendMarkdown: "",
            }))
        );

        try {
            await expect(generateNotesIncrementalPatch(
                "Responses path used bounded context.",
                LONG_NOTES,
                "meeting",
                ["Actions"]
            )).resolves.toMatchObject({
                updates: [{
                    targetHeading: "Actions",
                    targetLevel: 2,
                    appendMarkdown: "- Responses path used bounded context.",
                }],
            });

            const request = openAiMock.responsesCreate.mock.calls[0][0];
            const input = JSON.parse(request.input) as { current_notes: string };
            expect(input.current_notes).toContain("Compact current notes context for live patching");
            expect(input.current_notes.length).toBeLessThan(LONG_NOTES.length);
            expect(input.current_notes).not.toContain("Detailed note 0 captures");

            const logs = logSpy.mock.calls.flat().join("\n");
            expect(logs).toContain("notes-live-context-compacted");
            expect(logs).toContain("originalChars");
            expect(logs).toContain("contextChars");
            expect(logs).toContain("savedChars");
            expect(logs).not.toContain("Detailed note 0 captures");
            expect(logs).not.toContain("Session Notes");
        } finally {
            logSpy.mockRestore();
        }
    });

    it("applies default Notes live Responses patches through the existing markdown patcher", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({
                updates: [{
                    targetHeading: "Decisions",
                    targetLevel: 2,
                    appendMarkdown: "- Responses update still becomes full markdown for legacy callers.",
                }],
                fallbackAppendMarkdown: "",
            }))
        );

        const result = await generateNotesIncremental(
            "Responses update still becomes full markdown for legacy callers.",
            "## Decisions\n\n- Existing decision.",
            "meeting",
            ["Decisions"]
        );

        expect(result).toContain("## Decisions");
        expect(result).toContain("- Existing decision.");
        expect(result).toContain("- Responses update still becomes full markdown for legacy callers.");
        expect(result).not.toContain("\"updates\"");
    });

    it("returns safe no-op patches with safe diagnostics when Notes live Responses fails", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const secretTranscript = "UNIQUE_TRANSCRIPT_SHOULD_NOT_APPEAR_IN_LOGS";
        const secretNotes = "## Existing\n\n- UNIQUE_NOTE_SHOULD_NOT_APPEAR_IN_LOGS.";
        const cases = [
            {
                responseOrError: provider400Error(),
                category: "provider_error",
            },
            {
                responseOrError: responsesJson("not json"),
                category: "parse_failed",
            },
            {
                responseOrError: responsesJson(JSON.stringify({ updates: [] })),
                category: "schema_invalid",
            },
            {
                responseOrError: responsesJson(JSON.stringify({
                    updates: [{
                        targetHeading: "Decisions",
                        targetLevel: 2,
                        appendMarkdown: "- Valid fields plus extra should fail strict shape.",
                        extra: "unexpected",
                    }],
                    fallbackAppendMarkdown: "",
                    extra: "unexpected",
                })),
                category: "schema_invalid",
            },
            {
                responseOrError: responsesJson(""),
                category: "empty_output",
            },
            {
                responseOrError: responsesJson(
                    JSON.stringify({
                        updates: [{
                            targetHeading: "Decisions",
                            targetLevel: 2,
                            appendMarkdown: "- Partial Responses patch.",
                        }],
                        fallbackAppendMarkdown: "",
                    }),
                    {
                        status: "incomplete",
                        incomplete_details: { reason: "max_output_tokens" },
                    }
                ),
                category: "incomplete_response",
            },
        ] as const;

        try {
            for (const { responseOrError } of cases) {
                if (responseOrError instanceof Error) {
                    openAiMock.responsesCreate.mockRejectedValueOnce(responseOrError);
                } else {
                    openAiMock.responsesCreate.mockResolvedValueOnce(responseOrError);
                }

                await expect(generateNotesIncrementalPatch(
                    `${secretTranscript} Responses failure should preserve current notes.`,
                    secretNotes,
                    "meeting",
                    ["Decisions"]
                )).resolves.toMatchObject({
                    updates: [],
                });
            }

            const warnOutput = warnSpy.mock.calls.flat().join("\n");
            const allOutput = [
                warnOutput,
                logSpy.mock.calls.flat().join("\n"),
            ].join("\n");

            for (const { category } of cases) {
                expect(warnOutput).toContain(`category: ${category}`);
            }
            expect(allOutput).toContain("Provider selected");
            expect(allOutput).toContain("provider: responses");
            expect(allOutput).toContain("notes_live_patch_failed");
            expect(allOutput).not.toContain("fallbackUsed: true");
            expect(allOutput).not.toContain(secretTranscript);
            expect(allOutput).not.toContain(secretNotes);
            expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(cases.length);
            expect(openAiMock.create).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it("preserves current markdown if the Responses-only live patch fails", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
            const current = "## Decisions\n\n- Existing decision.";

            await expect(generateNotesIncremental(
                "Responses provider failed before producing a live patch.",
                current,
                "meeting",
                ["Decisions"]
            )).resolves.toBe(current);

            expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(1);
            expect(openAiMock.create).not.toHaveBeenCalled();
            expect(warnSpy.mock.calls.flat().join("\n")).toContain("Patch failed, preserving current notes");
        } finally {
            warnSpy.mockRestore();
        }
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
        expect(request.model).toBe(GPT_FLOW_CONFIG.notesFinal.model);
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.max_output_tokens).toBe(2048);
        expectJsonSchemaFormat(request, "notes_final_response", "notesMarkdown");
        expect(request.instructions).toContain("current_notes is the canonical accumulated draft and primary continuity source.");
        expect(request.instructions).toContain("Do not remove useful current_notes content solely because it is absent from available_transcript.");
        expect(request.instructions).toContain("User edits are not separately labelled");
        expect(request.instructions).toContain("A clear transcript correction overrides an outdated note.");
        expect(request.instructions).toContain("Duplicate sections and repeated bullets");
        expect(request.instructions).toContain("Temporary headings such as \"Live updates\"");
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
            responsesJson(JSON.stringify({ notesMarkdown: "## Final", extra: "unexpected" })),
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
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(5);

        openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
        await expect(finalizeNotes(
            transcript,
            currentNotes,
            "meeting",
            ["Summary"]
        )).resolves.toBe(currentNotes);
        expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(6);
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
        expect(request.model).toBe(GPT_FLOW_CONFIG.summarise.model);
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.max_output_tokens).toBeGreaterThan(2532);
        expectJsonSchemaFormat(request, "notes_summary_response", "summaryMarkdown");
        expect(request.instructions).toContain("Produce a shorter review-oriented version");
        expect(request.instructions).toContain("not a full rewrite and not a reorganisation-only task");
        expect(request.instructions).toContain("Medium and long notes should become visibly shorter.");
        expect(request.instructions).toContain("Do not preserve every source bullet.");
        expect(request.instructions).toContain("Keep the governing rule, exception, owner, action, constraint, risk, deadline, and unresolved issue");
        expect(request.instructions).toContain("Do not add a Quick Checklist unless explicitly requested in the source notes.");
        expect(request.instructions).toContain("Use only current_visible_notes.");
        expect(request.instructions).not.toContain("Preserve important facts, definitions, actions, caveats, risks, dates, numbers, commands, IDs, technical terms, product names, names, and relevant examples.");
        expectNoPromptExcludedLanguage(request.instructions);
        expect(JSON.parse(request.input).current_visible_notes).toBe(LONG_NOTES);
    });

    it("handles fenced summary JSON and rejects common summary alias keys", async () => {
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson("```json\n{\"summaryMarkdown\":\"## Summary\\n\\n- Fenced summary.\"}\n```")
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            summaryMarkdown: "## Summary\n\n- Fenced summary.",
        });

        for (const aliasKey of ["notesMarkdown", "markdown", "outputMarkdown"]) {
            openAiMock.responsesCreate.mockResolvedValueOnce(
                responsesJson(JSON.stringify({ [aliasKey]: "## Summary\n\n- Alias summary." }))
            );

            await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
                code: "transform-output-missing-key",
                details: expect.objectContaining({
                    stage: "missing-key",
                    jsonKeys: [aliasKey],
                    expectedKey: "summaryMarkdown",
                }),
            });
        }
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
            responsesJson(JSON.stringify({
                summaryMarkdown: "## Summary\n\n- Condensed.",
                extra: "unexpected",
            }))
        );

        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-unexpected-key",
            details: expect.objectContaining({
                stage: "unexpected-key",
                jsonKeys: ["summaryMarkdown", "extra"],
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
        expect(request.model).toBe(GPT_FLOW_CONFIG.reorganise.model);
        expect(request.reasoning).toEqual({ effort: "low" });
        expect(request.max_output_tokens).toBeGreaterThan(3289);
        expectJsonSchemaFormat(request, "notes_reorganise_response", "reorganisedMarkdown");
        expect(request.instructions).toContain("Reorganise current_visible_notes into a clearer structure while preserving nearly all useful detail.");
        expect(request.instructions).toContain("Preserve more detail than a summary would.");
        expect(request.instructions).toContain("- No relevant notes captured.");
        expect(request.instructions).toContain("{\"reorganisedMarkdown\":\"<reorganised markdown>\"}");
        expectNoPromptExcludedLanguage(request.instructions);
        expect(JSON.parse(request.input).target_sections).toEqual(["Concepts", "Actions"]);
    });

    it("rejects common reorganise alias keys", async () => {
        for (const aliasKey of ["notesMarkdown", "markdown", "outputMarkdown"]) {
            openAiMock.responsesCreate.mockResolvedValueOnce(
                responsesJson(JSON.stringify({ [aliasKey]: `${LONG_NOTES}\n\n## Actions\n\n- Alias output.` }))
            );

            await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
                code: "transform-output-missing-key",
                details: expect.objectContaining({
                    stage: "missing-key",
                    jsonKeys: [aliasKey],
                    expectedKey: "reorganisedMarkdown",
                }),
            });
        }
    });

    it("keeps Reorganise low by default and final-quality calls medium", async () => {
        const reorganised = `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`;
        openAiMock.responsesCreate
            .mockResolvedValueOnce(responsesJson(JSON.stringify({ reorganisedMarkdown: reorganised })))
            .mockResolvedValueOnce(responsesJson(JSON.stringify({ summaryMarkdown: "## Summary\n\n- Condensed." })))
            .mockResolvedValueOnce(responsesJson(JSON.stringify({ notesMarkdown: "## Summary\n\n- Final note." })))
            .mockResolvedValueOnce(responsesJson(JSON.stringify({ finalAttributes: { answer: "yes" } })));

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            reorganisedMarkdown: reorganised,
        });
        await expect(generateNotesSummary({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            summaryMarkdown: "## Summary\n\n- Condensed.",
        });
        await expect(finalizeNotes(
            "This is a sufficiently detailed transcript for the final notes pass.",
            "## Draft\n\n- Existing note.",
            "meeting",
            ["Summary"]
        )).resolves.toBe("## Summary\n\n- Final note.");
        await expect(parseFinalAttributes(
            "yes",
            [{ block_name: "main", field_name: "answer" }],
            { answer: "" }
        )).resolves.toEqual({ answer: "yes" });

        expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "low" });
        expect(openAiMock.responsesCreate.mock.calls[1][0].reasoning).toEqual({ effort: "medium" });
        expect(openAiMock.responsesCreate.mock.calls[2][0].reasoning).toEqual({ effort: "medium" });
        expect(openAiMock.responsesCreate.mock.calls[3][0].reasoning).toEqual({ effort: "medium" });
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
            responsesJson(JSON.stringify({
                reorganisedMarkdown: `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`,
                extra: "unexpected",
            }))
        );

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).rejects.toMatchObject({
            code: "transform-output-unexpected-key",
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
