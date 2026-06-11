# T-085 Reasoning And Model Evaluation

> Historical note: this report records an evaluation-planning stage and may describe earlier runtime defaults or candidates. Current runtime architecture is documented in `DECISIONS.md` and `AI_AGENT_CONTEXT.md`; Notes live is now Responses-only with no Chat fallback, and Reorganise is low reasoning by default.

This is a non-production evaluation report. It does not change prompts, models,
reasoning effort, API routing, schemas, provider behaviour, WebSocket contracts,
HTTP contracts, dependencies, or product behaviour.

## Current Model And Reasoning Inventory

Verified from `gpt/model-config.ts`, `gpt/revision.ts`, `gpt/forms.ts`,
`gpt/notes-live.ts`, `gpt/notes-final.ts`, `gpt/notes-transform.ts`, and
`gpt/provider.ts`.

| Flow | API | Model | Reasoning | Output mode | Max output budget | Frequency | Latency sensitivity | Current risk |
| ---- | --- | ----- | --------- | ----------- | ----------------- | --------- | ------------------- | ------------ |
| Revision | Responses | `gpt-5.4-mini` | `none` | strict JSON schema, `correctedText` | `min(512, max(64, ceil(inputTokens * 1.3) + 32))` | Every accepted transcript segment after mode-aware revision gates | Realtime-critical | Low cost/latency risk; quality risk is word-substitution drift, but fail-open returns raw Whisper text |
| Forms live extraction | Chat Completions | `gpt-5.4-mini` | `low` | `json_object`, `parsedAttributes` | `max(512, template.length * 60)` | Repeated during Forms recording | Realtime-critical | High extraction correctness risk for short values, corrections, and unknowns |
| Notes live patch | Chat Completions | `gpt-5.4-mini` | `low` | `json_object`, append-only patch | `min(2048, max(1024, ceil(transcriptTokens * 1.2) + 512))` | Repeated during Notes recording, coalesced | Realtime-critical, long-session target under 10s where possible | High latency and duplicate/unsafe patch risk; backend patch filters remain required |
| Forms final | Responses | `gpt-5.4` | `medium` | strict JSON schema, `finalAttributes` | `max(1024, template.length * 80)` | Once on Forms stop/finalisation | User-waiting, around 30s preferred, under 60s where possible | High extraction correctness risk for corrections, `""`, and `N/A` |
| Notes final | Responses | `gpt-5.4` | `medium` | strict JSON schema, `notesMarkdown` | `min(16000, max(2048, ceil(inputTokens * 1.8)))` | Once on Notes stop/finalisation | User-waiting, around 30s preferred, under 60s where possible | High hallucination and preservation risk; truncation/fallback behaviour matters |
| Summarise | Responses | `gpt-5.4` | `medium` | strict JSON schema, `summaryMarkdown` | `min(16000, max(1536, ceil(inputTokens * 1.1) + 768))` | User-triggered transform | Background-ish but visible, 15-30s preferred | Compression vs preservation risk; must remain distinct from Reorganise |
| Reorganise | Responses | `gpt-5.4` | `medium` | strict JSON schema, `reorganisedMarkdown` | `min(16000, max(1536, ceil(inputTokens * 1.4) + 768))` | User-triggered transform | Background-ish but visible, 15-30s preferred | High detail-preservation risk; output-too-short guard exists |

## Quality And Latency Classification

| Flow | Quality sensitivity | Latency/cost sensitivity | Current change posture |
| ---- | ------------------- | ------------------------ | ---------------------- |
| Revision | Medium: preserve meaning and avoid correction drift | High: frequent pipeline call | Keep as-is unless a cheaper model exists and fail-open rate/quality are equivalent |
| Forms live extraction | High extraction correctness risk | Very high latency sensitivity | Do not change now; evaluate under live routing experiments |
| Notes live patch | High duplicate/unsafe patch risk | Very high latency and long-session cost risk | Do not change now; evaluate with live fixtures, latency, and rejection metrics |
| Forms final | High extraction correctness risk | Medium user-waiting risk | Candidate for `low` reasoning only after fixture-backed comparison |
| Notes final | High hallucination/preservation risk | Medium user-waiting and cost risk | Candidate for `low` reasoning only after fixture-backed comparison |
| Summarise | Medium-high compression/preservation risk | Medium visible transform latency | Best first final/transform experiment after T-084 |
| Reorganise | High detail-preservation risk | Medium visible transform latency | Change later than Summarise because it should preserve more detail |

## Fixture Coverage Map

| Flow | Relevant T-084 fixtures | Can check now | Cannot check yet | Needs OpenAI-backed eval before production change |
| ---- | ----------------------- | ------------- | ---------------- | ---------------------------------------------- |
| Revision | Forms, Notes final, and Notes live transcript text | Static concept preservation targets and hallucination traps | Actual correction quality, provider latency, and fail-open frequency | Yes |
| Forms live extraction | `medical-intake-basic`, `correction-overwrite` | Expected fields, short values, correction semantics, `""`, `N/A` | Incremental precision/recall over real audio cadence | Yes |
| Notes live patch | `early-patch-basic`, `side-topic-repetition` | Required patch concepts, forbidden concepts, side-topic safety | Actual malformed JSON rate, rejected/useful patch rate, latency | Yes |
| Forms final | `medical-intake-basic`, `correction-overwrite` | Final field accuracy targets and correction rules | Model output quality across broader templates | Yes |
| Notes final | `rca-process-final`, `short-study-final` | Required concepts, forbidden concepts, open question preservation | Long dense session behaviour and section quality at scale | Yes |
| Summarise | `summarise-rca-process` | Compression ratio target, key concept preservation, open questions | Real model compression style and difference from Reorganise across many notes | Yes |
| Reorganise | `reorganise-rca-process` | Required detail preservation and section hints | Real section quality and preservation ratio across messy notes | Yes |

## Candidate Experiments

Do not run these in normal tests. Run them only through an explicit, opt-in eval
runner in a future ticket.

| Flow | Baseline | Candidate(s) | Primary decision question |
| ---- | -------- | ------------ | ------------------------- |
| Revision | `gpt-5.4-mini`, `none`, Responses | No immediate candidate | Is current already optimal enough for speed and fail-open safety? |
| Forms live extraction | `gpt-5.4-mini`, `low`, Chat `json_object` | `gpt-5.4-mini`, `none`, Chat `json_object`; strict Responses schema under T-083/T-090 | Can latency/cost improve without losing short values or corrections? |
| Notes live patch | `gpt-5.4-mini`, `low`, Chat `json_object` | `gpt-5.4-mini`, `none`, Chat; strict Responses schema under T-083/T-090 | Can latency improve without more duplicate, malformed, or unsafe patches? |
| Forms final | `gpt-5.4`, `medium`, Responses | `gpt-5.4`, `low`, Responses | Does `low` preserve correction, unknown, and `N/A` semantics? |
| Notes final | `gpt-5.4`, `medium`, Responses | `gpt-5.4`, `low`, Responses | Does `low` preserve key facts, open questions, and hallucination avoidance? |
| Summarise | `gpt-5.4`, `medium`, Responses | `gpt-5.4`, `low`; `gpt-5.4-mini`, `medium` | Can Summarise become faster/cheaper while staying distinct from Reorganise? |
| Reorganise | `gpt-5.4`, `medium`, Responses | `gpt-5.4`, `low` | Can detail preservation remain acceptable with lower reasoning? |

## Required Metrics For Future Runs

All Responses flows should collect: request duration, input tokens, cached input
tokens, output tokens, reasoning tokens, total tokens, output chars, status,
incomplete reason, parse success, fallback triggered, and an external cost
estimate if a pricing table is maintained outside tests.

Flow-specific metrics:

- Notes final: required concept coverage, forbidden concept absence, open question
  preservation, hallucination traps avoided, output length, section quality,
  current notes preservation, transcript coverage.
- Forms final: expected field accuracy, correction handling, unknown `""`
  handling, explicit `N/A` handling, no invented values.
- Summarise: compression ratio, heading count reduction, bullet count reduction,
  required concept preservation, forbidden concept absence, open question
  preservation, difference from Reorganise.
- Reorganise: detail preservation, section improvement, required concept
  preservation, forbidden concept absence, no aggressive summarisation.
- Live flows: p50/p90/p95 latency, malformed JSON rate, schema-invalid rate if a
  Responses variant exists, rejected patch rate, useful patch rate, duplicate
  patch rate, extracted field precision/recall, cost per live update, and
  long-session degradation.

## Decision Thresholds

Use these as minimum gates, not final production proof:

- Do not lower reasoning if required concept coverage drops on any fixture.
- Do not lower reasoning if forbidden hallucination traps appear.
- Do not lower reasoning if Forms correction handling regresses.
- Do not lower reasoning if explicit `N/A` or unknown `""` semantics regress.
- Do not migrate live paths if p90/p95 latency worsens meaningfully.
- Do not adopt cheaper models if fallback, incomplete, or parse failure rate
  increases.
- Prefer cheaper/faster settings only when quality is equivalent or any quality
  loss is explicitly accepted for that flow.
- Treat the current T-084 fixture set as a starting gate only; broader fixtures
  and opt-in OpenAI runs are still needed before production default changes.

## Recommended Experiment Order

1. Summarise `medium` vs `low` on `gpt-5.4`, because it is user-visible but less
   preservation-critical than Reorganise.
2. Forms final `medium` vs `low`, because field correctness gates are concrete.
3. Notes final `medium` vs `low`, after adding more long-session fixtures if
   possible.
4. Reorganise `medium` vs `low`, because preservation quality is central.
5. Live Forms/Notes routing and reasoning variants under T-083/T-090 with
   latency and malformed-output metrics.
6. Revision only if a lower-cost model becomes available or logs show revision
   is a material cost/latency driver.

## What Should Not Change Yet

- Do not change production model names or reasoning defaults from this report.
- Do not move live paths to Responses until T-083/T-090 measures latency and
  schema effects.
- Do not remove backend safety filters for Notes live patches.
- Do not reduce final quality settings without fixture-backed OpenAI evals.
- Do not hardcode provider pricing into tests.

## Proposed Follow-Up Tickets

- T-085a: Add an opt-in OpenAI eval runner for the T-084 fixtures, gated by an
  environment flag and excluded from normal tests.
- T-085b: Run Summarise and Forms final `medium` vs `low` experiments and record
  fixture metrics.
- T-083/T-090: Evaluate strict Responses schemas for live Forms extraction and
  Notes live patching with latency and malformed-output metrics.
- T-086: Evaluate prompt caching only after current model/reasoning baselines are
  measured.
