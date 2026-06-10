import type { EvalConcept } from "./fixtures/gpt-evals/types.js";

export function normaliseForConceptMatch(text: string): string {
    return text
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9$]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function containsAllConcepts(markdown: string, concepts: EvalConcept[]): string[] {
    const haystack = normaliseForConceptMatch(markdown);
    return concepts
        .filter((concept) => !conceptAlternatives(concept).some((alternative) =>
            haystack.includes(normaliseForConceptMatch(alternative))
        ))
        .map(formatConcept);
}

export function containsForbiddenConcepts(markdown: string, concepts: string[]): string[] {
    const haystack = normaliseForConceptMatch(markdown);
    return concepts.filter((concept) => haystack.includes(normaliseForConceptMatch(concept)));
}

export function compressionRatio(input: string, output: string): number {
    if (input.length === 0) return output.length === 0 ? 0 : Number.POSITIVE_INFINITY;
    return output.length / input.length;
}

export function countMarkdownHeadings(markdown: string): number {
    return (markdown.match(/^#{1,6}\s+\S.*$/gm) ?? []).length;
}

export function countMarkdownBullets(markdown: string): number {
    return (markdown.match(/^\s*[-*+]\s+\S.*$/gm) ?? []).length;
}

export function extractOpenQuestions(markdown: string): string[] {
    const lines = markdown.split(/\r?\n/);
    const startIndex = lines.findIndex((line) =>
        /^#{1,6}\s+open questions(?:\s*\/\s*verify)?\s*$/i.test(line.trim())
    );
    if (startIndex < 0) return [];

    const questions: string[] = [];
    for (let index = startIndex + 1; index < lines.length; index++) {
        const line = lines[index].trim();
        if (/^#{1,6}\s+\S/.test(line)) break;
        if (!line) continue;
        questions.push(line.replace(/^[-*+]\s+/, "").trim());
    }

    return questions;
}

function conceptAlternatives(concept: EvalConcept): string[] {
    return Array.isArray(concept) ? concept : [concept];
}

function formatConcept(concept: EvalConcept): string {
    return Array.isArray(concept) ? concept[0] : concept;
}
