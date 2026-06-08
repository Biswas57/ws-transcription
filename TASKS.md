# Tasks

Use this file as the working ticket list for future AI-agent turns. Work on only the requested ticket ID. Keep backend-local `T-0xx` IDs canonical here; do not copy frontend/product `T-1xx` IDs into the ID column.

## Completed

| ID | Status | Notes |
| --- | --- | --- |
| T-001 Fix test-client ESM/ts-node import issue | Completed | Test clients use the current mode/token start contract via the `tsx` runner; no root `.js` shims. |
| T-002 Improve load-test failure logging and default WS_URL | Completed | Load tests default to `ws://localhost:5551`, allow `WS_URL`, and print per-VU failure reasons. |
| T-003 Verify WS_TOKEN_SECRET fails closed | Completed | Auth test confirms missing/invalid/expired token and mode mismatch fail closed; valid token reaches `started`. |
| T-004 Smoke test WebSocket recording flow | Completed | Start/stop flow verified with valid mode/token sessions; recording reaches `started` reliably. |
| T-005 Long-session memory / rolling synthesis (Phase 1) | Completed | Notes final pass uses a larger notes-only transcript window with capped output-token budget and token diagnostics. Rolling checkpoint digests (Option B, for beyond-cap scaling) tracked as T-017. |
| T-006 Harden form extraction for locked/excluded fields | Completed | Extraction prompts no longer force missing/locked/excluded info into nearby allowed fields. |
| T-007 Add HTTP notes transform endpoints | Completed | Added server-to-server HTTP endpoints for Notes summarise/reorganise on the existing service port, with Bearer secret auth and no WebSocket contract changes. |
| T-008 Improve notes prompts for long training conversations | Completed | Notes prompts reduce duplication, repair fragmented headings, and preserve technical terms for long sessions. |
| T-009 Accept notes continuation context in start payload | Completed | Notes start accepts optional continuation markdown, capped safely, without changing other contracts. |
| T-010 Increase Notes final transcript limit and add safe diagnostics | Completed | Notes finalisation uses a larger notes-only transcript window with content-safe diagnostics; forms unchanged. |
| T-012 Reduce notes incremental GPT backlog and stop latency | Completed | Adaptive scheduler batches revised transcript with one in-flight update and a single stop flush, plus notes-only phase-based chunk cadence. |
| T-013 Enforce notes session hard cap | Completed | Server-side session-cap timer drives the same idempotent stop/finalise path as manual Stop. |
| T-014 Notes VAD optimisation | Completed | Skip no-speech batches before Whisper via Silero VAD (ffmpeg-static decode) behind `transcribeAudioBatch`; `VAD_MODE` off/dry-run/gate, fails open, notes gated, forms ungated. |
| T-015 Forms recording observability | Completed | Added content-safe forms-mode timing/observability logging (counts and timings only). |
| T-016 Harden revision fallback and backend session stability | Completed | Forms preserves short values; Forms/Notes suppress stale async sends; Forms stop is idempotent; late audio is ignored after stop; per-session queue caps send `transcription-overloaded`; revision fails open to raw Whisper text; runtime logs use safe metadata only; Notes start payload is sanitised; Whisper/GPT calls have request timeouts. |
| T-019 Summarise notes backend support | Completed | Added backend summarise transform support using current visible `notesMarkdown` only; returns `summaryMarkdown` for frontend preview/apply flows. |
| T-020 Reorganise notes backend support | Completed | Added backend reorganise transform support using current visible `notesMarkdown` and optional target sections only; returns `reorganisedMarkdown` and guards against accidental summarisation. |
| T-062 Align Notes backend cap to 60 minutes | Completed | Backend Notes sessions now use a 60-minute reliability/cost-safety hard cap and finalise through the existing idempotent Stop path. Frontend warning timings remain frontend-owned. |
| T-063 Reduce Notes incremental rewrite cost | Completed | Live notes now use append-only patch JSON applied by the backend to canonical markdown, avoiding repeated full-document live rewrites and bounding live patch output by transcript size rather than current notes length. |
| T-064 Split Notes live-update and final-formatting prompts | Completed | Live prompt now requests small append-only patch instructions; final prompt remains the full-document polish/dedupe/restructure pass and may return shorter final notes when meaning is preserved. |
| T-065 Preserve Notes continuation canonical markdown | Completed | Notes continuation now stores the supplied `currentNotesMarkdown` as full canonical markdown instead of truncating it to 20k chars; final notes may still compact, dedupe, and summarise during `notes_final`. |
| T-066 Clean unused backend constants/code | Completed | Removed unused backend transcription constants and dead cache code after confirming they had no active usage. |
| T-067 Tune Notes batching, revision gates, and live update cadence | Completed | Reduced transcription-overloaded risk by increasing Notes audio batch size over session age, slowing live Notes updates, reducing unnecessary revision GPT calls, raising the live patch output floor, and splitting final-quality reasoning from frequent live/revision calls. |
| T-068 Harden Notes overload recovery support | Completed | Notes overload now pauses intake, sends one existing-shape `transcription-overloaded` error, keeps the socket open, and allows already accepted queued/in-flight work to continue while the socket remains open. |
| T-069 Preserve Notes cap timer across quick reconnects | Completed | Backend cap registry reuses the original 60-minute Notes cap deadline for signed quick reconnects from the same authenticated user and closes the cap window on normal finalisation. |
| T-071 Improve Notes markdown formatting prompts | Completed | Live Notes can create safe provisional `##` sections; final/live prompts improve hierarchy, examples, headings, and live readability without contract changes. |
| T-072 Review and tune Notes/Formify GPT prompts | Completed | Updated active GPT prompts for Forms short values, canonical current notes, adaptive transforms, conservative revision, and no table/sponsor/promo wording. |
| T-075 Split GPT helpers and parsers out of parse-gpt.ts | Completed | Split GPT config, provider, JSON helpers, revision, Forms, Notes live/final, and Notes transform logic into `gpt/` modules while keeping `parse-gpt.ts` as the compatibility facade. |
| T-076 Consolidate safe diagnostics and error helpers | Completed | Added shared content-safe diagnostics helpers for error metadata, JSON keys, token usage, safe values, numeric metadata, and short hashes; refactored low-risk call sites without changing runtime behaviour. |
| T-077 Remove stale backend comments and legacy compatibility residue | Completed | Removed unused historical cache/cost files, stale Groq/parser references, unused legacy dependencies, and misleading comments without changing runtime behaviour or contracts. |
| T-081 Tune Responses output budgets for Notes final and transforms | Completed | Increased Notes final, Summarise, and Reorganise Responses output-budget headroom so medium reasoning is less likely to consume the whole visible-output budget and trigger `max_output_tokens` incompletes. Contracts, prompts, fallback behaviour, and safe diagnostics are unchanged. |

## Active

| ID | Status | Notes |
| --- | --- | --- |
| _None._ | | |

## Backlog

| ID | Status | Notes |
| --- | --- | --- |
| T-011 Strengthen preservation of canonical current notes | Backlog | Further harden finalisation so useful `currentNotesMarkdown` content is preserved unless contradicted, irrelevant, duplicated, or artefactual. |
| T-017 Long-session memory / rolling synthesis | Backlog | Add rolling checkpoint digests only if sessions beyond the current cap need bounded final-pass memory/cost. Backend-only; no WS protocol change. |
| T-070 Evaluate VAD-first audio filtering | Backlog | P2/P3, risky backend optimisation. Investigate moving VAD before Notes audio buffering so obvious silence is dropped before entering the transcription batch. Include risks around speech clipping, pre-roll/post-roll, CPU overhead, false skips, and stop-flush safety. Do not implement until batching/reconnect behaviour is stable. |
| T-073 Free-app usage safety limits and observability | Backlog | Add fair-use and content-safe usage observability only for reliability/cost-safety. No Stripe, Pro tiers, upgrades, or paywalls. |
