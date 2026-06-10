import { parseMarkdownHeadingBlocks } from "../notes-live-patch.js";

export const NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT = 6000;
export const NOTES_LIVE_COMPACT_TAIL_CHAR_LIMIT = 3500;
export const NOTES_LIVE_MAX_HEADING_CONTEXT_CHARS = 1500;

const COMPACT_CONTEXT_MARKER =
    "[Compact current notes context for live patching. Full canonical notes are preserved by the app.]";

export type NotesLiveCurrentContext = {
    contextMarkdown: string;
    compacted: boolean;
    originalChars: number;
    contextChars: number;
    savedChars: number;
    headingCount: number;
};

export function buildNotesLiveCurrentContext(currentNotesMarkdown: string): NotesLiveCurrentContext {
    const originalChars = currentNotesMarkdown.length;
    if (originalChars === 0 || originalChars <= NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT) {
        return {
            contextMarkdown: currentNotesMarkdown,
            compacted: false,
            originalChars,
            contextChars: originalChars,
            savedChars: 0,
            headingCount: countHeadings(currentNotesMarkdown),
        };
    }

    const headingOutline = buildHeadingOutline(currentNotesMarkdown);
    const recentTail = buildRecentTail(currentNotesMarkdown, NOTES_LIVE_COMPACT_TAIL_CHAR_LIMIT);
    let contextMarkdown = [
        COMPACT_CONTEXT_MARKER,
        headingOutline ? `## Existing note outline\n\n${headingOutline}` : "",
        recentTail ? `## Recent note tail\n\n${recentTail}` : "",
    ].filter(Boolean).join("\n\n").trim();

    if (contextMarkdown.length > NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT) {
        const excess = contextMarkdown.length - NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT;
        const adjustedTailLimit = Math.max(500, NOTES_LIVE_COMPACT_TAIL_CHAR_LIMIT - excess);
        const adjustedTail = buildRecentTail(currentNotesMarkdown, adjustedTailLimit);
        contextMarkdown = [
            COMPACT_CONTEXT_MARKER,
            headingOutline ? `## Existing note outline\n\n${headingOutline}` : "",
            adjustedTail ? `## Recent note tail\n\n${adjustedTail}` : "",
        ].filter(Boolean).join("\n\n").trim();
    }

    if (contextMarkdown.length > NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT) {
        contextMarkdown = contextMarkdown
            .slice(0, NOTES_LIVE_FULL_CONTEXT_CHAR_LIMIT)
            .trimEnd();
    }

    return {
        contextMarkdown,
        compacted: true,
        originalChars,
        contextChars: contextMarkdown.length,
        savedChars: Math.max(0, originalChars - contextMarkdown.length),
        headingCount: countHeadings(currentNotesMarkdown),
    };
}

function buildHeadingOutline(markdown: string): string {
    const title = firstTitleHeading(markdown);
    const headings = parseMarkdownHeadingBlocks(markdown).map((block) =>
        `${"#".repeat(block.level)} ${block.headingText}`
    );
    const outlineLines = [
        title ? `- ${title}` : "",
        ...headings.map((heading) => `- ${heading}`),
    ].filter(Boolean);

    return truncateLines(outlineLines, NOTES_LIVE_MAX_HEADING_CONTEXT_CHARS).join("\n");
}

function firstTitleHeading(markdown: string): string {
    const line = markdown.split(/\r?\n/).find((candidate) => /^#\s+/.test(candidate));
    return line?.trim() ?? "";
}

function buildRecentTail(markdown: string, maxChars: number): string {
    if (markdown.length <= maxChars) return markdown.trim();
    const rawTail = markdown.slice(-maxChars);
    const firstLineBreak = rawTail.search(/\r?\n/);
    const lineAlignedTail = firstLineBreak >= 0
        ? rawTail.slice(firstLineBreak).replace(/^\r?\n/, "")
        : rawTail;
    return lineAlignedTail.trim();
}

function truncateLines(lines: string[], maxChars: number): string[] {
    const result: string[] = [];
    let chars = 0;

    for (const line of lines) {
        const nextChars = chars + line.length + (result.length > 0 ? 1 : 0);
        if (nextChars > maxChars) break;
        result.push(line);
        chars = nextChars;
    }

    return result;
}

function countHeadings(markdown: string): number {
    const titleCount = firstTitleHeading(markdown) ? 1 : 0;
    return titleCount + parseMarkdownHeadingBlocks(markdown).length;
}
