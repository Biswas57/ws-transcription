# T-085b Reasoning / Model Evaluation Results

> Historical note: this report records opt-in model/reasoning eval results and candidate comparisons. Current runtime architecture is documented in `DECISIONS.md` and `AI_AGENT_CONTEXT.md`; production defaults should be read from `GPT_FLOW_CONFIG`, not inferred from this report alone.

## Executive Summary

Status: completed after providing Node with the local macOS certificate bundle.

T-085b adds the report target for the opt-in OpenAI evaluation path created in T-085a. The first run failed because Node rejected the local certificate chain with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. The evals then completed after exporting local macOS keychain certificates to `/tmp/macos-certs.pem` and passing that bundle through `NODE_EXTRA_CA_CERTS`.

No candidate should be promoted from this report alone. Low reasoning improved latency and token usage across all measured rows, but deterministic fixture checks still failed on several flows. Production model names, reasoning effort, prompts, schemas, provider routing, WebSocket contracts, and HTTP contracts remain unchanged.

## Eval Configuration

- Date: 2026-06-10
- OpenAI eval execution: completed
- Required opt-in command: `OPENAI_EVALS=1 pnpm exec vitest run test/gpt-openai-evals.test.ts`
- Attempted command: `OPENAI_EVALS=1 pnpm exec vitest run test/gpt-openai-evals.test.ts`
- Initial blocker: Node fetch/OpenAI SDK connection error caused by `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
- Working setup:
  - `security find-certificate -a -p /Library/Keychains/System.keychain > /tmp/macos-certs.pem`
  - `security find-certificate -a -p ~/Library/Keychains/login.keychain-db >> /tmp/macos-certs.pem`
  - `NODE_EXTRA_CA_CERTS=/tmp/macos-certs.pem OPENAI_EVALS=1 pnpm exec vitest run test/gpt-openai-evals.test.ts`
- Raw outputs written: no
- Runtime paths evaluated by runner: Responses API only for non-live final/transform flows
- Live Forms and live Notes: explicitly deferred to T-083/T-090

## Selected Comparisons

| Flow | Fixture | Variant | Model | Reasoning | Status |
| ---- | ------- | ------- | ----- | --------- | ------ |
| forms-final | medical-intake-basic | current-final-medium | gpt-5.4 | medium | run |
| forms-final | medical-intake-basic | candidate-final-low | gpt-5.4 | low | run |
| forms-final | correction-overwrite | current-final-medium | gpt-5.4 | medium | run |
| forms-final | correction-overwrite | candidate-final-low | gpt-5.4 | low | run |
| notes-final | rca-process-final | current-final-medium | gpt-5.4 | medium | run |
| notes-final | rca-process-final | candidate-final-low | gpt-5.4 | low | run |
| notes-final | short-study-final | current-final-medium | gpt-5.4 | medium | run |
| notes-final | short-study-final | candidate-final-low | gpt-5.4 | low | run |
| summarise | summarise-rca-process | current-final-medium | gpt-5.4 | medium | run |
| summarise | summarise-rca-process | candidate-final-low | gpt-5.4 | low | run |
| reorganise | reorganise-rca-process | current-final-medium | gpt-5.4 | medium | run |
| reorganise | reorganise-rca-process | candidate-final-low | gpt-5.4 | low | run |

## Results Table

| Flow | Fixture | Variant | Pass | Duration | Total tokens | Reasoning tokens | Output chars | Main notes |
| ---- | ------- | ------- | ---: | -------: | -----------: | ---------------: | -----------: | ---------- |
| forms-final | medical-intake-basic | current-final-medium | no | 5664ms | 944 | 183 | 138 | missing=1 |
| forms-final | medical-intake-basic | candidate-final-low | no | 4113ms | 845 | 83 | 154 | missing=1 |
| forms-final | correction-overwrite | current-final-medium | yes | 7160ms | 1056 | 272 | 166 | - |
| forms-final | correction-overwrite | candidate-final-low | yes | 4636ms | 828 | 44 | 166 | - |
| notes-final | rca-process-final | current-final-medium | no | 4975ms | 1583 | 101 | 756 | missing=3 |
| notes-final | rca-process-final | candidate-final-low | no | 3421ms | 1471 | 9 | 689 | missing=4 |
| notes-final | short-study-final | current-final-medium | no | 4436ms | 1447 | 159 | 312 | missing=2 |
| notes-final | short-study-final | candidate-final-low | no | 2824ms | 1319 | 33 | 306 | missing=2 |
| summarise | summarise-rca-process | current-final-medium | no | 4928ms | 1422 | 103 | 1233 | missing=8; ratio=0.97; compression-ratio-above-target |
| summarise | summarise-rca-process | candidate-final-low | no | 3615ms | 1318 | 9 | 1175 | missing=7; ratio=0.92; compression-ratio-above-target |
| reorganise | reorganise-rca-process | current-final-medium | no | 6464ms | 1278 | 90 | 1361 | missing=1; ratio=1.06 |
| reorganise | reorganise-rca-process | candidate-final-low | no | 4778ms | 1204 | 21 | 1336 | missing=1; ratio=1.04 |

## Forms Findings

The correction-overwrite fixture passed for both medium and low reasoning. The medical-intake-basic fixture failed one deterministic check for both variants.

Low reasoning was faster on both Forms fixtures and used fewer total/reasoning tokens, but it should not be promoted until the medical-intake miss is inspected against raw local output outside the committed report.

## Notes Final Findings

Both Notes final fixtures failed deterministic concept checks. Low reasoning was faster and cheaper, but it was slightly worse on the RCA fixture (`missing=4` vs `missing=3`) and tied on the study fixture (`missing=2`).

No candidate is recommended yet.

## Summarise Findings

Both Summarise variants failed concept and compression checks. Low reasoning was faster and used fewer tokens, and it had a slightly lower compression ratio (`0.92` vs `0.97`), but both outputs were much too close to source length for the fixture target.

No candidate is recommended yet.

## Reorganise Findings

Both Reorganise variants failed one deterministic concept check. Low reasoning was faster and used fewer tokens, with similar preservation ratio (`1.04` vs `1.06`).

No candidate is recommended yet.

## Cost / Latency Findings

Low reasoning reduced duration and reasoning tokens on every measured row:

- Forms medical intake: `5664ms → 4113ms`, reasoning tokens `183 → 83`, total tokens `944 → 845`
- Forms correction overwrite: `7160ms → 4636ms`, reasoning tokens `272 → 44`, total tokens `1056 → 828`
- Notes final RCA: `4975ms → 3421ms`, reasoning tokens `101 → 9`, total tokens `1583 → 1471`
- Notes final study: `4436ms → 2824ms`, reasoning tokens `159 → 33`, total tokens `1447 → 1319`
- Summarise RCA: `4928ms → 3615ms`, reasoning tokens `103 → 9`, total tokens `1422 → 1318`
- Reorganise RCA: `6464ms → 4778ms`, reasoning tokens `90 → 21`, total tokens `1278 → 1204`

## Eval Check Calibration

T-085c inspected raw local outputs under `/tmp/formify-gpt-eval-outputs`. Raw outputs were not committed.

Calibration findings:

- Forms final failures were real product-contract failures, not phrase-matching brittleness. Outputs used `"unknown"` where unknown fields should be `""`; one low-reasoning output also preserved the fee as words instead of the expected `$500` normalisation.
- Notes final failures were mostly phrase-strict fixture wording. The outputs preserved the concepts using equivalent wording such as reviewed by Legal, formal RCA required, end-of-life handling, and support/escalation wording. Required concepts and expected open-question checks now use explicit fixture-side alternatives.
- Summarise concept failures were mostly phrase-strict, but the compression failure was real. Both medium and low outputs remained about `0.95` of the source length, above the `0.8` fixture target, so Summarise still needs either prompt tuning or stronger eval coverage before any reasoning change.
- Reorganise failures were phrase-strict section/concept checks. The outputs preserved the expected detail under equivalent headings such as Intake and Triage, Scope Boundaries, and Operational Details/Notes. Required concepts and section hints now use explicit alternatives.

Post-calibration classification for the inspected local outputs:

| Flow | Calibrated result | Notes |
| ---- | ----------------- | ----- |
| forms-final | 1/4 passed | Remaining failures are real unknown/formatting issues. |
| notes-final | 4/4 passed | Original failures were phrase-strict concept/open-question checks. |
| summarise | 0/2 passed | Concepts are now recognised, but compression remains insufficient. |
| reorganise | 2/2 passed | Original failures were phrase-strict concept/section checks. |

## Recommendation

Keep all current production settings. Low reasoning is promising on latency/cost, but deterministic quality checks are not yet strong enough to justify promoting it. Next steps should be:

1. Inspect local raw outputs manually without committing them, especially the single Forms miss and the Notes/Summarise missing concepts.
2. Add more Forms fixtures around unknown values, value normalisation, and corrections.
3. Add more Summarise compression fixtures before changing production final/transform reasoning.

After T-085b data exists, the most useful next comparison is still T-083/T-090: live Chat Completions JSON mode versus Responses strict-schema variants for Forms live extraction and Notes live patching.

## Production Change Status

No production defaults were changed by T-085b.
