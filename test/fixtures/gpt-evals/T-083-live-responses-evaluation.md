# T-083 / T-090 Live Responses Strict-Schema Evaluation

## Executive Summary

Status: expanded and calibrated live-only opt-in eval completed on 2026-06-10.

This ticket evaluates current live Chat Completions JSON-mode paths against Responses API strict Structured Outputs candidates for:

- Forms live extraction
- Notes live patch generation

Result at the T-083 decision point: keep production Chat live paths at that stage. T-115 later switched Notes live to Responses by default while keeping Forms live on Chat.

After T-083d calibration, the redesigned sparse Forms live Responses schema passed all six Forms live fixtures, matching the current Chat baseline. Notes live Responses passed all seven expanded Notes live fixtures in the calibrated run. Chat passed six of seven and missed the fallback-section placement fixture because it put the training topic under the existing release heading instead of using fallback/new-section structure.

T-083e/T-083f added four harder Notes live fixtures and repeated the Notes-only matrix three times. Across 33 Notes live cases per variant, Responses passed `31/33` and Chat passed `28/33`. Responses was stronger on fallback/new-topic section placement, while Chat remained slightly cheaper and lower-latency on aggregate.

Responses remains promising, especially for Notes live, but this is still an evaluation ticket. The repeated run is not a production migration, and Responses still showed higher average token use plus occasional semantic failures.

No production live routing changed.

## Current Live Baseline

### Forms live extraction

- Function: `extractAttributesFromText`
- Module: `gpt/forms.ts`
- API: Chat Completions
- Model: `gpt-5.4-mini`
- Reasoning: `low`
- Output mode: `response_format: { type: "json_object" }`
- Expected output shape: `{ "parsedAttributes": { "field_key": "value" } }`
- Runtime behaviour: sparse attributes only, unknown/empty values omitted by backend filtering

### Notes live patching

- Function: `generateNotesIncrementalPatch`
- Module: `gpt/notes-live.ts`
- API: Chat Completions
- Model: `gpt-5.4-mini`
- Reasoning: `low`
- Output mode: `response_format: { type: "json_object" }`
- Expected output shape: append-only patch JSON with `updates` and optional `fallbackAppendMarkdown`
- Runtime behaviour: patch is applied by `applyNotesLivePatch`, so schema-valid output still goes through append-only safety filters

## Expanded Fixture Coverage

### Forms live

Expanded from 2 to 6 fixtures:

- `forms-live-basic-short`
- `forms-live-correction-fragment`
- `forms-live-sparse-unknowns`
- `forms-live-correction-normalisation`
- `forms-live-explicit-na`
- `forms-live-noisy-fragment`

Coverage now includes short values, corrections, value normalisation, sparse unknown handling, explicit non-applicability, and irrelevant side chatter.

### Notes live

Expanded from 2 to 11 fixtures:

- `early-patch-basic`
- `side-topic-repetition`
- `notes-live-long-current-notes`
- `notes-live-heading-reuse`
- `notes-live-fallback-section`
- `notes-live-unsafe-or-repeated`
- `notes-live-side-topic-main-topic-balance`
- `notes-live-long-meeting-rolling-context`
- `notes-live-lecture-topic-shift`
- `notes-live-repeated-correction`
- `notes-live-tangent-with-action`

Coverage now includes long current notes, heading reuse, fallback section creation, repeated old content, title-like unsafe speech, side-topic containment, rolling context, topic shifts, corrections, and tangent/action separation.

## Candidate Schema Update

The first Forms live Responses candidate used a full known-field object:

```json
{ "parsedAttributes": { "field_key": "value or empty string" } }
```

That was strict, but it may have pressured the model to consider every field. The expanded eval replaces it with a sparse updates candidate:

```json
{
  "updates": [
    { "fieldKey": "<known-field-key>", "value": "new or corrected value" }
  ]
}
```

Rules:

- `fieldKey` is an enum of the known fixture/template keys.
- `updates` may be empty.
- Unknown fields are schema-invalid.
- Empty-string updates are ignored by eval conversion.
- Duplicate updates are resolved deterministically with last-write-wins.

This is eval-only scaffolding. Production Forms live extraction still uses Chat Completions and the current sparse `parsedAttributes` contract.

## Failure Calibration

### `forms-live-explicit-na`

- Chat classification: acceptable alternate live wording.
- Responses classification: acceptable alternate live wording.
- Fixture/checker changed: yes. Forms live now allows fixture-side alternatives for explicit non-applicability wording. Forms final remains strict: unknown fields return `""`, explicit non-applicability returns `N/A`.
- Remains a blocker: no.
- Migration meaning: this is not evidence for Responses migration. It clarifies that live Forms can be sparse and semantically correct without always using the final canonical `N/A` spelling.

### `notes-live-fallback-section`

- Chat classification: product-quality weakness in live structure. The content was useful, but it was appended under the existing release heading instead of creating/using fallback/new-section structure for a separate training topic.
- Responses classification: checker phrase issue fixed. Responses created safe standalone fallback structure; the missing concept was present through equivalent section wording.
- Fixture/checker changed: yes. Required concept alternatives now include the section wording seen in useful safe outputs.
- Remains a blocker: yes for production migration confidence, especially for live section-placement quality.
- Migration meaning: Responses outperformed Chat on this single calibrated fixture, but one fixture/run is not enough to migrate production live routing.

### `notes-live-unsafe-or-repeated`

- Chat classification: acceptable model behaviour after calibration. The output captured the new owner and did not duplicate the old legal-review warning.
- Responses classification: acceptable model behaviour after calibration. The output captured the new owner and did not duplicate the old legal-review warning.
- Fixture/checker changed: yes. Notes live forbidden checks now score newly applied patch lines instead of raw model output or the whole canonical note. Quoted title wording is allowed when the output explicitly says not to use it as a title; actual applied `#` document-title markdown remains a failure.
- Remains a blocker: no in the calibrated run.
- Migration meaning: safety filters/checkers should continue scoring the applied patch state, because raw patch text is not necessarily the user-visible canonical note.

## Calibrated Live Eval Execution

- Date: 2026-06-10
- Matrix: live-only calibrated single run
- Provider cases: 26
- Command:

```bash
NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem OPENAI_EVALS=1 OPENAI_EVAL_FLOWS=forms-live,notes-live OPENAI_EVALS_WRITE_OUTPUTS=1 OPENAI_EVALS_OUTPUT_DIR=/tmp/formify-gpt-eval-outputs pnpm exec vitest run test/gpt-openai-evals.test.ts
```

- Raw output path: `/tmp/formify-gpt-eval-outputs`
- Raw outputs committed: no
- Test result: passed, 18 tests

## Calibrated Single-Run Results Table

| Flow | Fixture | Variant | API | Pass | Duration | Total tokens | Reasoning tokens | Output chars | Main notes |
| ---- | ------- | ------- | --- | ---: | -------: | -----------: | ---------------: | -----------: | ---------- |
| forms-live-extraction | forms-live-basic-short | current-chat-mini-low | Chat | yes | 1678ms | 637 | 12 | 88 | - |
| forms-live-extraction | forms-live-basic-short | candidate-responses-mini-low | Responses | yes | 1956ms | 840 | 13 | 142 | - |
| forms-live-extraction | forms-live-correction-fragment | current-chat-mini-low | Chat | yes | 1501ms | 687 | 57 | 111 | - |
| forms-live-extraction | forms-live-correction-fragment | candidate-responses-mini-low | Responses | yes | 1041ms | 866 | 34 | 154 | - |
| forms-live-extraction | forms-live-sparse-unknowns | current-chat-mini-low | Chat | yes | 1196ms | 647 | 10 | 92 | - |
| forms-live-extraction | forms-live-sparse-unknowns | candidate-responses-mini-low | Responses | yes | 1002ms | 866 | 29 | 125 | - |
| forms-live-extraction | forms-live-correction-normalisation | current-chat-mini-low | Chat | yes | 1584ms | 660 | 23 | 85 | - |
| forms-live-extraction | forms-live-correction-normalisation | candidate-responses-mini-low | Responses | yes | 1000ms | 869 | 31 | 139 | - |
| forms-live-extraction | forms-live-explicit-na | current-chat-mini-low | Chat | yes | 1576ms | 676 | 49 | 91 | - |
| forms-live-extraction | forms-live-explicit-na | candidate-responses-mini-low | Responses | yes | 1585ms | 894 | 67 | 113 | - |
| forms-live-extraction | forms-live-noisy-fragment | current-chat-mini-low | Chat | yes | 981ms | 624 | 5 | 45 | - |
| forms-live-extraction | forms-live-noisy-fragment | candidate-responses-mini-low | Responses | yes | 1083ms | 832 | 26 | 57 | - |
| notes-live-patch | early-patch-basic | current-chat-mini-low | Chat | yes | 1499ms | 1290 | 11 | 216 | - |
| notes-live-patch | early-patch-basic | candidate-responses-mini-low | Responses | yes | 1022ms | 1372 | 22 | 218 | - |
| notes-live-patch | side-topic-repetition | current-chat-mini-low | Chat | yes | 1108ms | 1302 | 10 | 155 | - |
| notes-live-patch | side-topic-repetition | candidate-responses-mini-low | Responses | yes | 1038ms | 1377 | 14 | 151 | - |
| notes-live-patch | notes-live-long-current-notes | current-chat-mini-low | Chat | yes | 1590ms | 1436 | 54 | 424 | - |
| notes-live-patch | notes-live-long-current-notes | candidate-responses-mini-low | Responses | yes | 1547ms | 1488 | 47 | 366 | - |
| notes-live-patch | notes-live-heading-reuse | current-chat-mini-low | Chat | yes | 1118ms | 1291 | 7 | 157 | - |
| notes-live-patch | notes-live-heading-reuse | candidate-responses-mini-low | Responses | yes | 839ms | 1364 | 9 | 157 | - |
| notes-live-patch | notes-live-fallback-section | current-chat-mini-low | Chat | no | 1558ms | 1311 | 16 | 282 | expected-fallback-missing |
| notes-live-patch | notes-live-fallback-section | candidate-responses-mini-low | Responses | yes | 1214ms | 1379 | 34 | 189 | - |
| notes-live-patch | notes-live-unsafe-or-repeated | current-chat-mini-low | Chat | yes | 2105ms | 1336 | 42 | 140 | - |
| notes-live-patch | notes-live-unsafe-or-repeated | candidate-responses-mini-low | Responses | yes | 1646ms | 1463 | 78 | 228 | - |
| notes-live-patch | notes-live-side-topic-main-topic-balance | current-chat-mini-low | Chat | yes | 1010ms | 1296 | 14 | 167 | - |
| notes-live-patch | notes-live-side-topic-main-topic-balance | candidate-responses-mini-low | Responses | yes | 974ms | 1366 | 13 | 167 | - |

## Forms Live Findings

The sparse Responses candidate fixed the most obvious design problem from the first run. It no longer had to emit a full known-field object with empty strings, and it passed all six Forms live fixtures in the calibrated run.

Findings:

- Chat baseline: `6/6`.
- Responses sparse candidate: `6/6`.
- Live explicit non-applicability accepts equivalent live wording; Forms final remains strict.
- Responses produced schema-shaped sparse updates.
- Responses used more total tokens on every Forms live fixture in this run.
- Latency was mixed; Responses was faster on some fixtures and slower on others.

Decision for Forms live: keep Chat. The sparse Responses candidate is much improved, but it is not clearly better than the current live path and uses more tokens.

## Notes Live Findings

Responses passed all expanded Notes live fixtures in this calibrated run. Chat passed six of seven.

Findings:

- Chat baseline: `6/7`.
- Responses strict-schema candidate: `7/7`.
- Both variants handled long current notes, heading reuse, side-topic balance, and unsafe/repeated-title wording after calibration.
- Chat missed the fallback-section placement check by appending separate training content under the existing release heading.
- Responses used slightly more total tokens on every Notes live fixture in this run.
- Responses remained schema-valid and went through the same backend patch safety filters.

Decision for Notes live: Responses is promising, but not ready for production migration from one calibrated run. Keep Chat until repeated runs and more long-session fixtures confirm the quality/latency/token tradeoff.

## Repeated Notes Live Evaluation

### Expanded Notes Fixture Coverage

T-083e added four harder Notes live fixtures:

- `notes-live-long-meeting-rolling-context`: long existing notes with a narrow customer-communications update.
- `notes-live-lecture-topic-shift`: new lecture topic that should create fallback/new-topic structure instead of corrupting the current topic.
- `notes-live-repeated-correction`: correction to an existing backup-window detail without preserving the contradicted value.
- `notes-live-tangent-with-action`: useful action item mixed with low-value tangent details.

### Repeated Run Setup

- Date: 2026-06-10
- Matrix: Notes live only
- Repeats: 3
- Provider cases per repeat: 22
- Command shape:

```bash
NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem OPENAI_EVALS=1 OPENAI_EVAL_FLOWS=notes-live OPENAI_EVALS_WRITE_OUTPUTS=1 OPENAI_EVALS_OUTPUT_DIR=/tmp/formify-gpt-eval-outputs-t083f-runN pnpm exec vitest run test/gpt-openai-evals.test.ts
```

- Raw output paths: `/tmp/formify-gpt-eval-outputs-t083f-run1`, `/tmp/formify-gpt-eval-outputs-t083f-run2`, `/tmp/formify-gpt-eval-outputs-t083f-run3`
- Raw outputs committed: no

The repeated-run aggregate below applies the final calibrated checker behaviour. A false-positive forbidden-heading check for `# Cellular Respiration` was removed because it also matched safe `## Cellular Respiration` fallback headings.

### Aggregate Results

| Variant | Runs | Cases | Passes | Pass rate | Avg duration | P90 duration | Avg total tokens | P90 total tokens | Avg reasoning tokens | Main failure pattern |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Chat | 3 | 33 | 28 | 84.8% | 1422ms | 1722ms | 1329 | 1404 | 19 | Fallback/new-section headings sometimes emitted inside `updates[].appendMarkdown`, then rejected by the patch safety filter. |
| Responses | 3 | 33 | 31 | 93.9% | 1507ms | 2718ms | 1416 | 1463 | 39 | One fallback safety-filter miss and one tangent-inclusion miss; generally better section placement with higher token/reasoning overhead. |

### Fixture Stability

| Fixture | Chat | Responses | Notes |
| --- | ---: | ---: | --- |
| `early-patch-basic` | 3/3 | 3/3 | Stable on both variants. |
| `side-topic-repetition` | 3/3 | 3/3 | Stable on both variants. |
| `notes-live-long-current-notes` | 3/3 | 3/3 | Stable on both variants. |
| `notes-live-heading-reuse` | 3/3 | 3/3 | Stable on both variants. |
| `notes-live-fallback-section` | 0/3 | 2/3 | Chat repeatedly put new-section content in an unsafe append field; Responses was better but not perfect. |
| `notes-live-unsafe-or-repeated` | 3/3 | 3/3 | Stable after applied-note scoring calibration. |
| `notes-live-side-topic-main-topic-balance` | 3/3 | 3/3 | Stable on both variants. |
| `notes-live-long-meeting-rolling-context` | 3/3 | 3/3 | Stable on both variants. |
| `notes-live-lecture-topic-shift` | 1/3 | 3/3 | Responses handled fallback/new-topic structure more reliably. |
| `notes-live-repeated-correction` | 3/3 | 3/3 | Stable on both variants. |
| `notes-live-tangent-with-action` | 3/3 | 2/3 | Responses included tangent snack/coffee content once. |

### Repeated-Run Decision

Do not switch production live routing in T-083/T-090 itself.

Forms live remains on Chat because the sparse Responses candidate matched Chat quality but used more tokens and did not show a reliability advantage.

Notes live Responses is now strong enough to justify a separate Notes-live-only migration-prep ticket. That future ticket should handle production rollout shape, fallback strategy, safe monitoring, rollback criteria, and long/noisy fixture expansion before changing runtime routing.

### Runtime Prep Applied After Evaluation

T-112 added the Notes live Responses strict-schema path as an off-by-default runtime candidate behind `FORMIFY_NOTES_LIVE_PROVIDER=responses`.

At the T-112/T-113 prep stage, default production Notes live remained Chat. When the Responses candidate was enabled, Responses errors, incomplete output, empty output, or invalid patch JSON fell back once to the existing Chat path. Existing patch safety filters still apply after model output.

T-113 added canary-readiness guardrails around the runtime candidate. The backend now logs safe provider-mode metadata and fallback categories (`provider_error`, `incomplete_response`, `empty_output`, `parse_failed`, `schema_failed`) without raw transcript, note, prompt, or patch content.

T-115 later switched Notes live to the Responses strict-schema path by default. Rollback remains immediate with `FORMIFY_NOTES_LIVE_PROVIDER=chat`; `FORMIFY_NOTES_LIVE_PROVIDER=responses` explicitly selects the default Responses path.

## T-094/T-094a Bounded Context Note

A later paid full eval run after T-094 showed Notes live quality remained strong:
Responses passed all Notes live fixtures in that run, while Chat missed the
fallback-section and lecture-topic-shift cases. That run is useful for Notes
live quality, latency, output-shape, and safety-filter evidence.

Do not use that pre-T-094a run as proof of bounded live context savings. The
Notes live paid eval runner still built its input directly from fixture
`currentNotes` at that time. T-094a aligns the paid eval runner with the runtime
`buildNotesLivePatchRequest(...)` path, so rerun `OPENAI_EVAL_FLOWS=notes-live`
when a paid bounded-context check is needed.

## T-094b Notes Live Bounded Context Paid Eval

### Eval Execution

- Date: 2026-06-10
- Flow: Notes live only
- Provider cases: 22
- Command used:

```bash
NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem OPENAI_EVALS=1 OPENAI_EVAL_FLOWS=notes-live OPENAI_EVALS_WRITE_OUTPUTS=1 OPENAI_EVALS_OUTPUT_DIR=/tmp/formify-gpt-eval-outputs-t094b-notes-live pnpm exec vitest run test/gpt-openai-evals.test.ts
```

- Raw output path: `/tmp/formify-gpt-eval-outputs-t094b-notes-live`
- Raw outputs committed: no
- Test result: passed, 21 tests

### Quality Results

| Variant | Cases | Passes | Pass rate | Avg duration | Avg total tokens | Notes |
| ------- | ----: | -----: | --------: | -----------: | ---------------: | ----- |
| `current-chat-mini-low` | 11 | 9 | 81.8% | 1945ms | 1398 | Missed fallback/new-section placement on two fixtures; one 4823ms duration outlier. |
| `candidate-responses-mini-low` | 11 | 10 | 90.9% | 1928ms | 1480 | Passed fallback-section placement; missed one lecture topic-shift fixture; one 5272ms duration outlier. |

### Bounded Context Metadata

| Fixture | Variant | Original current notes chars | Context chars | Saved chars | Compacted | Heading count |
| ------- | ------- | ---------------------------: | ------------: | ----------: | --------- | ------------: |
| `early-patch-basic` | `current-chat-mini-low` | 0 | 0 | 0 | false | 0 |
| `early-patch-basic` | `candidate-responses-mini-low` | 0 | 0 | 0 | false | 0 |
| `side-topic-repetition` | `current-chat-mini-low` | 113 | 113 | 0 | false | 1 |
| `side-topic-repetition` | `candidate-responses-mini-low` | 113 | 113 | 0 | false | 1 |
| `notes-live-long-current-notes` | `current-chat-mini-low` | 6408 | 4313 | 2095 | true | 21 |
| `notes-live-long-current-notes` | `candidate-responses-mini-low` | 6408 | 4313 | 2095 | true | 21 |
| `notes-live-heading-reuse` | `current-chat-mini-low` | 101 | 101 | 0 | false | 2 |
| `notes-live-heading-reuse` | `candidate-responses-mini-low` | 101 | 101 | 0 | false | 2 |
| `notes-live-fallback-section` | `current-chat-mini-low` | 69 | 69 | 0 | false | 1 |
| `notes-live-fallback-section` | `candidate-responses-mini-low` | 69 | 69 | 0 | false | 1 |
| `notes-live-unsafe-or-repeated` | `current-chat-mini-low` | 115 | 115 | 0 | false | 1 |
| `notes-live-unsafe-or-repeated` | `candidate-responses-mini-low` | 115 | 115 | 0 | false | 1 |
| `notes-live-side-topic-main-topic-balance` | `current-chat-mini-low` | 83 | 83 | 0 | false | 1 |
| `notes-live-side-topic-main-topic-balance` | `candidate-responses-mini-low` | 83 | 83 | 0 | false | 1 |
| `notes-live-long-meeting-rolling-context` | `current-chat-mini-low` | 404 | 404 | 0 | false | 3 |
| `notes-live-long-meeting-rolling-context` | `candidate-responses-mini-low` | 404 | 404 | 0 | false | 3 |
| `notes-live-lecture-topic-shift` | `current-chat-mini-low` | 197 | 197 | 0 | false | 2 |
| `notes-live-lecture-topic-shift` | `candidate-responses-mini-low` | 197 | 197 | 0 | false | 2 |
| `notes-live-repeated-correction` | `current-chat-mini-low` | 87 | 87 | 0 | false | 1 |
| `notes-live-repeated-correction` | `candidate-responses-mini-low` | 87 | 87 | 0 | false | 1 |
| `notes-live-tangent-with-action` | `current-chat-mini-low` | 112 | 112 | 0 | false | 2 |
| `notes-live-tangent-with-action` | `candidate-responses-mini-low` | 112 | 112 | 0 | false | 2 |

### Decision

The current runtime state already defaults Notes live to Responses with Chat
fallback. This T-094b run supports keeping that default: Responses passed more
Notes live cases than Chat and the bounded-context metadata is now visible in
paid eval summaries. Continue watching safe production diagnostics for fallback
rate, incomplete responses, long-tail latency, and topic-shift misses.

## Decision

Keep production Chat live paths at the T-083/T-090 decision point. T-115 later switched Notes live to Responses by default with Chat rollback.

The calibrated run strengthens the case for continuing to evaluate Responses, especially for Notes live, but it does not complete a production migration ticket:

- Forms live Responses matched Chat but used more tokens.
- Notes live Responses outscored Chat across repeated runs, but still had higher average token/reasoning use and occasional semantic misses.
- Strict schema improves output shape guarantees, not all semantic quality.
- Existing backend safety filters remain required for Notes live patches.

## Production Change Status

T-083/T-090 itself made no default production live routing change.

T-115 later made Notes live Responses the default provider based on repeated Notes-live eval evidence. Forms live remains Chat because Responses matched quality but used more tokens and did not show a reliability advantage. WebSocket contracts, HTTP route contracts, runtime dependencies, and message shapes remain unchanged.

## Follow-Ups

- Use `FORMIFY_NOTES_LIVE_PROVIDER=chat` as the immediate rollback if Notes live Responses regresses in production.
- Add more long/noisy Notes live fixtures before changing Forms live routing.
- Continue watching safe Notes live provider/fallback diagnostics during the default Responses rollout.
- Keep Forms live on Chat unless Responses shows a clear reliability win that justifies higher token use.
