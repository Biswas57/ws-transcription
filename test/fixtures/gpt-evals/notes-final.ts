import type { NotesFinalEvalFixture } from "./types.js";

export const notesFinalFixtures: NotesFinalEvalFixture[] = [
    {
        kind: "notes-final",
        name: "rca-process-final",
        noteStyle: "training",
        transcript: [
            "The process starts by confirming whether a formal RCA is actually needed.",
            "Capture the software version and verify the support contract before promising anything.",
            "If the product is end of life, a formal RCA generally is not produced, but support can explain the likely cause.",
            "Support scope is limited to Nutanix products. Third party hardware issues go to the OEM vendor.",
            "Legal reviews the final RCA document before it goes to a customer.",
            "Open questions are the Lenovo escalation flow and whether Fujitsu uses the same support model.",
        ].join(" "),
        currentNotes: [
            "## RCA triage",
            "",
            "- Check if formal RCA is needed.",
            "- Version and support contract matter.",
            "",
            "## Open Questions / Verify",
            "",
            "- Lenovo support/escalation flow.",
        ].join("\n"),
        requiredConcepts: [
            "confirm whether formal RCA is needed",
            "capture the software version",
            "verify the support contract",
            "end of life software generally is not produced",
            "Legal reviews the final RCA document",
            "support scope is limited to Nutanix products",
            "third party hardware issues go to the OEM vendor",
        ],
        forbiddenConcepts: [
            "guaranteed RCA document within 2-3 days",
            "Nutanix performs full third-party hardware RCA",
            "data recovery from backup is in RCA scope",
        ],
        expectedOpenQuestions: [
            "Lenovo escalation flow",
            "Fujitsu support model",
        ],
    },
    {
        kind: "notes-final",
        name: "short-study-final",
        noteStyle: "study",
        transcript: [
            "Photosynthesis uses chlorophyll to capture light energy.",
            "The plant stores energy as glucose and releases oxygen.",
            "I need to verify the role of stomata in gas exchange later.",
        ].join(" "),
        currentNotes: "## Photosynthesis\n\n- Chlorophyll captures light.\n- Need to check stomata.",
        requiredConcepts: [
            "chlorophyll captures light",
            "glucose stores energy",
            "oxygen is released",
        ],
        forbiddenConcepts: [
            "mitochondria capture sunlight",
            "plants release carbon monoxide",
        ],
        expectedOpenQuestions: [
            "role of stomata",
        ],
    },
];
