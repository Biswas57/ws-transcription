import type { NotesLiveEvalFixture } from "./types.js";

export const notesLiveFixtures: NotesLiveEvalFixture[] = [
    {
        kind: "notes-live",
        name: "early-patch-basic",
        noteStyle: "meeting",
        currentNotes: "",
        pendingTranscript: [
            "The main idea is to document the release checklist.",
            "We need owners for QA sign off and support handover.",
            "There is one open question about who confirms the rollout window.",
        ].join(" "),
        requiredPatchConcepts: [
            "release checklist",
            "QA sign off",
            "support handover",
            "rollout window",
        ],
        forbiddenPatchConcepts: [
            "completed launch",
            "customer approval received",
        ],
        expectedSafetyBehaviour: [
            "create useful provisional sections",
            "avoid document title spam",
            "preserve open question",
        ],
        sampleGoodOutput: [
            "## Main points",
            "",
            "- Document the release checklist.",
            "",
            "## Actions",
            "",
            "- Assign owners for QA sign off and support handover.",
            "",
            "## Open Questions / Verify",
            "",
            "- Confirm who owns the rollout window.",
        ].join("\n"),
    },
    {
        kind: "notes-live",
        name: "side-topic-repetition",
        noteStyle: "general",
        currentNotes: [
            "## Support triage",
            "",
            "- Confirm customer impact before escalation.",
            "- Record the product area and current workaround.",
        ].join("\n"),
        pendingTranscript: [
            "Again, confirm customer impact before escalation.",
            "The important new point is that the workaround expires after the weekend.",
            "There was a side comment about lunch, but it is not part of the support note.",
        ].join(" "),
        requiredPatchConcepts: [
            "workaround expires after the weekend",
        ],
        forbiddenPatchConcepts: [
            "lunch is part of the support note",
            "duplicate customer impact before escalation",
        ],
        expectedSafetyBehaviour: [
            "append only the new useful detail",
            "avoid duplicating existing triage points",
            "do not let side topics dominate",
        ],
    },
];
