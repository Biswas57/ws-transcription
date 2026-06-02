import { describe, expect, it } from "vitest";
import {
    applyNotesLivePatch,
    normalizeMarkdownHeading,
    parseMarkdownHeadingBlocks,
} from "../notes-live-patch.js";

describe("notes live patch application", () => {
    it("normalizes headings for matching", () => {
        expect(normalizeMarkdownHeading("  ## Decisions:  ")).toBe("decisions");
        expect(normalizeMarkdownHeading("Next   Steps")).toBe("next steps");
    });

    it("parses only level 2 and 3 markdown headings", () => {
        const blocks = parseMarkdownHeadingBlocks([
            "# Title",
            "## Decisions",
            "### Owners",
            "#### Ignored",
            "## Next Steps",
        ].join("\n"));

        expect(blocks.map((block) => [block.level, block.headingText])).toEqual([
            [2, "Decisions"],
            [3, "Owners"],
            [2, "Next Steps"],
        ]);
    });

    it("appends under matched headings without replacing existing content", () => {
        const current = [
            "Opening preamble.",
            "",
            "## Decisions",
            "",
            "- Keep current launch plan.",
            "",
            "### Owners",
            "",
            "- Sam owns rollout.",
            "",
            "## Next Steps",
            "",
            "- Book review.",
        ].join("\n");

        const updated = applyNotesLivePatch(current, {
            updates: [
                {
                    targetHeading: "owners",
                    targetLevel: 3,
                    appendMarkdown: "- Priya owns comms.",
                },
                {
                    targetHeading: "Decisions",
                    targetLevel: 2,
                    appendMarkdown: "- Confirmed beta remains free.",
                },
            ],
        });

        expect(updated).toContain("Opening preamble.");
        expect(updated).toContain("- Keep current launch plan.");
        expect(updated).toContain("- Sam owns rollout.");
        expect(updated).toContain("- Priya owns comms.");
        expect(updated).toContain("- Confirmed beta remains free.");
        expect(updated.indexOf("- Priya owns comms.")).toBeLessThan(updated.indexOf("## Next Steps"));
        expect(updated.indexOf("- Confirmed beta remains free.")).toBeLessThan(updated.indexOf("## Next Steps"));
    });

    it("reuses one fallback section for unknown headings", () => {
        const first = applyNotesLivePatch("## Existing\n\n- Already here.", {
            updates: [{
                targetHeading: "Unknown heading",
                appendMarkdown: "- New uncategorised point.",
            }],
        });
        const second = applyNotesLivePatch(first, {
            fallbackAppendMarkdown: "- Another uncategorised point.",
            updates: [],
        });

        expect((second.match(/^## Live updates$/gm) ?? [])).toHaveLength(1);
        expect(second).toContain("- New uncategorised point.");
        expect(second).toContain("- Another uncategorised point.");
    });

    it("keeps repeated bullet appends compact", () => {
        const updated = applyNotesLivePatch("## Live updates\n\n- First update.", {
            updates: [{
                targetHeading: "Live updates",
                appendMarkdown: "\n\n- Second update.\n\n\n\n- Third update.\n\n",
            }],
        });

        expect(updated).toBe([
            "## Live updates",
            "",
            "- First update.",
            "- Second update.",
            "",
            "- Third update.",
        ].join("\n"));
    });

    it("normalizes excessive blank lines before following headings", () => {
        const current = [
            "## Live updates",
            "",
            "- First update.",
            "",
            "",
            "## Next section",
            "",
            "- Existing next item.",
        ].join("\n");

        const updated = applyNotesLivePatch(current, {
            updates: [{
                targetHeading: "Live updates",
                appendMarkdown: "\n\n- Second update.\n\n",
            }],
        });

        expect(updated).toBe([
            "## Live updates",
            "",
            "- First update.",
            "- Second update.",
            "",
            "## Next section",
            "",
            "- Existing next item.",
        ].join("\n"));
    });

    it("ignores unsafe append fragments that try to introduce top-level headings", () => {
        const current = "## Existing\n\n- Already here.";
        const updated = applyNotesLivePatch(current, {
            updates: [{
                targetHeading: "Existing",
                appendMarkdown: "## Replacement\n\n- Should not land.",
            }],
        });

        expect(updated).toBe(current);
    });
});
