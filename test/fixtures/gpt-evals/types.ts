export type EvalConceptChecks = {
    requiredConcepts: string[];
    forbiddenConcepts: string[];
    expectedOpenQuestions?: string[];
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

export type NotesTransformEvalFixture = EvalConceptChecks & {
    kind: "notes-transform";
    name: string;
    transform: "summarise" | "reorganise";
    noteStyle: string;
    currentVisibleNotes: string;
    compressibleConcepts?: string[];
    maxCompressionRatio?: number;
    expectedSectionHints?: string[];
    minPreservationRatio?: number;
};

export type NotesLiveEvalFixture = {
    kind: "notes-live";
    name: string;
    noteStyle: string;
    currentNotes: string;
    pendingTranscript: string;
    requiredPatchConcepts: string[];
    forbiddenPatchConcepts: string[];
    expectedSafetyBehaviour: string[];
    sampleGoodOutput?: string;
};

export type GptEvalFixture =
    | NotesFinalEvalFixture
    | FormsFinalEvalFixture
    | NotesTransformEvalFixture
    | NotesLiveEvalFixture;
