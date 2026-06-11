import { describe, expect, it } from "vitest";
import { GPT_FLOW_CONFIG } from "../gpt/model-config.js";

describe("GPT runtime architecture", () => {
    it("keeps the production flow provider/model/reasoning matrix explicit", () => {
        expect(GPT_FLOW_CONFIG).toEqual({
            revision: {
                api: "responses",
                model: "gpt-5.4-mini",
                reasoning: "none",
            },
            formsLive: {
                api: "chat",
                model: "gpt-5.4-mini",
                reasoning: "low",
            },
            notesLive: {
                api: "responses",
                model: "gpt-5.4-mini",
                reasoning: "low",
            },
            formsFinal: {
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
            },
            notesFinal: {
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
            },
            summarise: {
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
            },
            reorganise: {
                api: "responses",
                model: "gpt-5.4",
                reasoning: "low",
            },
        });
    });

    it("keeps production flow config free of provider fallback switches", () => {
        const fallbackFlows = Object.entries(GPT_FLOW_CONFIG)
            .filter(([, config]) => "fallbackApi" in config)
            .map(([flow]) => flow);

        expect(fallbackFlows).toEqual([]);
    });
});
