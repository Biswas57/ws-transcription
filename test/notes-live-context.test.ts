import { describe, expect, it } from "vitest";
import {
    NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT,
    buildNotesLiveCurrentContext,
} from "../gpt/notes-live-context.js";

describe("notes live current context", () => {
    it("keeps empty notes safe and unchanged", () => {
        const context = buildNotesLiveCurrentContext("");

        expect(context).toEqual({
            contextMarkdown: "",
            compacted: false,
            originalChars: 0,
            contextChars: 0,
            savedChars: 0,
            headingCount: 0,
        });
    });

    it("keeps short notes unchanged", () => {
        const current = [
            "# Session",
            "",
            "## Decisions",
            "",
            "- Keep the support handover checklist.",
        ].join("\n");

        const context = buildNotesLiveCurrentContext(current);

        expect(context.contextMarkdown).toBe(current);
        expect(context.compacted).toBe(false);
        expect(context.originalChars).toBe(current.length);
        expect(context.contextChars).toBe(current.length);
        expect(context.savedChars).toBe(0);
        expect(context.headingCount).toBe(2);
    });

    it("compacts long notes into marker, outline, and recent tail without mutating canonical input", () => {
        const current = buildLongNotes();
        const before = current.slice();

        const context = buildNotesLiveCurrentContext(current);

        expect(current).toBe(before);
        expect(context.compacted).toBe(true);
        expect(context.originalChars).toBe(current.length);
        expect(context.contextChars).toBeLessThanOrEqual(NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT);
        expect(context.savedChars).toBe(current.length - context.contextChars);
        expect(context.contextMarkdown).toContain("Compact current notes context for live patching");
        expect(context.contextMarkdown).toContain("Full canonical notes are preserved by the app");
        expect(context.contextMarkdown).toContain("## Existing note outline");
        expect(context.contextMarkdown).toContain("- # Long Session Notes");
        expect(context.contextMarkdown).toContain("- ## Topic aaa");
        expect(context.contextMarkdown).toContain("## Recent note tail");
        expect(context.contextMarkdown).toContain("FINAL_TAIL_MARKER");
        expect(context.headingCount).toBeGreaterThan(10);
    });
});

function buildLongNotes(): string {
    const sections = Array.from({ length: 32 }, (_, index) => {
        const label = String.fromCharCode(97 + (index % 26));
        return [
            `## Topic ${label.repeat(3)}`,
            "",
            "- This synthetic section preserves enough detail to make the current notes grow past the live context threshold.",
            "- It includes generic process context, decisions, actions, risks, examples, and open verification items.",
            "- The content is intentionally repetitive and contains no real customer or private information.",
        ].join("\n");
    });

    return [
        "# Long Session Notes",
        "",
        ...sections,
        "",
        "## Latest useful context",
        "",
        "- FINAL_TAIL_MARKER should remain visible in the recent tail.",
    ].join("\n\n");
}
