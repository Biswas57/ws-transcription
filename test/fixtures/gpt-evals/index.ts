import { formsFinalFixtures } from "./forms-final.js";
import { formsLiveFixtures } from "./forms-live.js";
import { notesFinalFixtures } from "./notes-final.js";
import { notesLiveFixtures } from "./notes-live.js";
import { notesTransformFixtures } from "./notes-transform.js";
import { longSessionFixtures } from "./long-session.js";
import type { GptEvalFixture } from "./types.js";

export {
    formsFinalFixtures,
    formsLiveFixtures,
    longSessionFixtures,
    notesFinalFixtures,
    notesLiveFixtures,
    notesTransformFixtures,
};

export type {
    EvalConcept,
    EvalConceptChecks,
    EvalField,
    FormsFinalEvalFixture,
    FormsLiveEvalFixture,
    GptEvalFixture,
    LongSessionEvalFixture,
    LongSessionEvalStep,
    NotesFinalEvalFixture,
    NotesLiveEvalFixture,
    NotesTransformEvalFixture,
} from "./types.js";

export const allGptEvalFixtures: GptEvalFixture[] = [
    ...notesFinalFixtures,
    ...formsFinalFixtures,
    ...formsLiveFixtures,
    ...notesTransformFixtures,
    ...notesLiveFixtures,
    ...longSessionFixtures,
];
