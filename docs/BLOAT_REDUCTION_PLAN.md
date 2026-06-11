# Backend Bloat Reduction Plan

T-128 is a docs/task planning ticket only. It audits remaining backend clutter after the runtime hardening work and turns that audit into scoped follow-up tickets. It does not change runtime source, tests, package files, lockfiles, fixtures, scripts, GPT routing, prompts, models, contracts, VAD, batching, caps, transcription, finalisation, or transform behaviour.

## Current Runtime Invariants

Preserve these while doing any cleanup:

- `GPT_FLOW_CONFIG` is the stable runtime source of truth for GPT API, model, and reasoning defaults.
- Notes live uses Responses strict schema only. There is no production Chat fallback for Notes live.
- Forms live remains on Chat Completions.
- Revision, Forms final, Notes final, Summarise, Reorganise, and Notes live use Responses where configured.
- OpenAI request storage is explicitly disabled with `store: false` where the SDK supports it.
- Canonical notes state is app-owned. Live context compaction is only a model-input optimisation; the full canonical markdown is still used for patch application and finalisation.
- Runtime logs should contain safe metadata only: counts, lengths, timings, booleans, safe codes, hashed identifiers where needed, and token/usage metadata. They must not log raw audio, transcript, notes, form values, prompts, secrets, auth headers, or raw user identifiers.
- Notes live failures must preserve current notes rather than mutating canonical markdown with invalid output.
- Existing WebSocket and HTTP contracts remain stable unless a future ticket explicitly coordinates a contract change.

## Inspection Summary

Audit commands run for this plan:

```bash
git status --short
git ls-files | sort
find . -type f -not -path "./node_modules/*" -not -path "./.git/*" -size +100k -print
find . -path './node_modules' -prune -o -path './.git' -prune -o -type f -exec du -h {} + | sort -h | tail -60
rg -n "FORMIFY_NOTES_LIVE_PROVIDER|FORMIFY_REORGANISE_REASONING|fallbackApi|notes_live_fallback|chat fallback|candidate|experiment|override|rollback|legacy|deprecated|temporary|TODO|FIXME|HACK" . --glob '!node_modules' --glob '!dist'
rg -n "gpt-5\.4|gpt-5\.4-mini|reasoning|responses|chat|GPT_FLOW_CONFIG|store: false|store:false" . --glob '!node_modules' --glob '!dist'
rg -n "JSON\.parse|parseJson|extractJson|schema|strict|fallback|fallbackAppendMarkdown|updates|summaryMarkdown|reorganisedMarkdown|notesMarkdown" gpt parse-gpt.ts test --glob '!node_modules' --glob '!dist'
rg -n "safeProviderMessage|provider_error|schema_invalid|empty_output|incomplete|max_output_tokens|diagnostic|usage|logger|console\." . --glob '!node_modules' --glob '!dist'
rg -n "package-lock|pnpm-lock|sample\.webm|test/test\.ts|test2|live-client|load-test|tsx|ts-node|cacheHit|cacheHitRate" . --glob '!node_modules' --glob '!dist'
rg -n "groq|GROQ|parse-groq|quick-lru|murmurhash|form-data|stripe|billing|upgrade|pro|premium|pricing|paywall|free tier|fallback provider|Chat fallback|Responses-first" . --glob '!node_modules' --glob '!dist'
rg -n "^import .*from" gpt parse-gpt.ts
```

Key findings:

- T-129 consolidated duplicate sample audio into `test/fixtures/sample.webm`.
- T-129 moved source-run manual WebSocket clients into `tools/manual/` and updated package scripts.
- Historical eval reports still mention candidate providers, rollback flags, Chat-vs-Responses comparisons, and earlier reasoning/model experiments. These are useful evidence, but they should be easier to distinguish from current runtime architecture.
- JSON extraction, strict-output validation, and fallback handling are repeated across several GPT feature modules. This is expected after hardening, but it is now a cleanup candidate.
- Provider diagnostics are content-safe in intent, but the free-form provider message surface should be narrowed further.
- `parse-gpt.ts` is still actively imported by handlers, routes, and tests. It is a compatibility facade, not dead code.
- No active Groq, cache, pricing, paywall, Stripe, or legacy dependency path was found in runtime source.

## Low-Risk Cleanup Candidates

| Candidate | Evidence | Recommended action | Ticket |
| --- | --- | --- | --- |
| Duplicate sample audio | Resolved by T-129. The canonical fixture is now `test/fixtures/sample.webm`. | Keep the single shared fixture unless a future load/manual scenario needs a distinct audio file. | Completed |
| Manual clients under automated test paths | Resolved by T-129. Manual clients now live under `tools/manual/`. | Keep source-run smoke clients separate from Vitest tests. | Completed |
| Local empty or untracked cleanup areas | `unused/` exists locally but is not tracked. | Do not add docs around it unless it becomes tracked; local deletion is optional and outside this ticket. | T-129 if tracked later |
| Historical wording in current docs/task text | Search results show old candidate/rollback wording in completed tickets and eval reports. | Add superseded/current-runtime notes instead of deleting useful history. | T-132 |
| Generated `dist/` visibility in local audits | `dist/` appears in local size searches but is ignored/generated. | Keep ignored. Do not track or clean as a source-ticket unless deployment packaging changes. | None |

## Medium-Risk Cleanup Candidates

| Candidate | Evidence | Risk | Recommended action | Ticket |
| --- | --- | --- | --- | --- |
| Provider diagnostics hardening | `gpt/provider.ts` logs sanitized provider metadata, including a shortened provider message. | Over-tightening can make Render/OpenAI failures harder to debug; under-tightening can leak user/provider text. | Standardise safe provider diagnostics around status, code, type, param, request id, finish/incomplete reason, token usage, and safe error categories. Avoid raw provider text by default. | T-130 |
| Parser and fallback helper unification | `gpt/forms.ts`, `gpt/notes-live.ts`, `gpt/notes-final.ts`, and `gpt/notes-transform.ts` each carry strict JSON parsing and fallback rules. | Shared helpers could accidentally change mode-specific safety behaviour. | Extract only the mechanical pieces first: JSON object extraction, required-string validation, safe parse metadata, and schema-key checks. Keep each flow's fallback policy local. | T-131 |
| Eval runner/report organisation | `test/gpt-openai-eval-runner.ts`, `test/gpt-openai-evals.test.ts`, and `test/fixtures/gpt-evals/*` carry valuable but broad evaluation material. | Cleanup could remove evidence or make opt-in evals harder to run. | Keep fixtures and runner; archive or annotate superseded reports and make current-vs-historical status obvious. | T-132 |
| Manual tooling structure | Package scripts call manual clients and load scripts directly. | Moving files can break local smoke/load commands. | Move in a small path-only commit with script updates and a focused manual command check. | T-129 |

## Higher-Risk Candidates

| Candidate | Evidence | Why risky | Recommended action | Ticket |
| --- | --- | --- | --- | --- |
| `parse-gpt.ts` compatibility facade review | Handlers, routes, and tests still import from `parse-gpt.ts`; GPT feature code now lives under `gpt/*`. | Removing or bypassing the facade touches broad imports and can create churn without product value. | Review import direction and value first. Keep the facade unless a dedicated ticket proves migration helps maintainability. | T-133 |
| Broader GPT module boundary review | GPT modules have reasonable lower-level imports today, but feature modules and eval helpers expose extra functions for tests/evals. | Aggressive boundary cleanup can disturb prompt/schema/fallback invariants. | Review module boundaries and export surface before moving runtime code. Do not combine with parser cleanup. | T-133 |
| `NotesHandler` lifecycle extraction | `handlers/NotesHandler.ts` remains one of the larger runtime files. | Notes lifecycle covers audio intake, VAD, queues, stop flush, finalisation, reconnect cap, and stale-send safety. Refactoring here is high-risk. | Defer. Do not include in bloat cleanup unless a future reliability ticket needs it. | Deferred |

## Do Not Remove

- Forms live Chat Completions. It is intentional runtime behaviour.
- Notes live `fallbackAppendMarkdown`. It is required for safe provisional live structure.
- GPT eval fixtures, reports, and opt-in eval runner. They are current quality-safety infrastructure, even if some historical reports need clearer labels.
- VAD, ffmpeg decode, token counting, load tests, and manual clients. They may be test/manual-only, but they support backend reliability work.
- `parse-gpt.ts` until T-133 proves a migration is worth the churn.
- Existing final fallback policies:
  - Notes final falls back to current canonical notes on final failure.
  - Forms final falls back to candidate attributes where safe.
  - Notes live invalid patches fail without mutating canonical notes.
- Historical notes warning that the backend does not send `corrected_audio`.

## Recommended Ticket Order

1. T-130 Provider diagnostics hardening
2. T-132 Eval/docs archive cleanup
3. T-131 Parser and fallback helper unification
4. T-133 GPT module boundary review

T-129 has already removed the first low-risk repo-structure clutter. The remaining order hardens privacy-facing diagnostics before deeper code cleanup, clarifies historical eval docs, then tackles shared parser helpers and broader module boundaries only after the repo is easier to navigate.

## Follow-Up Ticket Scopes

### T-129 Backend repo structure cleanup

Status: completed after this plan. The repo now has one shared sample fixture and manual clients are separated from automated test files.

### T-130 Provider diagnostics hardening

Scope:

- Tighten provider diagnostics so provider failures expose safe structured metadata without raw provider text.
- Preserve status, code, type, param, request id, incomplete reason, token usage, duration, model, API, and schema name where safe.
- Keep logs useful for Render/OpenAI debugging.

Validation:

- `pnpm exec vitest run test/safe-diagnostics.test.ts test/parse-gpt-stabilisation.test.ts test/gpt-runtime-architecture.test.ts`
- `pnpm exec vitest run`

### T-131 Parser and fallback helper unification

Scope:

- Extract repeated mechanical JSON parsing and schema-key helpers where safe.
- Keep mode-specific fallback policies in their feature modules.
- Preserve all current public result shapes and failure behaviour.

Validation:

- `pnpm exec vitest run test/parse-gpt-stabilisation.test.ts test/notes-live-patch.test.ts test/notes-transform-routes.test.ts test/gpt-openai-evals.test.ts`
- `pnpm exec vitest run`

### T-132 Eval/docs archive cleanup

Scope:

- Mark superseded eval reports and candidate/rollback language as historical.
- Keep useful evidence, raw-output exclusions, fixture intent, and current-runtime summary.
- Avoid deleting reports unless they are duplicate or actively misleading.

Validation:

- `git diff --check`
- `pnpm build`
- `pnpm exec vitest run test/gpt-quality-fixtures.test.ts test/gpt-runtime-architecture.test.ts`

### T-133 GPT module boundary review

Scope:

- Review whether `parse-gpt.ts` should remain the compatibility facade.
- Document GPT module import boundaries and export intent.
- Recommend any import migration separately; do not combine with runtime edits.

Validation:

- Static import search:
  `rg -n "^import .*from" gpt parse-gpt.ts handlers notes-transform-routes.ts test`
- `pnpm build`
- `pnpm exec vitest run`

## Notes For Future Agents

- Treat this plan as a risk map, not permission to delete broadly.
- Work on one ticket ID per turn.
- Keep frontend/product tickets out of the backend-local backlog.
- Do not reintroduce experiment runtime flags unless a product/runtime ticket explicitly asks for a new controlled rollout mechanism.
- Keep free-app language as reliability, fair-use, abuse-prevention, and cost-safety only. Do not add paid-tier, upgrade, Pro, pricing, or paywall framing.
