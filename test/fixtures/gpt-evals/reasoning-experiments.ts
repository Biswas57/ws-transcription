export type GptEvalFlow =
    | "revision"
    | "forms-live-extraction"
    | "notes-live-patch"
    | "forms-final"
    | "notes-final"
    | "summarise"
    | "reorganise";

export type GptEvalApi = "responses" | "chat-completions";

export type GptEvalVariant = {
    name: string;
    api: GptEvalApi;
    model: string;
    reasoning: "none" | "low" | "medium";
    outputMode: "json_schema" | "json_object";
    role: "baseline" | "candidate";
    productionDefault: boolean;
    notes: string;
};

export type GptReasoningExperiment = {
    name: string;
    flow: GptEvalFlow;
    linkedFixtures: string[];
    latencyClass:
    | "realtime-critical"
    | "user-waiting"
    | "background-ish-visible"
    | "non-critical";
    qualityRisks: string[];
    metrics: string[];
    variants: GptEvalVariant[];
};

export const gptReasoningExperiments: GptReasoningExperiment[] = [
    {
        name: "revision-mini-none-baseline",
        flow: "revision",
        linkedFixtures: [
            "medical-intake-basic",
            "correction-overwrite",
            "rca-process-final",
            "short-study-final",
        ],
        latencyClass: "realtime-critical",
        qualityRisks: [
            "word substitution changes meaning",
            "revision drops usable Whisper text",
        ],
        metrics: [
            "request duration",
            "parse success",
            "fallback triggered",
            "required concept preservation",
        ],
        variants: [
            {
                name: "current-mini-none",
                api: "responses",
                model: "gpt-5.4-mini",
                reasoning: "none",
                outputMode: "json_schema",
                role: "baseline",
                productionDefault: true,
                notes: "Current setting appears already optimised for speed and fail-open behaviour.",
            },
        ],
    },
    {
        name: "forms-live-reasoning-and-routing",
        flow: "forms-live-extraction",
        linkedFixtures: [
            "forms-live-basic-short",
            "forms-live-correction-fragment",
            "forms-live-sparse-unknowns",
            "forms-live-correction-normalisation",
            "forms-live-explicit-na",
            "forms-live-noisy-fragment",
        ],
        latencyClass: "realtime-critical",
        qualityRisks: [
            "short values are missed",
            "unknown fields are invented",
            "corrections are applied too early",
        ],
        metrics: [
            "p50/p90/p95 latency",
            "extracted field precision",
            "extracted field recall",
            "malformed JSON rate",
            "schema validity",
        ],
        variants: [
            {
                name: "current-chat-mini-low",
                api: "chat-completions",
                model: "gpt-5.4-mini",
                reasoning: "low",
                outputMode: "json_object",
                role: "baseline",
                productionDefault: true,
                notes: "Current low-latency live path.",
            },
            {
                name: "candidate-chat-mini-none",
                api: "chat-completions",
                model: "gpt-5.4-mini",
                reasoning: "none",
                outputMode: "json_object",
                role: "candidate",
                productionDefault: false,
                notes: "Only acceptable if short-value recall and correction handling do not regress.",
            },
            {
                name: "candidate-responses-mini-low",
                api: "responses",
                model: "gpt-5.4-mini",
                reasoning: "low",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "T-083/T-090 strict-schema candidate using sparse updates with known field-key enum values.",
            },
        ],
    },
    {
        name: "notes-live-reasoning-and-routing",
        flow: "notes-live-patch",
        linkedFixtures: [
            "early-patch-basic",
            "side-topic-repetition",
            "notes-live-long-current-notes",
            "notes-live-heading-reuse",
            "notes-live-fallback-section",
            "notes-live-unsafe-or-repeated",
            "notes-live-side-topic-main-topic-balance",
            "notes-live-long-meeting-rolling-context",
            "notes-live-lecture-topic-shift",
            "notes-live-repeated-correction",
            "notes-live-tangent-with-action",
        ],
        latencyClass: "realtime-critical",
        qualityRisks: [
            "unsafe patch is produced",
            "duplicate notes accumulate",
            "side topics dominate canonical notes",
        ],
        metrics: [
            "p50/p90/p95 latency",
            "malformed JSON rate",
            "rejected patch rate",
            "useful patch rate",
            "duplicate patch rate",
            "schema validity",
        ],
        variants: [
            {
                name: "current-chat-mini-low",
                api: "chat-completions",
                model: "gpt-5.4-mini",
                reasoning: "low",
                outputMode: "json_object",
                role: "baseline",
                productionDefault: true,
                notes: "Current live patch route with backend safety filters.",
            },
            {
                name: "candidate-chat-mini-none",
                api: "chat-completions",
                model: "gpt-5.4-mini",
                reasoning: "none",
                outputMode: "json_object",
                role: "candidate",
                productionDefault: false,
                notes: "Only acceptable if duplicate and unsafe patch rates do not increase.",
            },
            {
                name: "candidate-responses-mini-low",
                api: "responses",
                model: "gpt-5.4-mini",
                reasoning: "low",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "Belongs with T-083/T-090 live strict-schema evaluation.",
            },
        ],
    },
    {
        name: "forms-final-model-reasoning",
        flow: "forms-final",
        linkedFixtures: [
            "medical-intake-basic",
            "correction-overwrite",
            "unknown-empty-contract",
            "value-normalisation-and-correction",
        ],
        latencyClass: "user-waiting",
        qualityRisks: [
            "corrections regress",
            "unknown empty values are invented",
            "explicit N/A is mishandled",
        ],
        metrics: [
            "expected field accuracy",
            "correction handling",
            "unknown field handling",
            "explicit N/A handling",
            "fallback triggered",
        ],
        variants: [
            {
                name: "current-final-medium",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
                outputMode: "json_schema",
                role: "baseline",
                productionDefault: true,
                notes: "Current accuracy-biased final extraction route.",
            },
            {
                name: "candidate-final-low",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "low",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "Compare against medium before lowering final extraction reasoning.",
            },
        ],
    },
    {
        name: "notes-final-model-reasoning",
        flow: "notes-final",
        linkedFixtures: ["rca-process-final", "short-study-final"],
        latencyClass: "user-waiting",
        qualityRisks: [
            "required facts are dropped",
            "open questions are lost",
            "hallucination traps appear",
            "canonical current notes are over-compressed",
        ],
        metrics: [
            "required concept coverage",
            "forbidden concept absence",
            "open question preservation",
            "output length",
            "fallback triggered",
        ],
        variants: [
            {
                name: "current-final-medium",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
                outputMode: "json_schema",
                role: "baseline",
                productionDefault: true,
                notes: "Current quality-biased final notes route.",
            },
            {
                name: "candidate-final-low",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "low",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "Only acceptable if fact and open-question preservation do not regress.",
            },
        ],
    },
    {
        name: "summarise-model-reasoning",
        flow: "summarise",
        linkedFixtures: [
            "summarise-rca-process",
            "summarise-long-meeting-actions",
            "summarise-study-repeated-detail",
        ],
        latencyClass: "background-ish-visible",
        qualityRisks: [
            "summary is too similar to reorganise",
            "important warnings are compressed away",
            "open questions are lost",
        ],
        metrics: [
            "compression ratio",
            "heading count reduction",
            "required concept preservation",
            "forbidden concept absence",
            "open question preservation",
        ],
        variants: [
            {
                name: "current-final-medium",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
                outputMode: "json_schema",
                role: "baseline",
                productionDefault: true,
                notes: "Current summary route after T-096 prompt tuning.",
            },
            {
                name: "candidate-final-low",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "low",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "Evaluate whether low reasoning preserves compression and safety.",
            },
            {
                name: "candidate-mini-medium",
                api: "responses",
                model: "gpt-5.4-mini",
                reasoning: "medium",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "Only useful if quality is equivalent on long notes.",
            },
        ],
    },
    {
        name: "reorganise-model-reasoning",
        flow: "reorganise",
        linkedFixtures: ["reorganise-rca-process"],
        latencyClass: "background-ish-visible",
        qualityRisks: [
            "detail is summarised away",
            "section improvement is weak",
            "hallucination traps appear",
        ],
        metrics: [
            "detail preservation",
            "section improvement",
            "required concept preservation",
            "forbidden concept absence",
            "no aggressive summarisation",
        ],
        variants: [
            {
                name: "current-final-medium",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "medium",
                outputMode: "json_schema",
                role: "baseline",
                productionDefault: true,
                notes: "Current preservation-biased transform route.",
            },
            {
                name: "candidate-final-low",
                api: "responses",
                model: "gpt-5.4",
                reasoning: "low",
                outputMode: "json_schema",
                role: "candidate",
                productionDefault: false,
                notes: "Lower priority than Summarise because detail preservation is core.",
            },
        ],
    },
];
