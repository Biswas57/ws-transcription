# T-083 / T-090 Live Responses Strict-Schema Evaluation

## Executive Summary

Status: live-only opt-in eval completed on 2026-06-10.

This ticket evaluates current live Chat Completions JSON-mode paths against Responses API strict Structured Outputs candidates for:

- Forms live extraction
- Notes live patch generation

Result: keep production Chat live paths for now.

The Notes live Responses candidate matched the current Chat baseline on the two small fixtures and had one faster and one slightly slower run. The Forms live Responses candidate failed both fixtures while the Chat baseline passed both. Responses strict schemas remain promising for shape reliability, but this run does not justify migrating production live routing.

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

## Candidate Responses Design

### Forms live candidate

- API: Responses
- Model: `gpt-5.4-mini`
- Reasoning: `low`
- Storage: `store: false`
- Structured output: strict `text.format` JSON Schema
- Schema name: `forms_live_attributes_response`
- Shape:
  - top-level object with `parsedAttributes`
  - `parsedAttributes` is an object with finite field keys from the fixture/template
  - `additionalProperties: false`
  - every known field key is required by the schema and may be an empty string
- Eval conversion:
  - empty strings are converted back to the current sparse live semantics before scoring
  - hidden or unknown keys are not allowed by schema

### Notes live candidate

- API: Responses
- Model: `gpt-5.4-mini`
- Reasoning: `low`
- Storage: `store: false`
- Structured output: strict `text.format` JSON Schema
- Schema name: `notes_live_patch_response`
- Shape:
  - `updates`: array of `{ targetHeading, targetLevel, appendMarkdown }`
  - `fallbackAppendMarkdown`: string
  - `additionalProperties: false`
- Eval conversion:
  - output is parsed into the current `NotesLivePatch` shape
  - patch is applied with the existing `applyNotesLivePatch` safety filters
  - eval checks whether useful content survives the safety filter and avoids forbidden concepts

## Eval Execution

- Date: 2026-06-10
- Matrix: live-only
- Provider cases: 8
- Command:

```bash
NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem OPENAI_EVALS=1 OPENAI_EVAL_FLOWS=forms-live,notes-live OPENAI_EVALS_WRITE_OUTPUTS=1 OPENAI_EVALS_OUTPUT_DIR=/tmp/formify-gpt-eval-outputs pnpm exec vitest run test/gpt-openai-evals.test.ts
```

- Raw output path: `/tmp/formify-gpt-eval-outputs`
- Raw outputs committed: no
- Test result: passed, 13 tests

## Results Table

| Flow | Fixture | Variant | API | Pass | Duration | Total tokens | Reasoning tokens | Output chars | Main notes |
| ---- | ------- | ------- | --- | ---: | -------: | -----------: | ---------------: | -----------: | ---------- |
| forms-live-extraction | forms-live-basic-short | current-chat-mini-low | Chat | yes | 1724ms | 637 | 12 | 88 | - |
| forms-live-extraction | forms-live-basic-short | candidate-responses-mini-low | Responses | no | 5879ms | 708 | 16 | 114 | missing=1 |
| forms-live-extraction | forms-live-correction-fragment | current-chat-mini-low | Chat | yes | 1484ms | 712 | 82 | 100 | - |
| forms-live-extraction | forms-live-correction-fragment | candidate-responses-mini-low | Responses | no | 1882ms | 824 | 119 | 178 | forbidden=1 |
| notes-live-patch | early-patch-basic | current-chat-mini-low | Chat | yes | 2239ms | 1287 | 16 | 203 | - |
| notes-live-patch | early-patch-basic | candidate-responses-mini-low | Responses | yes | 1229ms | 1361 | 11 | 216 | - |
| notes-live-patch | side-topic-repetition | current-chat-mini-low | Chat | yes | 1219ms | 1304 | 12 | 151 | - |
| notes-live-patch | side-topic-repetition | candidate-responses-mini-low | Responses | yes | 1335ms | 1389 | 26 | 151 | - |

## Forms Live Findings

The Chat baseline passed both Forms live fixtures. The Responses strict-schema candidate failed both.

Findings:

- Chat preserved the expected short value and sparse attributes in the basic fixture.
- Responses produced valid schema-shaped JSON, but missed the exact expected fee normalisation in the basic fixture.
- Chat handled the correction fragment and explicit non-applicability case.
- Responses handled the correction and explicit non-applicability fields, but also populated a forbidden allowed field with transcript-like supporting text.
- Responses prevented hidden/unknown keys through schema shape, but strict schema did not prevent semantically wrong allowed-field population.
- Responses was slower and used more total tokens on both Forms live fixtures in this run.

Decision for Forms live: do not migrate. Keep Chat live extraction and add more live fixtures before reconsidering.

## Notes Live Findings

Both Chat and Responses passed both Notes live fixtures.

Findings:

- Both variants produced useful early structure for an empty notes session.
- Both variants kept repeated/side-topic content out of the support-triage update.
- No live patch output failed parsing.
- No patch was rejected by the existing safety filter.
- Responses was faster on `early-patch-basic` and slightly slower on `side-topic-repetition`.
- Responses used slightly more total tokens overall in these two fixtures.
- Strict schema may reduce malformed patch risk, but this tiny fixture set does not prove a production migration is safe.

Decision for Notes live: Responses is promising, but needs more fixtures and repeated runs before migration.

## Decision

Keep production Chat live paths for now.

Responses strict-schema candidates remain useful evaluation targets, especially for Notes live patching, but the current evidence is not strong enough to migrate production live routing:

- Forms live Responses quality regressed on both fixtures.
- Notes live Responses matched quality on two fixtures, but the sample is too small.
- Strict schema improves output shape guarantees, not semantic correctness.
- Existing Notes patch safety filters remain required.

## Production Change Status

No production live routing changed.

No production prompts, model names, reasoning effort, schemas used by current production paths, provider defaults, WebSocket contracts, HTTP route contracts, runtime dependencies, or product behaviour changed.

## Follow-Ups

- Add more Forms live fixtures before reconsidering Responses for Forms live extraction.
- Add more Notes live fixtures covering longer current notes, heading reuse, fallback section creation, duplicate suppression, and rejected unsafe patches.
- Re-run live-only evals multiple times before using latency or pass-rate differences for production decisions.
