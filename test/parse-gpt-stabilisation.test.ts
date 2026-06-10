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
    getNotesLiveProviderMode,
    reorganiseReasoningEffort,
} from "../gpt/model-config.js";
import { buildNotesLivePatchRequest } from "../gpt/notes-live.js";

const ORIGINAL_REORGANISE_REASONING = process.env.FORMIFY_REORGANISE_REASONING;
const ORIGINAL_NOTES_LIVE_PROVIDER = process.env.FORMIFY_NOTES_LIVE_PROVIDER;

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
        delete process.env.FORMIFY_REORGANISE_REASONING;
        delete process.env.FORMIFY_NOTES_LIVE_PROVIDER;
    });

    afterEach(() => {
        if (ORIGINAL_REORGANISE_REASONING === undefined) {
            delete process.env.FORMIFY_REORGANISE_REASONING;
        } else {
            process.env.FORMIFY_REORGANISE_REASONING = ORIGINAL_REORGANISE_REASONING;
        }

        if (ORIGINAL_NOTES_LIVE_PROVIDER === undefined) {
            delete process.env.FORMIFY_NOTES_LIVE_PROVIDER;
        } else {
            process.env.FORMIFY_NOTES_LIVE_PROVIDER = ORIGINAL_NOTES_LIVE_PROVIDER;
        }
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
        expect(openAiMock.responsesCreate.mock.calls[0][0].model).toBe("gpt-5.4-mini");
        expect(openAiMock.responsesCreate.mock.calls[0][0].store).toBe(false);
        expect(openAiMock.responsesCreate.mock.calls[0][0].max_output_tokens).toBe(1024);
        expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "low" });
        const instructions = openAiMock.responsesCreate.mock.calls[0][0].instructions;
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
        process.env.FORMIFY_NOTES_LIVE_PROVIDER = "chat";
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

    it("can force Notes live back to Chat with the rollback provider env", async () => {
        process.env.FORMIFY_NOTES_LIVE_PROVIDER = "chat";
        openAiMock.create.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: JSON.stringify({
                        updates: [{
                            targetHeading: "Decisions",
                            targetLevel: 2,
                            appendMarkdown: "- Chat path still owns default live notes.",
                        }],
                    }),
                },
            }],
        });

        const patch = await generateNotesIncrementalPatch(
            "Chat path is still the rollback for live notes.",
            "## Decisions\n\n- Existing decision.",
            "meeting",
            ["Decisions"]
        );

        expect(patch.updates).toHaveLength(1);
        expect(openAiMock.create).toHaveBeenCalledTimes(1);
        expect(openAiMock.responsesCreate).not.toHaveBeenCalled();
        expect(openAiMock.create.mock.calls[0][0].model).toBe("gpt-5.4-mini");
        expect(openAiMock.create.mock.calls[0][0].store).toBe(false);
        expect(openAiMock.create.mock.calls[0][0].reasoning_effort).toBe("low");
    });

    it("passes bounded current-notes context through the Chat live rollback path", async () => {
        process.env.FORMIFY_NOTES_LIVE_PROVIDER = "chat";
        openAiMock.create.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: JSON.stringify({
                        updates: [{
                            targetHeading: "Actions",
                            targetLevel: 2,
                            appendMarkdown: "- Chat path used bounded context.",
                        }],
                    }),
                },
            }],
        });

        await expect(generateNotesIncrementalPatch(
            "Chat path used bounded context.",
            LONG_NOTES,
            "meeting",
            ["Actions"]
        )).resolves.toMatchObject({
            updates: [{
                targetHeading: "Actions",
                targetLevel: 2,
                appendMarkdown: "- Chat path used bounded context.",
            }],
        });

        const request = openAiMock.create.mock.calls[0][0];
        const input = JSON.parse(request.messages[1].content) as { current_notes: string };
        expect(input.current_notes).toContain("Compact current notes context for live patching");
        expect(input.current_notes.length).toBeLessThan(LONG_NOTES.length);
        expect(input.current_notes).not.toContain("Detailed note 0 captures");
    });

    it("resolves Notes live provider mode from env with Responses as the default", () => {
        const configWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            expect(getNotesLiveProviderMode({} as NodeJS.ProcessEnv)).toBe("responses");
            expect(getNotesLiveProviderMode({
                FORMIFY_NOTES_LIVE_PROVIDER: "chat",
            } as NodeJS.ProcessEnv)).toBe("chat");
            expect(getNotesLiveProviderMode({
                FORMIFY_NOTES_LIVE_PROVIDER: "responses",
            } as NodeJS.ProcessEnv)).toBe("responses");
            expect(getNotesLiveProviderMode({
                FORMIFY_NOTES_LIVE_PROVIDER: "fast",
            } as NodeJS.ProcessEnv)).toBe("responses");
            expect(configWarn.mock.calls[0]?.[0]).toContain("Invalid FORMIFY_NOTES_LIVE_PROVIDER");
            expect(configWarn.mock.calls[0]?.[0]).toContain("using responses");
        } finally {
            configWarn.mockRestore();
        }
    });

    it("resolves Reorganise reasoning from env with low as the default", () => {
        const configWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            expect(reorganiseReasoningEffort({} as NodeJS.ProcessEnv)).toBe("low");
            expect(reorganiseReasoningEffort({
                FORMIFY_REORGANISE_REASONING: "low",
            } as NodeJS.ProcessEnv)).toBe("low");
            expect(reorganiseReasoningEffort({
                FORMIFY_REORGANISE_REASONING: "medium",
            } as NodeJS.ProcessEnv)).toBe("medium");
            expect(reorganiseReasoningEffort({
                FORMIFY_REORGANISE_REASONING: "fast",
            } as NodeJS.ProcessEnv)).toBe("low");
            expect(configWarn.mock.calls[0]?.[0]).toContain("Invalid FORMIFY_REORGANISE_REASONING");
            expect(configWarn.mock.calls[0]?.[0]).toContain("using low");
        } finally {
            configWarn.mockRestore();
        }
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
        expect(request.model).toBe("gpt-5.4-mini");
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

    it("falls back to Chat once with safe canary diagnostics when Notes live Responses fails", async () => {
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
                category: "schema_failed",
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
                category: "schema_failed",
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
                process.env.FORMIFY_NOTES_LIVE_PROVIDER = "responses";
                if (responseOrError instanceof Error) {
                    openAiMock.responsesCreate.mockRejectedValueOnce(responseOrError);
                } else {
                    openAiMock.responsesCreate.mockResolvedValueOnce(responseOrError);
                }
                openAiMock.create.mockResolvedValueOnce({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                updates: [{
                                    targetHeading: "Decisions",
                                    targetLevel: 2,
                                    appendMarkdown: "- Chat fallback preserved the live update.",
                                }],
                            }),
                        },
                    }],
                });

                await expect(generateNotesIncrementalPatch(
                    `${secretTranscript} Chat fallback preserved the live update.`,
                    secretNotes,
                    "meeting",
                    ["Decisions"]
                )).resolves.toMatchObject({
                    updates: [{
                        targetHeading: "Decisions",
                        targetLevel: 2,
                        appendMarkdown: "- Chat fallback preserved the live update.",
                    }],
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
            expect(allOutput).toContain("fallbackUsed: true");
            expect(allOutput).not.toContain(secretTranscript);
            expect(allOutput).not.toContain(secretNotes);
            expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(cases.length);
            expect(openAiMock.create).toHaveBeenCalledTimes(cases.length);
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it("returns a safe no-op patch if the Chat fallback output is invalid", async () => {
        process.env.FORMIFY_NOTES_LIVE_PROVIDER = "responses";
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            openAiMock.responsesCreate.mockRejectedValueOnce(provider400Error());
            openAiMock.create.mockResolvedValueOnce({
                choices: [{ message: { content: "not json" } }],
            });

            await expect(generateNotesIncrementalPatch(
                "Chat fallback output is malformed.",
                "## Decisions\n\n- Existing decision.",
                "meeting",
                ["Decisions"]
            )).resolves.toMatchObject({
                updates: [],
                parseFailed: true,
            });

            expect(openAiMock.responsesCreate).toHaveBeenCalledTimes(1);
            expect(openAiMock.create).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls.flat().join("\n")).toContain("JSON parse failed");
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
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.max_output_tokens).toBe(2048);
        expectJsonSchemaFormat(request, "notes_final_response", "notesMarkdown");
        expect(request.instructions).toContain("Treat current_notes as the canonical draft");
        expect(request.instructions).toContain("Manual edits are not separately marked as immutable");
        expect(request.instructions).toContain("If available_transcript is sparse, partial, or mostly confirms the existing draft");
        expect(request.instructions).toContain("If available_transcript corrects current_notes, apply the correction");
        expect(request.instructions).toContain("If current_notes and available_transcript repeat the same idea, keep one clean final version");
        expect(request.instructions).toContain("Preserve unresolved questions, TODOs, user-provided actions, owners, dates, constraints, warnings, decisions");
        expect(request.instructions).toContain("Do not preserve live-note artefacts");
        expect(request.instructions).toContain("not a raw merge");
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
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "medium" });
        expect(request.max_output_tokens).toBeGreaterThan(2532);
        expectJsonSchemaFormat(request, "notes_summary_response", "summaryMarkdown");
        expect(request.instructions).toContain("Transform current visible notes only.");
        expect(request.instructions).toContain("Do not add a Quick Checklist unless explicitly requested in the notes.");
        expect(request.instructions).toContain("Compression should be adaptive");
        expect(request.instructions).toContain("Produce a condensed summary, not a cleaned-up rewrite and not a reorganised version.");
        expect(request.instructions).toContain("preserving the existing structure only where it helps reviewability");
        expect(request.instructions).toContain("Preserve existing structure where it improves reviewability.");
        expect(request.instructions).toContain("Do not behave like Reorganise");
        expect(request.instructions).toContain("produce a visibly shorter review version");
        expect(request.instructions).toContain("Long notes should usually be meaningfully shorter");
        expect(request.instructions).toContain("do not force an exact percentage");
        expect(request.instructions).toContain("aim roughly for 50-75% of the original length");
        expect(request.instructions).toContain("accuracy and reviewability are more important than hitting a fixed ratio");
        expect(request.instructions).toContain("merge related sections");
        expect(request.instructions).toContain("reduce low-value headings and subheadings");
        expect(request.instructions).toContain("reduce both wording and structure");
        expect(request.instructions).toContain("avoid preserving a one-to-one outline of the source");
        expect(request.instructions).toContain("clearly different from a reorganised version of the same notes");
        expect(request.instructions).toContain("Remove repeated examples, repeated explanation, repeated framing, transcript-like wording, and overly granular supporting detail.");
        expect(request.instructions).toContain("Merge small or overlapping bullets where meaning is preserved.");
        expect(request.instructions).toContain("Do not preserve every bullet; preserve the important meaning.");
        expect(request.instructions).toContain("Prefer shorter wording.");
        expect(request.instructions).toContain("preserving decisions, actions, owners, deadlines, risks, blockers, obligations, constraints, open questions, safety-critical facts, explicit user-provided constraints");
        expect(request.instructions).toContain("If a question is answered elsewhere in current_visible_notes");
        expect(request.instructions).toContain("For long notes, merge clearly related or lower-priority headings when doing so preserves the key meaning and makes the result easier to review.");
        expect(request.instructions).toContain("For dense process, RCA, incident-review, support, or training notes, group repeated procedural details under fewer headings.");
        expect(request.instructions).toContain("Keep the governing rule, exception, owner/action, constraint, risk, deadline, and open question");
        expect(request.instructions).toContain("When there are many procedural bullets saying similar things, preserve the rule once and merge the rest into a shorter summary.");
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
        expect(request.model).toBe("gpt-5.4");
        expect(request.reasoning).toEqual({ effort: "low" });
        expect(request.max_output_tokens).toBeGreaterThan(3289);
        expectJsonSchemaFormat(request, "notes_reorganise_response", "reorganisedMarkdown");
        expect(request.instructions).toContain("Transform current visible notes only.");
        expect(request.instructions).toContain("Preserve more useful detail and examples than Summarise would.");
        expect(request.instructions).toContain("- No relevant notes captured.");
        expect(request.instructions).toContain("{\"reorganisedMarkdown\":\"<reorganised notes markdown>\"}");
        expectNoPromptExcludedLanguage(request.instructions);
        expect(JSON.parse(request.input).target_sections).toEqual(["Concepts", "Actions"]);
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

    it("can force Reorganise back to medium reasoning with the rollback env", async () => {
        process.env.FORMIFY_REORGANISE_REASONING = "medium";
        const reorganised = `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`;
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ reorganisedMarkdown: reorganised }))
        );

        await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
            reorganisedMarkdown: reorganised,
        });
        expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "medium" });
    });

    it("falls back to low for invalid Reorganise reasoning config", async () => {
        process.env.FORMIFY_REORGANISE_REASONING = "fast";
        const configWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const reorganised = `${LONG_NOTES}\n\n## Actions\n\n- Follow up.`;
        openAiMock.responsesCreate.mockResolvedValueOnce(
            responsesJson(JSON.stringify({ reorganisedMarkdown: reorganised }))
        );

        try {
            await expect(generateNotesReorganisation({ notesMarkdown: LONG_NOTES })).resolves.toEqual({
                reorganisedMarkdown: reorganised,
            });
            expect(openAiMock.responsesCreate.mock.calls[0][0].reasoning).toEqual({ effort: "low" });
            expect(configWarn.mock.calls[0]?.[0]).toContain("Invalid FORMIFY_REORGANISE_REASONING");
            expect(configWarn.mock.calls[0]?.[0]).toContain("using low");
        } finally {
            configWarn.mockRestore();
        }
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
