# GPT Eval Reports

This directory indexes backend GPT evaluation evidence. The detailed fixture-adjacent reports currently live under `test/fixtures/gpt-evals/` so tests, fixtures, and reports stay together.

## Current Runtime Truth

Use these durable files for current production architecture:

- `DECISIONS.md`
- `AI_AGENT_CONTEXT.md`
- `TASKS.md`

As of the stable runtime architecture:

- Notes live uses Responses strict schema with no internal Chat fallback.
- Forms live remains on Chat Completions.
- Production provider/model/reasoning defaults are static in `GPT_FLOW_CONFIG`.
- Experiment-era production env flags for Notes live provider selection and Reorganise reasoning overrides have been removed.

## Historical Reports

Reports under `test/fixtures/gpt-evals/` may describe candidate providers, rollback planning, Responses-first experiments, reasoning/model comparisons, or eval-only schemas from earlier stages. Treat those as historical evidence unless the report explicitly states it is current runtime documentation.

Do not commit raw model outputs. Paid or opt-in eval raw outputs should stay in local temporary paths such as `/tmp/formify-gpt-eval-outputs*`.
