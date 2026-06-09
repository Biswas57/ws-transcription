import { formsFinalFixtures } from "./forms-final.js";
import { notesFinalFixtures } from "./notes-final.js";
import { notesLiveFixtures } from "./notes-live.js";
import { notesTransformFixtures } from "./notes-transform.js";
import type { GptEvalFixture } from "./types.js";

export {
    formsFinalFixtures,
    notesFinalFixtures,
    notesLiveFixtures,
    notesTransformFixtures,
};

export type {
    EvalConceptChecks,
    EvalField,
    FormsFinalEvalFixture,
    GptEvalFixture,
    NotesFinalEvalFixture,
    NotesLiveEvalFixture,
    NotesTransformEvalFixture,
} from "./types.js";

export const allGptEvalFixtures: GptEvalFixture[] = [
    ...notesFinalFixtures,
    ...formsFinalFixtures,
    ...notesTransformFixtures,
    ...notesLiveFixtures,
];
