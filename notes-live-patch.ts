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
const MAX_FALLBACK_TOP_LEVEL_HEADINGS = 3;
const MAX_FALLBACK_TOTAL_HEADINGS = 6;

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
    if (
        fallbackAppendMarkdown &&
        !isUnsafeFallbackAppendMarkdown(fallbackAppendMarkdown) &&
        !repeatsExistingNotes(markdown, fallbackAppendMarkdown)
    ) {
        markdown = appendFallbackMarkdown(markdown, fallbackAppendMarkdown);
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

function appendFallbackMarkdown(markdown: string, appendMarkdown: string): string {
    if (!hasTopLevelHeading(appendMarkdown)) return appendUnderFallback(markdown, appendMarkdown);

    const base = markdown.trimEnd();
    if (base.length === 0) return appendMarkdown;
    return `${base}\n\n${appendMarkdown}`;
}

function insertAppendLines(lines: string[], insertionIndex: number, appendMarkdown: string): void {
    const appendLines = appendMarkdown.split(/\r?\n/);
    const insertLines: string[] = [];
    const previousLine = findPreviousNonBlankLine(lines, insertionIndex);
    const nextLine = findNextNonBlankLine(lines, insertionIndex);
    const firstAppendLine = appendLines.find((line) => line.trim() !== "") ?? "";
    const lastAppendLine = [...appendLines].reverse().find((line) => line.trim() !== "") ?? "";
    const compactBefore = previousLine && areBothBulletLines(previousLine, firstAppendLine);
    const compactAfter = nextLine && areBothBulletLines(lastAppendLine, nextLine);
    const startIndex = findInsertionStart(lines, insertionIndex);
    const endIndex = findInsertionEnd(lines, insertionIndex);

    if (
        previousLine &&
        !compactBefore
    ) {
        insertLines.push("");
    }

    insertLines.push(...appendLines);

    if (
        nextLine &&
        !compactAfter
    ) {
        insertLines.push("");
    }

    lines.splice(startIndex, endIndex - startIndex, ...insertLines);
}

function normalizeAppendMarkdown(markdown: string): string {
    return markdown.trim().replace(/(?:\r?\n\s*){3,}/g, "\n\n");
}

function findPreviousNonBlankLine(lines: string[], insertionIndex: number): string {
    for (let index = insertionIndex - 1; index >= 0; index--) {
        if (lines[index].trim() !== "") return lines[index];
    }
    return "";
}

function findNextNonBlankLine(lines: string[], insertionIndex: number): string {
    for (let index = insertionIndex; index < lines.length; index++) {
        if (lines[index].trim() !== "") return lines[index];
    }
    return "";
}

function findInsertionStart(lines: string[], insertionIndex: number): number {
    let index = insertionIndex;
    while (index > 0 && lines[index - 1]?.trim() === "") {
        index--;
    }
    return index;
}

function findInsertionEnd(lines: string[], insertionIndex: number): number {
    let index = insertionIndex;
    while (index < lines.length && lines[index]?.trim() === "") {
        index++;
    }
    return index;
}

function areBothBulletLines(left: string, right: string): boolean {
    return isBulletLine(left) && isBulletLine(right);
}

function isBulletLine(line: string): boolean {
    return /^\s*[-*+]\s+/.test(line);
}

function isUnsafeAppendMarkdown(markdown: string): boolean {
    const lines = markdown.split(/\r?\n/);
    const topLevelHeadingCount = lines.filter((line) => /^##\s+/.test(line)).length;
    const anyHeadingCount = lines.filter((line) => HEADING_RE.test(line)).length;

    if (markdown.length > 6000) return true;
    if (hasDocumentTitle(markdown)) return true;
    if (topLevelHeadingCount > 0) return true;
    if (markdown.length > 2500 && anyHeadingCount >= 3) return true;

    return false;
}

function isUnsafeFallbackAppendMarkdown(markdown: string): boolean {
    const lines = markdown.split(/\r?\n/);
    const topLevelHeadingCount = lines.filter((line) => /^##\s+/.test(line)).length;
    const anyHeadingCount = lines.filter((line) => HEADING_RE.test(line)).length;

    if (markdown.length > 6000) return true;
    if (hasDocumentTitle(markdown)) return true;
    if (topLevelHeadingCount > MAX_FALLBACK_TOP_LEVEL_HEADINGS) return true;
    if (anyHeadingCount > MAX_FALLBACK_TOTAL_HEADINGS) return true;
    if (markdown.length > 2500 && anyHeadingCount >= 3) return true;

    return false;
}

function hasDocumentTitle(markdown: string): boolean {
    return markdown.split(/\r?\n/).some((line) => /^#\s+/.test(line));
}

function hasTopLevelHeading(markdown: string): boolean {
    return markdown.split(/\r?\n/).some((line) => /^##\s+/.test(line));
}

function repeatsExistingNotes(canonicalMarkdown: string, appendMarkdown: string): boolean {
    const existingLines = normalizedMeaningfulLines(canonicalMarkdown);
    if (existingLines.length < 4) return false;

    const appendLines = new Set(normalizedMeaningfulLines(appendMarkdown));
    const repeatedLines = existingLines.filter((line) => appendLines.has(line)).length;
    return repeatedLines >= Math.ceil(existingLines.length * 0.7);
}

function normalizedMeaningfulLines(markdown: string): string[] {
    return markdown
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\s+/g, " ").toLowerCase())
        .filter((line) => line.length >= 8);
}
