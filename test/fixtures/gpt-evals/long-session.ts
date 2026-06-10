import type { LongSessionEvalFixture } from "./types.js";

const PRIOR_CONTEXT_LABELS = [
    "opening",
    "routing",
    "handover",
    "review",
    "coverage",
    "approval",
    "training",
    "reporting",
    "quality",
    "escalation",
    "readiness",
    "support",
    "workflow",
    "follow up",
    "risk",
    "verification",
    "operations",
    "recap",
];

function syntheticPriorContext(topic: string): string {
    return PRIOR_CONTEXT_LABELS.map((label) => [
        `## Prior ${topic} ${label}`,
        "",
        `- Synthetic prior note about ${topic} ${label} context, capturing a process detail that may help heading choice later.`,
        `- The note keeps generic owner, timing, dependency, risk, action, and verification language for cost estimation only.`,
        `- This fixture content is intentionally repetitive so long-session current notes exceed the live compaction threshold.`,
    ].join("\n")).join("\n\n");
}

export const longSessionFixtures: LongSessionEvalFixture[] = [
    {
        kind: "long-session",
        name: "long-session-steady-meeting",
        noteStyle: "meeting",
        description: "Synthetic steady operations meeting where notes grow at a regular pace.",
        initialCurrentNotes: [
            "## Meeting purpose",
            "",
            "- Review the rollout checklist for the support handover.",
            "",
            syntheticPriorContext("steady meeting"),
        ].join("\n"),
        steps: [
            {
                elapsedMs: 15_000,
                pendingTranscript: "The team confirmed that intake triage should stay with support until the handover checklist is complete.",
                sampleAppendMarkdown: "- Intake triage stays with support until the handover checklist is complete.",
            },
            {
                elapsedMs: 35_000,
                pendingTranscript: "Mina will prepare the draft handover notes and Jay will review gaps before the next checkpoint.",
                sampleAppendMarkdown: "- Mina drafts handover notes; Jay reviews remaining gaps before the next checkpoint.",
            },
            {
                elapsedMs: 75_000,
                pendingTranscript: "The release note should separate user-facing changes from internal workflow cleanup so support can answer questions quickly.",
                sampleAppendMarkdown: "- Release notes should separate user-facing changes from internal workflow cleanup.",
            },
            {
                elapsedMs: 150_000,
                pendingTranscript: "A risk was raised that weekend coverage has fewer reviewers, so any unresolved checklist item should wait for weekday review.",
                sampleAppendMarkdown: "- Weekend coverage has fewer reviewers; unresolved checklist items should wait for weekday review.",
            },
            {
                elapsedMs: 270_000,
                pendingTranscript: "The action register needs one owner per item and no shared ownership unless the dependency is explicitly written down.",
                sampleAppendMarkdown: "- Action register items need one owner unless a written dependency explains shared ownership.",
            },
            {
                elapsedMs: 390_000,
                pendingTranscript: "Open question is whether the enablement guide should include a short escalation example or link only to the support playbook.",
                sampleAppendMarkdown: "- Verify whether the enablement guide needs a short escalation example or only a playbook reference.",
            },
        ],
        expectedGrowthRisk: [
            "current notes grow steadily",
            "live patch input grows with full canonical notes",
            "action and owner details accumulate",
        ],
    },
    {
        kind: "long-session",
        name: "long-session-topic-shifts",
        noteStyle: "general",
        description: "Synthetic session with several clean topic shifts that should create or reuse sections.",
        initialCurrentNotes: [
            "## Opening context",
            "",
            "- The session starts with a general process review.",
            "",
            syntheticPriorContext("topic shift"),
        ].join("\n"),
        steps: [
            {
                elapsedMs: 20_000,
                pendingTranscript: "First topic is onboarding: new operators should complete shadow review before taking independent queue work.",
                sampleAppendMarkdown: "## Onboarding\n\n- New operators complete shadow review before independent queue work.",
            },
            {
                elapsedMs: 50_000,
                pendingTranscript: "Next topic is quality review. A reviewer should sample completed items and note whether the reason code matches the outcome.",
                sampleAppendMarkdown: "## Quality review\n\n- Reviewers sample completed items and check reason-code alignment.",
            },
            {
                elapsedMs: 95_000,
                pendingTranscript: "The group moved to reporting. Weekly reporting should show backlog age, blocked items, and items waiting on approval.",
                sampleAppendMarkdown: "## Reporting\n\n- Weekly reports show backlog age, blocked items, and approval waits.",
            },
            {
                elapsedMs: 180_000,
                pendingTranscript: "For escalations, the speaker said urgent customer-impacting blockers should be marked before the daily cutoff.",
                sampleAppendMarkdown: "## Escalations\n\n- Urgent customer-impacting blockers should be marked before the daily cutoff.",
            },
            {
                elapsedMs: 300_000,
                pendingTranscript: "The training recap returned to onboarding and clarified that shadow review can be waived only with manager approval.",
                sampleAppendMarkdown: "- Shadow review can be waived only with manager approval.",
            },
            {
                elapsedMs: 420_000,
                pendingTranscript: "Open question: should reporting include a separate risk column or keep risk notes inside the blocker field?",
                sampleAppendMarkdown: "- Verify whether reporting needs a separate risk column or risk notes inside the blocker field.",
            },
        ],
        expectedGrowthRisk: [
            "topic shifts increase heading count",
            "full current notes context grows across sections",
            "late returns to older topics require heading reuse",
        ],
    },
    {
        kind: "long-session",
        name: "long-session-repetition-heavy",
        noteStyle: "study",
        description: "Synthetic repeated explanation where duplicate suppression should reduce wasted output.",
        initialCurrentNotes: [
            "## Core concept",
            "",
            "- The review loop checks evidence, outcome, and next action.",
            "",
            syntheticPriorContext("study review"),
        ].join("\n"),
        steps: [
            {
                elapsedMs: 12_000,
                pendingTranscript: "The review loop checks the evidence, the outcome, and then what action is needed next.",
                sampleAppendMarkdown: "- Review loop: evidence, outcome, next action.",
            },
            {
                elapsedMs: 36_000,
                pendingTranscript: "Again, the same review loop is evidence first, outcome second, action third, because that order avoids guesswork.",
                sampleAppendMarkdown: "- The order avoids guesswork by checking evidence before action.",
            },
            {
                elapsedMs: 80_000,
                pendingTranscript: "The speaker repeated that evidence comes first and gave the example of checking the source note before choosing a reason.",
                sampleAppendMarkdown: "- Example: check the source note before choosing a reason.",
            },
            {
                elapsedMs: 150_000,
                pendingTranscript: "They repeated the same source note example and added that missing evidence should become an open verification item.",
                sampleAppendMarkdown: "- Missing evidence should become an open verification item.",
            },
            {
                elapsedMs: 260_000,
                pendingTranscript: "The same idea came up again, but the new detail is that review notes should avoid blame language.",
                sampleAppendMarkdown: "- Review notes should avoid blame language.",
            },
            {
                elapsedMs: 390_000,
                pendingTranscript: "The recap said to keep the evidence outcome action order and not add duplicate bullets if nothing new was said.",
                sampleAppendMarkdown: "- Avoid duplicate bullets when the speaker repeats the evidence, outcome, action order.",
            },
        ],
        expectedGrowthRisk: [
            "repeated speech can waste live patch input",
            "duplicate suppression affects output growth",
            "current notes still grow even when pending transcript repeats",
        ],
    },
    {
        kind: "long-session",
        name: "long-session-correction-late",
        noteStyle: "meeting",
        description: "Synthetic late correction where finalisation must preserve the corrected state.",
        initialCurrentNotes: [
            "## Rollout timing",
            "",
            "- Draft notes say the pilot starts on Friday.",
            "",
            syntheticPriorContext("correction"),
        ].join("\n"),
        steps: [
            {
                elapsedMs: 18_000,
                pendingTranscript: "The pilot timeline was first described as Friday pending approval from the review lead.",
                sampleAppendMarkdown: "- Pilot was first described as Friday pending review-lead approval.",
            },
            {
                elapsedMs: 55_000,
                pendingTranscript: "The approval condition is that training notes are complete and support has the latest checklist.",
                sampleAppendMarkdown: "- Approval requires complete training notes and the latest support checklist.",
            },
            {
                elapsedMs: 110_000,
                pendingTranscript: "Later correction: the pilot is not Friday. It moves to Monday because the review lead needs another pass.",
                sampleAppendMarkdown: "- Correction: pilot moves to Monday because the review lead needs another pass.",
            },
            {
                elapsedMs: 210_000,
                pendingTranscript: "Support should treat Friday as preparation time and avoid telling operators the pilot is live.",
                sampleAppendMarkdown: "- Friday is preparation time; support should not say the pilot is live.",
            },
            {
                elapsedMs: 330_000,
                pendingTranscript: "The final owner for the Monday readiness check is Mina, with Jay as backup if Mina is unavailable.",
                sampleAppendMarkdown: "- Mina owns Monday readiness check; Jay is backup if Mina is unavailable.",
            },
            {
                elapsedMs: 450_000,
                pendingTranscript: "Open question remains whether the checklist should call out the date correction explicitly.",
                sampleAppendMarkdown: "- Verify whether the checklist should call out the date correction explicitly.",
            },
        ],
        expectedGrowthRisk: [
            "late corrections can leave stale live notes",
            "final notes need current notes plus transcript verification",
            "full current notes context grows while stale facts remain visible",
        ],
    },
];
