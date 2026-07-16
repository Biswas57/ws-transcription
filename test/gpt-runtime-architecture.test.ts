import { describe, expect, it } from "vitest";
import {
    GPT_FLOW_CONFIG,
    GPT_FLOW_PROFILES,
    GPT_MODEL_PROFILE,
    resolveGPTModelProfile,
} from "../gpt/model-config.js";
import {
    NOTES_INCREMENTAL_SYS_TXT,
    NOTES_LIVE_PATCH_RESPONSE_SCHEMA,
} from "../gpt/notes-live.js";
import { WHISPER_API_URL, WHISPER_MODEL } from "../transcription.js";

describe("GPT runtime architecture", () => {
    it("maps every workflow in the GPT-5.6 candidate profile", () => {
        expect(GPT_FLOW_PROFILES["gpt-5.6"]).toEqual({
            revision: {
                api: "responses",
                model: "gpt-5.6-luna",
                reasoning: "none",
            },
            formsLive: {
                api: "chat",
                model: "gpt-5.6-luna",
                reasoning: "low",
            },
            notesLive: {
                api: "responses",
                model: "gpt-5.6-luna",
                reasoning: "low",
            },
            formsFinal: {
                api: "responses",
                model: "gpt-5.6-terra",
                reasoning: "medium",
            },
            notesFinal: {
                api: "responses",
                model: "gpt-5.6-terra",
                reasoning: "medium",
            },
            summarise: {
                api: "responses",
                model: "gpt-5.6-terra",
                reasoning: "medium",
            },
            reorganise: {
                api: "responses",
                model: "gpt-5.6-luna",
                reasoning: "low",
            },
        });
    });

    it("keeps the previous GPT-5.4 matrix as a complete rollback profile", () => {
        expect(GPT_FLOW_PROFILES["gpt-5.4"]).toEqual({
            revision: { api: "responses", model: "gpt-5.4-mini", reasoning: "none" },
            formsLive: { api: "chat", model: "gpt-5.4-mini", reasoning: "low" },
            notesLive: { api: "responses", model: "gpt-5.4-mini", reasoning: "low" },
            formsFinal: { api: "responses", model: "gpt-5.4", reasoning: "medium" },
            notesFinal: { api: "responses", model: "gpt-5.4", reasoning: "medium" },
            summarise: { api: "responses", model: "gpt-5.4", reasoning: "medium" },
            reorganise: { api: "responses", model: "gpt-5.4", reasoning: "low" },
        });
    });

    it("selects GPT-5.6 by default and supports one explicit rollback value", () => {
        expect(resolveGPTModelProfile("")).toBe("gpt-5.6");
        expect(resolveGPTModelProfile("gpt-5.4")).toBe("gpt-5.4");
        expect(() => resolveGPTModelProfile("gpt-5.6-sol")).toThrow(
            "GPT_MODEL_PROFILE must be either gpt-5.6 or gpt-5.4"
        );
        expect(GPT_FLOW_CONFIG).toBe(GPT_FLOW_PROFILES[GPT_MODEL_PROFILE]);
    });

    it("keeps API choices explicit and free of fallback switches", () => {
        for (const profile of Object.values(GPT_FLOW_PROFILES)) {
            expect(profile.revision.api).toBe("responses");
            expect(profile.formsLive.api).toBe("chat");
            expect(profile.notesLive.api).toBe("responses");
            expect(profile.formsFinal.api).toBe("responses");
            expect(profile.notesFinal.api).toBe("responses");
            expect(profile.summarise.api).toBe("responses");
            expect(profile.reorganise.api).toBe("responses");

            const fallbackFlows = Object.entries(profile)
                .filter(([, config]) => "fallbackApi" in config)
                .map(([flow]) => flow);

            expect(fallbackFlows).toEqual([]);
        }
    });

    it("does not use the moving unsuffixed GPT-5.6 alias", () => {
        const models = Object.values(GPT_FLOW_PROFILES)
            .flatMap((profile) => Object.values(profile).map((flow) => flow.model));

        expect(models).not.toContain("gpt-5.6");
    });

    it("keeps the Notes-live empty result aligned with its strict schema", () => {
        expect(NOTES_LIVE_PATCH_RESPONSE_SCHEMA.schema.required).toEqual([
            "updates",
            "fallbackAppendMarkdown",
        ]);
        expect(NOTES_INCREMENTAL_SYS_TXT).toContain(
            '{"updates":[],"fallbackAppendMarkdown":""}'
        );
        expect(NOTES_INCREMENTAL_SYS_TXT).not.toContain(
            'return exactly:\n{"updates":[]}\n'
        );
    });

    it("keeps audio transcription on the existing Whisper endpoint and model", () => {
        expect(WHISPER_API_URL).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(WHISPER_MODEL).toBe("whisper-1");
    });
});
