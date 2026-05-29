# Tasks

Use this file as the working ticket list for future AI-agent turns. Work on only the requested ticket ID.

## Completed

| ID | Status | Notes |
| --- | --- | --- |
| T-001 Fix test-client ESM/ts-node import issue | Completed | Test clients use the current `mode`/`token` start contract and `tsx` source runner; no root `.js` shims. |
| T-002 Improve load-test failure logging and default WS_URL | Completed | Load tests default to `ws://localhost:5551`, allow `WS_URL`, and print per-VU failure reasons. |
| T-003 Verify WS_TOKEN_SECRET fails closed | Completed | Focused auth test verifies missing secret/token, invalid token, expired token, and mode mismatch fail closed; valid token reaches `started`. |
| T-004 Smoke test WebSocket recording flow | Completed | Start/stop flow has been tested repeatedly with valid mode/token sessions; recording reaches started and behaves reliably. Remaining edge cases are non-blocking. |
| T-006 Harden form extraction for locked/excluded fields | Completed | Prompt hardening tells incremental/final extraction not to force missing/locked/excluded-field information into nearby allowed fields, including street address vs `living_situation`. |
| T-008 Improve notes prompts for long training conversations | Completed | Notes prompts now reduce duplication, repair fragmented headings, preserve technical terms, and make final notes more editorial/checklist-oriented for long professional training/process conversations. |
| T-009 Accept notes continuation context in start payload | Completed | Notes start accepts optional continuation markdown, seeds backend notes state safely, and caps continuation context without changing auth, forms, audio frames, or outbound messages. |
| T-010 Increase Notes final transcript limit and add safe diagnostics | Completed | Notes finalisation now uses a larger notes-only transcript window with content-safe count/truncation diagnostics; forms keep the existing conservative limit. |

## Active

| ID | Status | Notes |
| --- | --- | --- |
| T-012 Reduce notes incremental GPT backlog and stop latency | Active | Highest-priority backend reliability ticket. Batch revised transcript before notes GPT updates and flush once on stop to avoid draining stale incremental work. |

## Backlog

| ID | Status | Notes |
| --- | --- | --- |
| T-005 Later: long-session transcript chunking strategy | Backlog | Long-term follow-up after T-010: replace finite Notes final truncation with chunked processing or rolling summaries for very long sessions. |
| T-007 Add HTTP notes transform endpoints | Backlog | Medium/High priority, medium risk. Add server-to-server HTTP endpoints for notes summarise/reorganise post-processing; keep browser WebSocket focused on live audio transcription. |
| T-011 Strengthen preservation of user-applied notes in finalisation | Backlog | Prompt-hardening follow-up. Preserve user edits, custom sections, and unique manual clarifications from `current_notes` unless clearly contradicted. |
| T-013 Free-app usage safety limits and observability | Backlog | Add fair-use safety limits and content-safe usage observability without reintroducing Stripe, Pro tiers, or paywalls. |
| T-014 Audio variance / VAD optimisation | Backlog | Later optimisation. Consider speech/silence detection after T-012 reduces GPT backlog; do not start with VAD. |
