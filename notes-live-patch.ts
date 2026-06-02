export type NotesSectionAppend = {
    targetHeading: string;
    targetLevel?: 2 | 3;
    appendMarkdown: string;
};

export type NotesLivePatch = {
    updates: NotesSectionAppend[];
    fallbackAppendMarkdown?: string;
    parseFailed?: boolean;
};

export type MarkdownHeadingBlock = {
    headingText: string;
    normalizedHeading: string;
    level: 2 | 3;
    headingLineIndex: number;
    endLineIndex: number;
};

const FALLBACK_HEADING = "Live updates";
const HEADING_RE = /^(#{2,3})\s+(.+)$/;

export function normalizeMarkdownHeading(text: string): string {
    return text
        .trim()
        .replace(/^#{2,3}\s+/, "")
        .replace(/:+\s*$/, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

export function parseMarkdownHeadingBlocks(markdown: string): MarkdownHeadingBlock[] {
    const lines = splitMarkdownLines(markdown);
    const blocks: MarkdownHeadingBlock[] = [];

    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(HEADING_RE);
        if (!match) continue;

        const level = match[1].length as 2 | 3;
        const headingText = match[2].trim();
        const nextHeadingIndex = findNextHeadingIndex(lines, index + 1, "any");

        blocks.push({
            headingText,
            normalizedHeading: normalizeMarkdownHeading(headingText),
            level,
            headingLineIndex: index,
            endLineIndex: nextHeadingIndex,
        });
    }

    return blocks;
}

export function applyNotesLivePatch(canonicalMarkdown: string, patch: NotesLivePatch): string {
    let markdown = canonicalMarkdown;

    for (const update of patch.updates ?? []) {
        const appendMarkdown = normalizeAppendMarkdown(update.appendMarkdown);
        if (!appendMarkdown || isUnsafeAppendMarkdown(appendMarkdown)) continue;
        if (!update.targetHeading?.trim()) continue;

        const match = findHeadingBlock(markdown, update.targetHeading, update.targetLevel);
        markdown = match
            ? appendUnderHeading(markdown, match, appendMarkdown)
            : appendUnderFallback(markdown, appendMarkdown);
    }

    const fallbackAppendMarkdown = normalizeAppendMarkdown(patch.fallbackAppendMarkdown ?? "");
    if (fallbackAppendMarkdown && !isUnsafeAppendMarkdown(fallbackAppendMarkdown)) {
        markdown = appendUnderFallback(markdown, fallbackAppendMarkdown);
    }

    return markdown;
}

function splitMarkdownLines(markdown: string): string[] {
    return markdown.length === 0 ? [] : markdown.split(/\r?\n/);
}

function findNextHeadingIndex(lines: string[], start: number, kind: "any" | "top-level"): number {
    for (let index = start; index < lines.length; index++) {
        if (kind === "top-level" && /^##\s+/.test(lines[index])) return index;
        if (kind === "any" && HEADING_RE.test(lines[index])) return index;
    }
    return lines.length;
}

function findHeadingBlock(
    markdown: string,
    heading: string,
    targetLevel?: 2 | 3
): MarkdownHeadingBlock | null {
    const cleanHeading = heading.replace(/^#{2,3}\s+/, "").trim().replace(/:+\s*$/, "");
    const normalizedHeading = normalizeMarkdownHeading(cleanHeading);
    const blocks = parseMarkdownHeadingBlocks(markdown);

    return blocks.find((block) => block.headingText === cleanHeading && block.level === targetLevel) ??
        blocks.find((block) => block.headingText === cleanHeading) ??
        blocks.find((block) => block.normalizedHeading === normalizedHeading && block.level === targetLevel) ??
        blocks.find((block) => block.normalizedHeading === normalizedHeading) ??
        null;
}

function appendUnderHeading(markdown: string, block: MarkdownHeadingBlock, appendMarkdown: string): string {
    const lines = splitMarkdownLines(markdown);
    const insertionIndex = block.level === 2
        ? findNextHeadingIndex(lines, block.headingLineIndex + 1, "top-level")
        : block.endLineIndex;

    insertAppendLines(lines, insertionIndex, appendMarkdown);
    return lines.join("\n");
}

function appendUnderFallback(markdown: string, appendMarkdown: string): string {
    const fallbackBlock = findHeadingBlock(markdown, FALLBACK_HEADING, 2);
    if (fallbackBlock) return appendUnderHeading(markdown, fallbackBlock, appendMarkdown);

    const base = markdown.trimEnd();
    if (base.length === 0) return `## ${FALLBACK_HEADING}\n\n${appendMarkdown}`;
    return `${base}\n\n## ${FALLBACK_HEADING}\n\n${appendMarkdown}`;
}

function insertAppendLines(lines: string[], insertionIndex: number, appendMarkdown: string): void {
    const appendLines = appendMarkdown.split(/\r?\n/);
    const insertLines: string[] = [];

    if (insertionIndex > 0 && lines[insertionIndex - 1]?.trim() !== "") {
        insertLines.push("");
    }

    insertLines.push(...appendLines);

    if (insertionIndex < lines.length && lines[insertionIndex]?.trim() !== "") {
        insertLines.push("");
    }

    lines.splice(insertionIndex, 0, ...insertLines);
}

function normalizeAppendMarkdown(markdown: string): string {
    return markdown.trim();
}

function isUnsafeAppendMarkdown(markdown: string): boolean {
    const lines = markdown.split(/\r?\n/);
    const topLevelHeadingCount = lines.filter((line) => /^##\s+/.test(line)).length;
    const anyHeadingCount = lines.filter((line) => HEADING_RE.test(line)).length;

    if (markdown.length > 6000) return true;
    if (topLevelHeadingCount > 0) return true;
    if (markdown.length > 2500 && anyHeadingCount >= 3) return true;

    return false;
}
