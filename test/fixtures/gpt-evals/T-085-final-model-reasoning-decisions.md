# T-085 Final Model / Reasoning Decisions Before T-083

## Executive Summary

T-085d/T-085e expanded the offline fixture coverage and ran the opt-in OpenAI evaluation matrix for the non-live final/transform flows before starting T-083 live Responses work.

Low reasoning was faster and usually used fewer tokens, but the quality evidence is not strong enough to promote it for production final/transform calls. Keep current production defaults for now:

- Forms final: `gpt-5.4`, medium reasoning
- Notes final: `gpt-5.4`, medium reasoning
- Summarise: `gpt-5.4`, medium reasoning
- Reorganise: `gpt-5.4`, medium reasoning

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

## Reorganise Decision

Keep medium reasoning for now.

Low passed the single Reorganise fixture and was faster, but one fixture is not enough evidence to change production defaults. Add more preservation fixtures before revisiting this.

## Recommendation Before T-083

Proceed to T-083/T-090 live-path evaluation without changing production final/transform reasoning. The final/transform data shows low reasoning is promising for cost and latency, but not yet safe enough as a production default.

T-083 should stay scoped to live-path evaluation:

- Forms live extraction: current Chat Completions JSON mode vs Responses strict schema
- Notes live patching: current Chat Completions JSON mode vs Responses strict schema
- Metrics: latency, malformed output, schema validity, useful patch rate, rejected patch rate, Forms precision/recall, token usage, reasoning tokens, cached tokens, and cost

## Production Change Status

No production defaults were changed by T-085d/T-085e.
