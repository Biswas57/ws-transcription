import type { LongSessionEvalFixture } from "./fixtures/gpt-evals/index.js";
import { buildNotesLiveCurrentContext } from "../gpt/notes-live-context.js";

export type LongSessionEstimateStep = {
    stepIndex: number;
    elapsedMs: number;
    pendingTranscriptChars: number;
    currentNotesCharsBefore: number;
    currentNotesCharsAfter: number;
    unboundedInputChars: number;
    boundedInputChars: number;
    savedInputChars: number;
    unboundedEstimatedInputTokens: number;
    boundedEstimatedInputTokens: number;
    savedEstimatedInputTokens: number;
    contextCompacted: boolean;
    currentNotesContextChars: number;
    contextSavedChars: number;
    headingCount: number;
    outputChars: number;
};

export type LongSessionEstimate = {
    fixtureName: string;
    stepCount: number;
    livePatchCalls: number;
    currentNotesStartChars: number;
    currentNotesEndChars: number;
    maxCurrentNotesChars: number;
    cumulativeUnboundedInputChars: number;
    cumulativeBoundedInputChars: number;
    cumulativeSavedInputChars: number;
    cumulativeUnboundedEstimatedInputTokens: number;
    cumulativeBoundedEstimatedInputTokens: number;
    cumulativeSavedEstimatedInputTokens: number;
    cumulativeOutputChars: number;
    firstCompactedStep: number | null;
    charsPerTokenEstimate: number;
    steps: LongSessionEstimateStep[];
};

export function estimateLongSessionLivePatchGrowth(
    fixture: LongSessionEvalFixture,
    options: { charsPerToken?: number } = {}
): LongSessionEstimate {
    const charsPerTokenEstimate = options.charsPerToken ?? 4;
    let currentNotes = fixture.initialCurrentNotes;
    let cumulativeUnboundedInputChars = 0;
    let cumulativeBoundedInputChars = 0;
    let cumulativeSavedInputChars = 0;
    let cumulativeUnboundedEstimatedInputTokens = 0;
    let cumulativeBoundedEstimatedInputTokens = 0;
    let cumulativeSavedEstimatedInputTokens = 0;
    let cumulativeOutputChars = 0;
    let maxCurrentNotesChars = currentNotes.length;
    let firstCompactedStep: number | null = null;

    const steps = fixture.steps.map((step, index): LongSessionEstimateStep => {
        const currentContext = buildNotesLiveCurrentContext(currentNotes);
        const unboundedInputChars = livePatchInputChars({
            noteStyle: fixture.noteStyle,
            currentNotes,
            transcriptSegment: step.pendingTranscript,
        });
        const boundedInputChars = livePatchInputChars({
            noteStyle: fixture.noteStyle,
            currentNotes: currentContext.contextMarkdown,
            transcriptSegment: step.pendingTranscript,
        });
        const savedInputChars = Math.max(0, unboundedInputChars - boundedInputChars);
        const unboundedEstimatedInputTokens = Math.ceil(unboundedInputChars / charsPerTokenEstimate);
        const boundedEstimatedInputTokens = Math.ceil(boundedInputChars / charsPerTokenEstimate);
        const savedEstimatedInputTokens = Math.max(
            0,
            unboundedEstimatedInputTokens - boundedEstimatedInputTokens
        );
        const outputChars = step.sampleAppendMarkdown.length;
        const currentNotesCharsBefore = currentNotes.length;

        currentNotes = appendSyntheticLiveMarkdown(currentNotes, step.sampleAppendMarkdown);
        maxCurrentNotesChars = Math.max(maxCurrentNotesChars, currentNotes.length);
        cumulativeUnboundedInputChars += unboundedInputChars;
        cumulativeBoundedInputChars += boundedInputChars;
        cumulativeSavedInputChars += savedInputChars;
        cumulativeUnboundedEstimatedInputTokens += unboundedEstimatedInputTokens;
        cumulativeBoundedEstimatedInputTokens += boundedEstimatedInputTokens;
        cumulativeSavedEstimatedInputTokens += savedEstimatedInputTokens;
        cumulativeOutputChars += outputChars;
        if (currentContext.compacted && firstCompactedStep === null) {
            firstCompactedStep = index + 1;
        }

        return {
            stepIndex: index + 1,
            elapsedMs: step.elapsedMs,
            pendingTranscriptChars: step.pendingTranscript.length,
            currentNotesCharsBefore,
            currentNotesCharsAfter: currentNotes.length,
            unboundedInputChars,
            boundedInputChars,
            savedInputChars,
            unboundedEstimatedInputTokens,
            boundedEstimatedInputTokens,
            savedEstimatedInputTokens,
            contextCompacted: currentContext.compacted,
            currentNotesContextChars: currentContext.contextChars,
            contextSavedChars: currentContext.savedChars,
            headingCount: currentContext.headingCount,
            outputChars,
        };
    });

    return {
        fixtureName: fixture.name,
        stepCount: fixture.steps.length,
        livePatchCalls: fixture.steps.length,
        currentNotesStartChars: fixture.initialCurrentNotes.length,
        currentNotesEndChars: currentNotes.length,
        maxCurrentNotesChars,
        cumulativeUnboundedInputChars,
        cumulativeBoundedInputChars,
        cumulativeSavedInputChars,
        cumulativeUnboundedEstimatedInputTokens,
        cumulativeBoundedEstimatedInputTokens,
        cumulativeSavedEstimatedInputTokens,
        cumulativeOutputChars,
        firstCompactedStep,
        charsPerTokenEstimate,
        steps,
    };
}

function livePatchInputChars(args: {
    noteStyle: string;
    currentNotes: string;
    transcriptSegment: string;
}): number {
    return JSON.stringify({
        note_style: args.noteStyle,
        current_notes: args.currentNotes,
        transcript_segment: args.transcriptSegment,
    }).length;
}

function appendSyntheticLiveMarkdown(currentNotes: string, appendMarkdown: string): string {
    const base = currentNotes.trimEnd();
    const append = appendMarkdown.trim();
    if (!base) return append;
    if (!append) return base;
    return `${base}\n\n${append}`;
}
