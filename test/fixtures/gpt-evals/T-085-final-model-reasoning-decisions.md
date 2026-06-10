# T-085 Final Model / Reasoning Decisions Before T-083

## Executive Summary

T-085d/T-085e expanded the offline fixture coverage and ran the opt-in OpenAI evaluation matrix for the non-live final/transform flows before starting T-083 live Responses work.

Low reasoning was faster and usually used fewer tokens, but the T-085e decision gate was not strong enough to promote it broadly for production final/transform calls. The conservative defaults after that pass were:

- Forms final: `gpt-5.4`, medium reasoning
- Notes final: `gpt-5.4`, medium reasoning
- Summarise: `gpt-5.4`, medium reasoning
- Reorganise: `gpt-5.4`, medium reasoning at the decision gate; T-116 later changed Reorganise to low with `FORMIFY_REORGANISE_REASONING=medium` rollback.

No production model names, reasoning settings, prompts, schemas, provider routing, WebSocket contracts, or HTTP contracts were changed by this decision pass.

## Expanded Fixture Coverage

T-085d added more coverage before the final decision gate:

- Forms final now includes four fixtures:
  - `medical-intake-basic`
  - `correction-overwrite`
  - `unknown-empty-contract`
  - `value-normalisation-and-correction`
- Summarise now includes three fixtures:
  - `summarise-rca-process`
  - `summarise-long-meeting-actions`
  - `summarise-study-repeated-detail`

The added Forms fixtures cover unknown/empty output, explicit `N/A`, short-value preservation, value normalisation, and transcript corrections. The added Summarise fixtures focus on compression, open-question preservation, action/approval preservation, and repeated-detail reduction.

## Eval Execution

- Date: 2026-06-10
- Runner: `test/gpt-openai-evals.test.ts`
- Opt-in flags: `OPENAI_EVALS=1`, `OPENAI_EVALS_WRITE_OUTPUTS=1`
- CA setup: `NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem`
- Raw outputs: written only to `/tmp/formify-gpt-eval-outputs` and not committed
- Selected provider cases: 20

The expanded provider run completed all 20 model calls and printed safe summary metadata. The test then failed on a stale assertion that still expected 12 results; the assertion has been updated to expect the selected matrix length.

## Results Summary

| Flow | Medium pass rate | Low pass rate | Latency change with low | Token change with low | Decision |
| ---- | ---------------- | ------------- | ----------------------- | --------------------- | -------- |
| Forms final | 3/4 | 2/4 | ~27% faster | ~11% fewer total tokens | Keep medium |
| Notes final | 2/2 | 1/2 | ~45% faster | ~8% fewer total tokens | Keep medium |
| Summarise | 0/3 | 0/3 | ~18% faster | ~2% fewer total tokens | Keep medium; fix compression separately |
| Reorganise | 0/1 | 1/1 | ~25% faster | ~6% fewer total tokens | Keep medium until more fixtures exist |

## Detailed Results

| Flow | Fixture | Variant | Pass | Duration | Total tokens | Reasoning tokens | Output chars | Main notes |
| ---- | ------- | ------- | ---: | -------: | -----------: | ---------------: | -----------: | ---------- |
| forms-final | medical-intake-basic | current-final-medium | yes | 4537ms | 904 | 143 | 131 | - |
| forms-final | medical-intake-basic | candidate-final-low | no | 3381ms | 834 | 73 | 138 | missing=1 |
| forms-final | correction-overwrite | current-final-medium | yes | 5571ms | 1063 | 279 | 166 | - |
| forms-final | correction-overwrite | candidate-final-low | yes | 2476ms | 844 | 60 | 166 | - |
| forms-final | unknown-empty-contract | current-final-medium | no | 4140ms | 997 | 187 | 209 | missing=1 |
| forms-final | unknown-empty-contract | candidate-final-low | no | 4371ms | 904 | 92 | 216 | missing=1 |
| forms-final | value-normalisation-and-correction | current-final-medium | yes | 2851ms | 896 | 100 | 134 | - |
| forms-final | value-normalisation-and-correction | candidate-final-low | yes | 2330ms | 849 | 53 | 134 | - |
| notes-final | rca-process-final | current-final-medium | yes | 5658ms | 1579 | 109 | 724 | - |
| notes-final | rca-process-final | candidate-final-low | no | 3007ms | 1472 | 9 | 709 | missing=3 |
| notes-final | short-study-final | current-final-medium | yes | 4076ms | 1462 | 175 | 308 | - |
| notes-final | short-study-final | candidate-final-low | yes | 2325ms | 1326 | 31 | 358 | - |
| summarise | summarise-rca-process | current-final-medium | no | 5309ms | 1330 | 26 | 1157 | missing=1; ratio=0.90; compression-ratio-above-target |
| summarise | summarise-rca-process | candidate-final-low | no | 4040ms | 1323 | 10 | 1196 | missing=1; ratio=0.94; compression-ratio-above-target |
| summarise | summarise-long-meeting-actions | current-final-medium | no | 4856ms | 1438 | 51 | 1119 | missing=5; ratio=0.74 |
| summarise | summarise-long-meeting-actions | candidate-final-low | no | 3996ms | 1382 | 14 | 1093 | missing=3; ratio=0.72 |
| summarise | summarise-study-repeated-detail | current-final-medium | no | 3696ms | 1319 | 30 | 819 | missing=6; ratio=0.65 |
| summarise | summarise-study-repeated-detail | candidate-final-low | no | 3307ms | 1301 | 10 | 851 | missing=5; ratio=0.68 |
| reorganise | reorganise-rca-process | current-final-medium | no | 5576ms | 1278 | 97 | 1341 | ratio=1.04 |
| reorganise | reorganise-rca-process | candidate-final-low | yes | 4188ms | 1206 | 24 | 1330 | ratio=1.03 |

## Forms Final Decision

Keep medium reasoning.

Medium passed more fixtures than low (`3/4` vs `2/4`). Low was faster and cheaper, but it failed the basic medical intake fixture and did not resolve the unknown/empty contract fixture. The remaining medium miss should be investigated as a Forms prompt/schema/eval issue, not used as evidence to lower reasoning.

## Notes Final Decision

Keep medium reasoning.

Medium passed both Notes final fixtures. Low passed the short study fixture but missed RCA/process details. Notes final is a user-visible editorial replacement, so medium remains the safer default until low passes a broader long-notes fixture set.

## Summarise Decision

Keep medium reasoning and treat Summarise quality/compression as a separate prompt/eval problem.

Both medium and low failed all Summarise fixtures. Low was faster, but it did not solve compression or concept preservation. The RCA summary remained above the target compression ratio for both variants, and the newer compression-focused fixtures still reported missing concepts. Do not change reasoning based on this data.

T-110 applied the evidence-supported follow-up: the production Summarise prompt now makes the transform a condensed summary rather than a light Reorganise pass. Model, reasoning, route shape, response key, schema, and validation remain unchanged.

## T-110a Summarise Prompt Verification

T-110a ran the Summarise-only opt-in eval against the tightened prompt.

- Date: 2026-06-10
- Command:

```bash
NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem OPENAI_EVALS=1 OPENAI_EVAL_FLOWS=summarise OPENAI_EVALS_WRITE_OUTPUTS=1 OPENAI_EVALS_OUTPUT_DIR=/tmp/formify-gpt-eval-outputs-t110a pnpm exec vitest run test/gpt-openai-evals.test.ts
```

- Raw output path: `/tmp/formify-gpt-eval-outputs-t110a`
- Raw outputs committed: no
- Provider cases: 6
- Test result: passed, 18 tests

| Fixture | Variant | Pass | Duration | Total tokens | Reasoning tokens | Output chars | Ratio | Main notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `summarise-rca-process` | current medium | no | 6915ms | 1452 | 72 | 1111 | 0.87 | missing=4; compression-ratio-above-target |
| `summarise-rca-process` | candidate low | no | 4043ms | 1391 | 8 | 1116 | 0.87 | missing=2; compression-ratio-above-target |
| `summarise-long-meeting-actions` | current medium | no | 5182ms | 1512 | 42 | 1117 | 0.74 | missing=5 |
| `summarise-long-meeting-actions` | candidate low | no | 3755ms | 1453 | 9 | 1090 | 0.72 | missing=4 |
| `summarise-study-repeated-detail` | current medium | no | 3482ms | 1407 | 40 | 806 | 0.64 | missing=6 |
| `summarise-study-repeated-detail` | candidate low | no | 2900ms | 1372 | 9 | 792 | 0.63 | missing=6 |

Prompt assessment:

- Compression improved slightly for `summarise-rca-process` medium (`0.90 -> 0.87`) and `summarise-study-repeated-detail` medium (`0.65 -> 0.64`), but the improvement is not enough to declare Summarise fixed.
- `summarise-long-meeting-actions` medium remained unchanged on compression ratio (`0.74`) and still missed the same number of concepts.
- RCA concept preservation regressed on the medium production setting (`missing=1 -> missing=4`), so the stronger prompt may be pushing too hard away from preservation on that fixture.
- Low reasoning was faster and lower-token again, but it is still not a production default candidate because it did not pass the fixtures or solve preservation reliably.

Decision: keep `gpt-5.4` + medium for Summarise, keep T-110 prompt in place for now, and do not claim the compression issue is fixed. The next Summarise work should inspect the local raw outputs, calibrate phrase-strict missing concepts where justified, and then make a smaller prompt/eval follow-up focused on preserving obligations/actions/constraints while compressing repeated structure.

## T-110b Summarise Concept Preservation Calibration

T-110b inspected the local T-110a raw outputs and calibrated phrase-strict concept checks where the summaries preserved the required meaning in different wording.

- Date: 2026-06-10
- Raw output path inspected: `/tmp/formify-gpt-eval-outputs-t110a`
- Raw outputs committed: no
- Opt-in eval rerun: no; this pass reused the existing T-110a outputs and changed only offline fixture expectations.
- Prompt changes: none
- Model/reasoning changes: none

Missing-concept classification for the production medium candidate:

| Fixture | T-110a missing count | Classification | Notes |
| --- | ---: | --- | --- |
| `summarise-rca-process` | 4 | present-different-wording | Output preserved Nutanix-only support scope, legal review before release, APAC communications, and security/federal handling using equivalent wording. |
| `summarise-long-meeting-actions` | 5 | present-different-wording | Output preserved the conditional Friday launch, Monday fallback, owners, payment retry risk, legal review owner, and open questions using owner labels and compressed wording. |
| `summarise-study-repeated-detail` | 6 | present-different-wording | Output preserved the respiration definition, glucose/oxygen conversion, glycolysis location/no-oxygen rule, Krebs location, oxygen acceptor role, and ATP point using formula notation and heading context. |

Fixture/checker changes:

- Added narrow alternatives for equivalent Summarise wording such as `Legal must review the final RCA`, `launch moves to Monday`, `Owner Priya`, `Owner Marco`, `Owner Mei`, `glucose oxygen carbon dioxide water ATP`, and `produces most ATP`.
- Did not remove required obligations, owner/action checks, constraints, open questions, or forbidden concepts.
- Did not relax the RCA compression target, because `summarise-rca-process` still remains above its target ratio.

Calibrated result against the existing T-110a outputs:

| Fixture | Variant | Missing after calibration | Ratio | Remaining issue |
| --- | --- | ---: | ---: | --- |
| `summarise-rca-process` | current medium | 0 | 0.87 | compression-ratio-above-target |
| `summarise-rca-process` | candidate low | 0 | 0.87 | compression-ratio-above-target |
| `summarise-long-meeting-actions` | current medium | 0 | 0.74 | none from deterministic checks |
| `summarise-long-meeting-actions` | candidate low | 0 | 0.72 | none from deterministic checks |
| `summarise-study-repeated-detail` | current medium | 0 | 0.64 | none from deterministic checks |
| `summarise-study-repeated-detail` | candidate low | 0 | 0.63 | none from deterministic checks |

Decision: keep `gpt-5.4` + medium for Summarise. T-110/T-110b show the concept-preservation failure was mostly phrase-strict fixture matching, not clear content loss. However, do not claim Summarise is solved yet because the RCA fixture is still not compressed enough. Further prompt work should target compression without weakening the priority facts now recognised by the calibrated checks.

## T-011a Current Notes Preservation Checker Calibration

T-011a inspected paid Notes-final eval raw outputs written locally under `/tmp/formify-gpt-eval-outputs`.

- Raw outputs committed: no
- Production prompt changes: none
- Model/reasoning changes: none
- Runtime/provider changes: none

The inspected outputs showed the current-notes preservation behaviour was qualitatively better than the deterministic pass/fail table suggested. Most failures were phrase-strict fixture matching rather than obvious content loss:

- `notes-final-preserve-current-only-detail` preserved the Priya review-prep action with equivalent wording.
- `notes-final-correction-overrides-current` correctly moved launch to Monday and preserved the legal-review reason while removing stale Friday timing.
- `notes-final-deduplicate-current-and-transcript` preserved the Mei QA sign-off action and release blocker without duplicating the idea.
- `notes-final-drop-live-artefact` removed broken live artefacts and preserved the Sam ownership detail in a concise final note.

Fixture/checker changes:

- Added narrow alternatives for equivalent T-011 wording such as `Priya owns preparation for the review meeting`, `launch has moved to Monday`, `legal review requires one more pass`, `Mei to complete QA sign-off before release`, `QA sign-off remains the release blocker`, and `Owner: Sam`.
- Kept stale Friday launch, broken live artefact, filler, and duplicate-content checks strict.
- Added a fixture-level concise-output allowance only for the tiny live-artefact cleanup case, where a short output is expected after removing invalid draft material.

Decision: treat the T-011 paid eval as a qualitative pass after calibration. Continue using these fixtures as regression coverage for canonical-current-notes preservation, but do not use the old phrase-strict failures as evidence for another prompt or reasoning change.

## T-114 Summarise Process-Heavy Fixture

T-114 added `summarise-process-heavy-incident-review`, a synthetic process/RCA-style fixture focused on repeated procedure examples, support ownership, legal approval, communications ownership, security/compliance handling, and open questions.

- Prompt change: added one process-specific compression rule for dense process or incident-review notes.
- Model/reasoning changes: none
- Opt-in eval rerun: no
- Purpose: make future Summarise evals measure whether the prompt can compress repeated procedural detail while preserving governing rules, exceptions, owner/action facts, constraints, risks, and open questions.

## Reorganise Decision

T-085e originally kept medium reasoning.

Low passed the single Reorganise fixture and was faster, but one fixture is not enough evidence to change production defaults. Add more preservation fixtures before revisiting this.

T-111 applied a controlled override instead of a default change. T-116 later made Reorganise low reasoning the default because the transform is user-reviewed and lower-risk than final notes. `FORMIFY_REORGANISE_REASONING=medium` is the immediate rollback path.

## Recommendation Before T-083

Proceed to T-083/T-090 live-path evaluation without changing production final/transform reasoning. The final/transform data shows low reasoning is promising for cost and latency, but not yet safe enough as a production default.

T-083 should stay scoped to live-path evaluation:

- Forms live extraction: current Chat Completions JSON mode vs Responses strict schema
- Notes live patching: current Chat Completions JSON mode vs Responses strict schema
- Metrics: latency, malformed output, schema validity, useful patch rate, rejected patch rate, Forms precision/recall, token usage, reasoning tokens, cached tokens, and cost

## Production Change Status

No production defaults were changed by T-085d/T-085e. T-110/T-111 later tightened the Summarise prompt and added an explicit Reorganise low-reasoning override. T-116 later made Reorganise low reasoning the default while keeping Forms final, Notes final, and Summarise on medium.

## T-117 Summarise Process/RCA Compression

T-117 kept Summarise on `gpt-5.4` + medium reasoning and tightened only the prompt guidance for dense process, RCA, incident-review, support, and training notes.

- Keep governing rules, exceptions, owner/action facts, constraints, risks, deadlines, and open questions.
- Remove repeated step-by-step explanation and repeated examples.
- Merge many similar procedural bullets by preserving the rule once and summarising the rest.
