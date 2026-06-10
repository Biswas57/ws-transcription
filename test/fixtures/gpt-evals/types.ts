export type EvalConcept = string | string[];

export type EvalConceptChecks = {
    requiredConcepts: EvalConcept[];
    forbiddenConcepts: string[];
    expectedOpenQuestions?: EvalConcept[];
    sampleGoodOutput?: string;
};

export type EvalField = {
    key: string;
    label: string;
    description?: string;
};

export type NotesFinalEvalFixture = EvalConceptChecks & {
    kind: "notes-final";
    name: string;
    noteStyle: string;
    transcript: string;
    currentNotes: string;
    allowConciseFinalOutput?: boolean;
};

export type FormsFinalEvalFixture = {
    kind: "forms-final";
    name: string;
    transcript: string;
    fields: EvalField[];
    candidateAttributes?: Record<string, string>;
    expectedFinalAttributes: Record<string, string>;
    expectedEmptyFields: string[];
    expectedNotApplicableFields: string[];
    requiredConcepts?: string[];
    forbiddenConcepts?: string[];
};

export type FormsLiveEvalFixture = {
    kind: "forms-live";
    name: string;
    transcriptSegment: string;
    fields: EvalField[];
    currentAttributes?: Record<string, string>;
    expectedSparseAttributes: Record<string, string>;
    expectedSparseAttributeAlternatives?: Record<string, string[]>;
    expectedOmittedFields: string[];
    forbiddenAttributes: string[];
    requiredConcepts?: string[];
    forbiddenConcepts?: string[];
};

export type NotesTransformEvalFixture = EvalConceptChecks & {
    kind: "notes-transform";
    name: string;
    transform: "summarise" | "reorganise";
    noteStyle: string;
    currentVisibleNotes: string;
    compressibleConcepts?: string[];
    maxCompressionRatio?: number;
    expectedSectionHints?: EvalConcept[];
    minPreservationRatio?: number;
};

export type NotesLiveEvalFixture = {
    kind: "notes-live";
    name: string;
    noteStyle: string;
    currentNotes: string;
    pendingTranscript: string;
    requiredPatchConcepts: EvalConcept[];
    forbiddenPatchConcepts: string[];
    expectedSafetyBehaviour: string[];
    expectedFallbackUsed?: boolean;
    expectedTargetHeading?: string;
    sampleGoodOutput?: string;
};

export type LongSessionEvalStep = {
    elapsedMs: number;
    pendingTranscript: string;
    sampleAppendMarkdown: string;
};

export type LongSessionEvalFixture = {
    kind: "long-session";
    name: string;
    noteStyle: string;
    description: string;
    initialCurrentNotes: string;
    steps: LongSessionEvalStep[];
    expectedGrowthRisk: string[];
};

export type GptEvalFixture =
    | NotesFinalEvalFixture
    | FormsFinalEvalFixture
    | FormsLiveEvalFixture
    | NotesTransformEvalFixture
    | NotesLiveEvalFixture
    | LongSessionEvalFixture;
