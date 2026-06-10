import type { FormsLiveEvalFixture } from "./types.js";

export const formsLiveFixtures: FormsLiveEvalFixture[] = [
    {
        kind: "forms-live",
        name: "forms-live-basic-short",
        transcriptSegment: [
            "My name is Jordan Lee.",
            "Yes, I consent.",
            "The appointment fee is $500.",
        ].join(" "),
        fields: [
            { key: "full_name", label: "Full name" },
            { key: "consent", label: "Consent given" },
            { key: "appointment_fee", label: "Appointment fee" },
            { key: "appointment_date", label: "Appointment date" },
        ],
        currentAttributes: {},
        expectedSparseAttributes: {
            full_name: "Jordan Lee",
            consent: "yes",
            appointment_fee: "$500",
        },
        expectedOmittedFields: ["appointment_date"],
        forbiddenAttributes: ["appointment_date"],
        requiredConcepts: ["Jordan Lee", "yes", "$500"],
        forbiddenConcepts: ["Tuesday", "unknown"],
    },
    {
        kind: "forms-live",
        name: "forms-live-correction-fragment",
        transcriptSegment: [
            "Actually make that Thursday at 3pm, not Tuesday.",
            "The reference code is not applicable.",
        ].join(" "),
        fields: [
            { key: "appointment_date", label: "Appointment date" },
            { key: "appointment_time", label: "Appointment time" },
            { key: "reference_code", label: "Reference code" },
            { key: "support_notes", label: "Support notes" },
        ],
        currentAttributes: {
            appointment_date: "Tuesday",
        },
        expectedSparseAttributes: {
            appointment_date: "Thursday",
            appointment_time: "3pm",
            reference_code: "N/A",
        },
        expectedOmittedFields: ["support_notes"],
        forbiddenAttributes: ["support_notes"],
        requiredConcepts: ["Thursday", "3pm", "N/A"],
        forbiddenConcepts: ["Tuesday", "reference unknown"],
    },
];
