# Tasks

Use this file as the working ticket list for future AI-agent turns. Work on only the requested ticket ID.

## Completed

| ID | Status | Notes |
| --- | --- | --- |
| T-001 Fix test-client ESM/ts-node import issue | Completed | Test clients use the current mode/token start contract via the `tsx` runner; no root `.js` shims. |
| T-002 Improve load-test failure logging and default WS_URL | Completed | Load tests default to `ws://localhost:5551`, allow `WS_URL`, and print per-VU failure reasons. |
| T-003 Verify WS_TOKEN_SECRET fails closed | Completed | Auth test confirms missing/invalid/expired token and mode mismatch fail closed; valid token reaches `started`. |
| T-004 Smoke test WebSocket recording flow | Completed | Start/stop flow verified with valid mode/token sessions; recording reaches `started` reliably. |
| T-005 Long-session memory / rolling synthesis (Phase 1) | Completed | Notes final pass uses a larger notes-only transcript window with capped output-token budget and token diagnostics. Rolling checkpoint digests (Option B, for beyond-cap scaling) tracked as T-017. |
| T-006 Harden form extraction for locked/excluded fields | Completed | Extraction prompts no longer force missing/locked/excluded info into nearby allowed fields. |
| T-008 Improve notes prompts for long training conversations | Completed | Notes prompts reduce duplication, repair fragmented headings, and preserve technical terms for long sessions. |
| T-009 Accept notes continuation context in start payload | Completed | Notes start accepts optional continuation markdown, capped safely, without changing other contracts. |
| T-010 Increase Notes final transcript limit and add safe diagnostics | Completed | Notes finalisation uses a larger notes-only transcript window with content-safe diagnostics; forms unchanged. |
| T-012 Reduce notes incremental GPT backlog and stop latency | Completed | Adaptive scheduler batches revised transcript with one in-flight update and a single stop flush, plus notes-only phase-based chunk cadence. |
| T-013b Enforce notes session hard cap | Completed | Server-side session-cap timer drives an idempotent stop/finalise shared by client and cap stop triggers. |
| T-014 Notes VAD optimisation | Completed | Skip no-speech batches before Whisper via Silero VAD (ffmpeg-static decode) behind `transcribeAudioBatch`; `VAD_MODE` off/dry-run/gate, fails open, notes gated, forms ungated. |
| T-015 Forms recording observability | Completed | Added content-safe forms-mode timing/observability logging (counts and timings only). |
| T-016 Harden revision fallback and backend session stability | Completed | Forms preserves short values; Forms/Notes suppress stale async sends; Forms stop is idempotent; late audio is ignored after stop; per-session queue caps send `transcription-overloaded`; revision fails open to raw Whisper text; runtime logs use safe metadata only; Notes start payload is sanitised; Whisper/GPT calls have request timeouts. |
| T-062 Align Notes backend cap to 60 minutes | Completed | Backend Notes sessions now use a 60-minute reliability/cost-safety hard cap and finalise through the existing idempotent Stop path. Frontend warning timings remain frontend-owned. |
| T-159 Reduce Notes incremental rewrite cost | Completed | Live notes now use append-only patch JSON applied by the backend to canonical markdown, avoiding repeated full-document live rewrites and bounding live patch output by transcript size rather than current notes length. |
| T-160 Split Notes live-update and final-formatting prompts | Completed | Live prompt now requests small append-only patch instructions; final prompt remains the full-document polish/dedupe/restructure pass and may return shorter final notes when meaning is preserved. |
| T-164 Preserve Notes continuation canonical markdown | Completed | Notes continuation now stores the supplied `currentNotesMarkdown` as full canonical markdown instead of truncating it to 20k chars; final notes may still compact, dedupe, and summarise during `notes_final`. |

## Active

| ID | Status | Notes |
| --- | --- | --- |
| _None._ | | |

## Backlog

| ID | Status | Notes |
| --- | --- | --- |
| T-007 Add HTTP notes transform endpoints | Backlog | T-130 / ws-transcription T-007. Add server-to-server HTTP endpoints for notes summarise/reorganise; keep WebSocket focused on live audio. Requires an HTTP-capable server entrypoint while preserving current WS behaviour. |
| T-011 Strengthen preservation of user-applied notes in finalisation | Backlog | Preserve user edits, custom sections, and manual clarifications in finalisation unless clearly contradicted. |
| T-013 Free-app usage safety limits and observability | Backlog | Add fair-use safety limits and content-safe usage observability without Stripe, Pro tiers, or paywalls. |
| T-017 Long-session memory / rolling synthesis (Phase 2, Option B) | Backlog | Seal older raw transcript into compact rolling checkpoint digests so memory and final-pass cost stay bounded if the Notes session cap is raised/removed; final pass consumes notes + digests + recent raw tail. Only needed beyond the cap; backend-only, no WS protocol change. |
| T-019 Summarise notes backend support | Backlog | Depends on T-007. Use current visible/edited `notesMarkdown` only; no audio, transcript, or DB save. Return `summaryMarkdown`. |
| T-020 Reorganise notes backend support | Backlog | Depends on T-007. Use current visible/edited `notesMarkdown` plus target sections; no full transcript in v1. Return `reorganisedMarkdown`. |
| T-169b Clean unused backend constants/code | Backlog | Backend tidy-up. Remove unused backend constants and dead/commented code paths such as TRANSCRIPTION_CACHE_TTL, MAX_CACHE_ENTRIES, and MIN_AUDIO_SIZE_BYTES only after confirming with rg that they have no active usage. Do this before batching/revision changes so the reliability diff stays clean. |
| T-170a Tune Notes batching, revision gates, and live update cadence | Backlog | P1, backend Notes reliability. Reduce transcription-overloaded risk by increasing Notes audio batch size over session age, slowing live Notes updates, and reducing unnecessary revision GPT calls. Use Notes chunk phases: <30s = 4 chunks, <60s = 5 chunks, <5m = 10 chunks, 5m+ = 15 chunks. Update live Notes scheduler to early <2m: 15000ms/80 chars, settled <10m: 30000ms/280 chars, long <30m: 60000ms/600 chars, extended >=30m: 120000ms/1200 chars. Raise live patch output budget to min 1024 and +512, max 2048. Add mode-aware revision gates. Split final GPT reasoning so final Forms/Notes can use high while live/revision calls remain low. Keep VAD placement, reconnect, cap, prompts, frontend chunk duration, and finalisation semantics unchanged. |
| T-170b Add Notes reconnect retries | Backlog | P1, frontend/cross-repo reliability. After batching changes are tested, add up to 5 reconnect attempts for unexpected Notes disconnects. Preserve current notes/localStorage, reconnect with current canonical notesMarkdown, prevent stale socket updates, and only fall back to paused/recoverable after retries fail. Do not change normal manual Resume semantics. |
| T-170c Preserve Notes cap timer across quick reconnects | Backlog | P1/P2, cross-repo reliability. Design logical recording session identity so quick reconnects within a short grace window preserve the original 60-minute cap timing. Manual Stop/finalisation/Resume should still behave normally. Do not change the cap value. |
| T-170d Evaluate VAD-first audio filtering | Backlog | P2/P3, risky backend optimisation. Investigate moving VAD before Notes audio buffering so obvious silence is dropped before entering the transcription batch. Include risks around speech clipping, pre-roll/post-roll, CPU overhead, false skips, and stop-flush safety. Do not implement until batching/reconnect behaviour is stable. |
