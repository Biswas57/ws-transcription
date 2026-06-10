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
        expectedSparseAttributeAlternatives: {
            reference_code: ["not applicable", "Not applicable"],
        },
        expectedOmittedFields: ["support_notes"],
        forbiddenAttributes: ["support_notes"],
        requiredConcepts: ["Thursday", "3pm", "N/A"],
        forbiddenConcepts: ["Tuesday", "reference unknown"],
    },
    {
        kind: "forms-live",
        name: "forms-live-sparse-unknowns",
        transcriptSegment: [
            "The client is Morgan Patel.",
            "The reason for today is a tenancy support review.",
            "They did not give a phone number, email, or address yet.",
        ].join(" "),
        fields: [
            { key: "client_name", label: "Client name" },
            { key: "review_reason", label: "Review reason" },
            { key: "phone", label: "Phone" },
            { key: "email", label: "Email" },
            { key: "address", label: "Address" },
            { key: "case_notes", label: "Case notes" },
        ],
        currentAttributes: {},
        expectedSparseAttributes: {
            client_name: "Morgan Patel",
            review_reason: "tenancy support review",
        },
        expectedOmittedFields: ["phone", "email", "address", "case_notes"],
        forbiddenAttributes: ["phone", "email", "address", "case_notes"],
        requiredConcepts: ["Morgan Patel", "tenancy support review"],
        forbiddenConcepts: ["not provided", "did not give"],
    },
    {
        kind: "forms-live",
        name: "forms-live-correction-normalisation",
        transcriptSegment: [
            "The fee is five hundred dollars, actually write $500.",
            "Appointment is Tuesday, sorry Wednesday.",
            "Priority is low, actually urgent.",
        ].join(" "),
        fields: [
            { key: "fee", label: "Fee" },
            { key: "appointment_day", label: "Appointment day" },
            { key: "priority", label: "Priority" },
            { key: "follow_up_notes", label: "Follow-up notes" },
        ],
        currentAttributes: {
            appointment_day: "Tuesday",
            priority: "low",
        },
        expectedSparseAttributes: {
            fee: "$500",
            appointment_day: "Wednesday",
            priority: "urgent",
        },
        expectedOmittedFields: ["follow_up_notes"],
        forbiddenAttributes: ["follow_up_notes"],
        requiredConcepts: ["$500", "Wednesday", "urgent"],
        forbiddenConcepts: ["Tuesday", "low", "five hundred dollars"],
    },
    {
        kind: "forms-live",
        name: "forms-live-explicit-na",
        transcriptSegment: [
            "No known allergies.",
            "Previous surgery is not applicable.",
            "We have not collected an emergency contact yet.",
        ].join(" "),
        fields: [
            { key: "allergies", label: "Allergies" },
            { key: "previous_surgery", label: "Previous surgery" },
            { key: "emergency_contact", label: "Emergency contact" },
            { key: "medications", label: "Medications" },
        ],
        currentAttributes: {},
        expectedSparseAttributes: {
            allergies: "N/A",
            previous_surgery: "N/A",
        },
        expectedSparseAttributeAlternatives: {
            allergies: ["No known allergies"],
            previous_surgery: ["not applicable", "Not applicable"],
        },
        expectedOmittedFields: ["emergency_contact", "medications"],
        forbiddenAttributes: ["emergency_contact", "medications"],
        requiredConcepts: ["N/A"],
        forbiddenConcepts: ["not collected", "unknown"],
    },
    {
        kind: "forms-live",
        name: "forms-live-noisy-fragment",
        transcriptSegment: [
            "Um, ignore the coffee chat.",
            "The actual department is payroll.",
            "Someone joked about a weekend barbecue, but that is not part of the form.",
        ].join(" "),
        fields: [
            { key: "department", label: "Department" },
            { key: "event_notes", label: "Event notes" },
            { key: "availability", label: "Availability" },
        ],
        currentAttributes: {},
        expectedSparseAttributes: {
            department: "payroll",
        },
        expectedOmittedFields: ["event_notes", "availability"],
        forbiddenAttributes: ["event_notes", "availability"],
        requiredConcepts: ["payroll"],
        forbiddenConcepts: ["coffee", "barbecue", "weekend"],
    },
];
