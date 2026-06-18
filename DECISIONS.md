# Decisions

## Current Technical Decisions

### WebSocket Auth

- The WebSocket server requires a short-lived JWT on `start`.
- Tokens are signed with `WS_TOKEN_SECRET` and include `userId` plus `mode`.
- Dev/test clients may mint local tokens from `.env`; production browser code must not mint tokens directly.

### WebSocket Protocol

- The first client message must be JSON `{ action: "start", mode, token, ... }`.
- Binary WebSocket frames after `start` are treated as WebM/Opus audio chunks.
- The client ends a session with JSON `{ action: "stop" }`.
- Form outputs currently send `{ type, attributes }`; `corrected_audio` is not part of the runtime payload.
- WebSocket message shapes should remain stable unless frontend coordination is explicitly planned.
- Current inbound messages are:
  - `{ action: "start", mode: "forms", token, blocks }`
  - `{ action: "start", mode: "notes", token, noteStyle?, sections?, continuation?, currentNotesMarkdown? }`
  - binary WebM/Opus audio chunks
  - `{ action: "stop" }`
- Current outbound messages are:
  - `{ type: "started", mode, finalisationRecoveryId? }`
  - `{ type: "attributes_update", attributes }`
  - `{ type: "final_attributes", attributes }`
  - `{ type: "notes_update", notesMarkdown }`
  - `{ type: "notes_final", notesMarkdown }`
  - `{ type: "error", code, message? }`
- `transcription-overloaded` is an existing-shape error code used when a per-session reliability/cost-safety queue cap is reached.

### Handler Ordering

- Form and notes handlers process queued transcription passes with concurrency `1`.
- This is intentional because session transcript, attributes, and notes state are mutated sequentially.
- Any future parallelism needs sequence guards before applying results.
- Handlers also guard against closed/stale async continuations. In-flight Whisper/GPT work must check handler state before mutating state, queueing follow-up model work, or sending WebSocket messages.
- Old sessions must not emit `attributes_update`, `final_attributes`, `notes_update`, or `notes_final` into newer sessions on the same socket.

### Forms Short-Value Sensitivity

- Forms mode must preserve short meaningful values such as `yes`, `no`, `John`, `Tuesday`, `$500`, `3pm`, `N/A`, single-word names, and one-word options.
- Forms must not use Notes-style global `MIN_WORD_COUNT = 5` filtering.
- Forms should accept non-empty meaningful transcript for final extraction.
- Forms VAD gate remains disabled; do not route Forms short values through Notes gate behaviour.

### Stop And Backpressure

- Forms and Notes stop paths are idempotent.
- Late audio after stop begins is ignored.
- Forms final attributes should be sent at most once.
- Per-session queue caps prevent unbounded transcription/revision backlog.
- Queue overload is a reliability/fair-use/cost-safety safeguard, not monetisation, and uses existing-shape error code `transcription-overloaded`.

### Package Manager And Runtime

- pnpm is the package manager.
- `package-lock.json` should not be reintroduced.
- Source-run test clients use `tsx` so TypeScript files can use ESM-compatible `.js` import specifiers.

### Load Tests

- Load tests do not start the server automatically.
- Default WebSocket URL is `ws://localhost:5551`.
- `WS_URL` or `--url` may override the target.

### Long Transcript Handling

- Final GPT passes currently preserve the beginning and end of long transcripts and may drop the middle.
- This is an accepted short-term limit, not the desired long-term strategy.

### Separate Forms And Notes Final Context Limits

- Forms and Notes use separate final transcript context limits.
- Forms keep conservative truncation because they extract discrete field values.
- Notes use a larger final transcript window because they summarise whole sessions.
- Long-term Notes finalisation still needs chunked or rolling-summary synthesis.
- Raw transcript and notes content must not be logged.

### Notes Finalisation Source Of Truth

- `current_notes` should be treated as the user-visible notes source of truth during finalisation.
- Final notes may reorganise, deduplicate, and polish content, but should preserve user edits and unique manual clarifications unless clearly contradicted.
- If a user-applied note is uncertain, keep it under an appropriate verify/open-questions section rather than dropping it.

### Notes Incremental Batching

- Long Notes sessions should not run full notes rewrites for every tiny transcript segment.
- Revised transcript should be batched before incremental notes GPT updates.
- On stop, pending revised transcript should be flushed once before the final notes pass instead of draining stale incremental updates one by one.
- Coalescing happens after Whisper/revision, before notes update:

```txt
audio batch
-> Whisper transcription
-> reviseTranscription
-> revised transcript text
-> append to pendingNotesTranscript
-> maybe run generateNotesIncremental
```

- Coalescing is not raw audio batching. It combines revised transcript text before a Notes GPT update.
- After Stop, Notes stops receiving new audio, finishes accepted transcription/revision work, runs at most one stop-flush notes update if pending transcript exists, then runs one final notes pass.
- Stop must not drain a stale incremental GPT backlog.

### Notes AI Post-Processing Over HTTP

- Notes Summarise/Reorganise actions use server-to-server HTTP endpoints on `ws-transcription`.
- `formify-web` should call those endpoints from protected tRPC/server code.
- The browser WebSocket protocol remains focused on live audio transcription only.
- Do not duplicate OpenAI/Groq provider logic directly in `formify-web` unless this decision is revisited.
- Canonical v1 endpoints are `POST /notes/transform/summarise` and `POST /notes/transform/reorganise`.
- Internal auth uses `Authorization: Bearer <NOTES_TRANSFORM_SECRET>`.
- HTTP routes share the existing service port with the WebSocket server and must preserve current WebSocket behaviour.
- Async Summarise/Reorganise jobs are app-owned and in-process for v1. They do not use OpenAI background mode, provider Conversations/state, webhooks, Redis, Postgres, or external queues.
- Async transform job IDs are opaque, results expire, and logs must remain safe metadata only.
- Existing synchronous transform routes remain available. Async transform results are preview-style results and do not mutate canonical notes.
- Final Notes async job wiring is deferred because current finalisation depends on live WebSocket/session-owned transcript and current-notes state.

### Short-Window Notes Finalisation Recovery

- Normal WebSocket `notes_final` delivery remains the fast path.
- Mobile browsers may freeze or disconnect while final Notes is running, so backend T-135 adds a short-lived app-owned recovery mailbox for completed final Notes results.
- This is not full async finalisation, provider background mode, provider Conversations/state, or database persistence.
- Authenticated Notes starts may include an additive opaque `finalisationRecoveryId` in `{ type: "started", mode: "notes", finalisationRecoveryId }`; Forms `started` remains unchanged.
- The internal `POST /notes/finalisation-recovery` route uses `Authorization: Bearer <NOTES_TRANSFORM_SECRET>` and is for server-to-server web bridge calls only.
- Recovery is reserved at Notes start, marked `pending` when Stop/finalisation begins, and terminal results expire after a short completion/failure TTL.
- Recovery should mirror the same user-visible outcome that an open WebSocket would have received: successful/fail-open final notes can be recovered as `succeeded`, while true failures expose only safe error codes.
- Successful recovery may store final `notesMarkdown` briefly as in-memory user content. It must not be logged, persisted, or kept beyond the short TTL.
- The browser must not call the transcription backend recovery endpoint directly. `formify-web` should derive authenticated owner/session state from its server context and call this backend through the internal Bearer secret.
- Owner/session mismatches should return safe `not_found`-style semantics so record existence is not exposed.
- Summarise/Reorganise recovery should prefer the existing async transform job routes unless those prove insufficient. Backend T-135 is primarily for missed WebSocket `notes_final` recovery.

### Notes Transform Source Of Truth

- Notes post-processing actions should operate on the current visible notes markdown supplied by `formify-web`.
- Preview-only transforms do not affect future recording.
- Only explicit apply/replace actions update the canonical notes markdown that is sent back as continuation context.
- The backend does not need a `currentNotesOrigin` field for v1.

### Notes Continuation Context

- Notes mode supports optional continuation context in the `start` payload so multi-segment recordings can resume from current visible notes.
- Continuation notes seed backend notes state but do not change auth, binary audio handling, or outbound message types.
- Notes content must not be logged.
- Continuation uses `continuation: true` plus `currentNotesMarkdown`.
- The backend seeds from supplied current notes markdown; the old full transcript is not required.

### Notes VAD

- Supported VAD modes are `off`, `dry-run`, and `gate`.
- Default is `off`.
- VAD fails open to Whisper.
- Gate mode is intended for Notes only; Forms are not gated.
- Stop flush must never be skipped by VAD.
- VAD logs safe metadata only, never raw audio/transcript/notes.

### Free-App Safety Limits

- Usage limits and observability are fair-use safeguards, not monetisation.
- Do not reintroduce Stripe, Pro tiers, subscription checks, or paid feature gates in this repo.
- Any future diagnostics must avoid raw transcript, notes, or PII content and prefer counts, timings, limits, and status flags.
- Usage events are content-safe metadata checkpoints for reliability and cost-safety: session starts/stops, queue overloads, cap triggers, transcription batch counts, provider calls, fallback categories, token usage, and output/input lengths.
- Long-session token/cost metrics are estimates used to guide backend reliability work such as T-094. They are not billing truth and should not be used to introduce monetisation gates.
- Live Notes patch prompts may receive bounded current-notes context once canonical notes grow large. This is a model-input optimisation only: full canonical notes remain app-owned, are preserved in `NotesHandler`, are used for patch application, and are still supplied to final Notes.
- Safe production metadata for live context compaction may include original/context/saved char counts, heading counts, provider mode, and booleans. It must not include raw notes, headings, transcript, prompts, or model output.

### Logging And Privacy

- Runtime logs must not include raw user IDs, raw client close reasons, Notes section names, unknown field keys, final attributes, transcripts, notes, form values, JWTs/tokens, or secrets.
- Safe logs include counts, lengths, timings, mode, booleans, safe error names/codes, truncation flags, and VAD metadata without content.

### OpenAI Storage And Provider State

- OpenAI Responses calls default to `store: false` through the central GPT provider helper.
- Live Chat Completions calls also set `store: false` where supported by the current SDK.
- Formify keeps canonical notes and forms app-owned; provider-owned Responses state, Conversations, and `previous_response_id` are not used by default.
- Runtime logs must not include raw transcripts, notes markdown, prompts, generated markdown, form values, template names, field labels, section names, raw provider outputs, secrets, tokens, user IDs, emails, or raw session IDs.
- Safe metadata is allowed: counts, char lengths, durations, token usage, provider status categories, parse/schema failure categories, booleans, and safe hashes where already used.
- This is privacy-first backend hygiene only, not a medical, HIPAA, legal, or regulated-professional compliance claim.
- Clinical or professional compliance requires separate legal, compliance, security, access-control, audit-log, retention, and incident-response work.
- Any future use of provider Conversations, background mode, tools, file search, retained context, or stateful Responses features needs explicit product/privacy review before implementation.

### Prompt Caching Readiness

- Prompt caching is secondary to reducing context bloat; T-094 bounded live Notes context is the primary live cost-control step.
- Stable prompt prefixes are most useful for final/transform flows where static instructions and strict JSON schemas repeat across calls.
- Keep dynamic content such as transcript, current notes, form values, and requested sections after stable instructions/schema where practical.
- Safe cached-token metadata may be logged as numeric counts only: cached input tokens, total input tokens, output tokens, reasoning tokens, and total tokens.
- Do not log raw prompts, notes, transcripts, generated markdown, form values, field labels, section names, or provider outputs while evaluating cache behaviour.
- Do not add `prompt_cache_key` by default until there is an explicit product/privacy decision. Future cache keys must not include raw transcript, notes, field values, user identifiers, or session identifiers.

### GPT Runtime Architecture

- GPT runtime defaults are centralised in `gpt/model-config.ts` through `GPT_FLOW_CONFIG`.
- Production provider/model/reasoning defaults are intentionally static:
  - Revision: Responses, `gpt-5.4-mini`, reasoning `none`.
  - Forms live extraction: Chat Completions, `gpt-5.4-mini`, reasoning `low`.
  - Notes live patching: Responses strict schema, `gpt-5.4-mini`, reasoning `low`, with no Chat fallback.
  - Forms final extraction: Responses, `gpt-5.4`, reasoning `medium`.
  - Notes finalisation: Responses, `gpt-5.4`, reasoning `medium`.
  - Notes Summarise: Responses, `gpt-5.4`, reasoning `medium`.
  - Notes Reorganise: Responses, `gpt-5.4`, reasoning `low`.
- Experiment-era production env flags for Notes live provider selection and Reorganise reasoning overrides have been removed. Future provider/model/reasoning changes should be explicit code changes backed by evals, not hidden runtime switches.
- Deployment/auth/runtime env vars remain valid and are not experiment flags: `OPENAI_API_KEY`, `WS_TOKEN_SECRET`, `NOTES_TRANSFORM_SECRET`, `ALLOWED_ORIGIN`, `VAD_MODE`, `WHISPER_REQUEST_TIMEOUT_MS`, and `GPT_REQUEST_TIMEOUT_MS`.
- Test/eval-only flags remain confined to test tooling, such as `OPENAI_EVALS`, `OPENAI_EVAL_FLOWS`, `OPENAI_EVALS_WRITE_OUTPUTS`, `OPENAI_EVALS_OUTPUT_DIR`, and test/load `WS_URL`.
- Notes live failure categories are metadata only (`provider_error`, `incomplete_response`, `empty_output`, `parse_failed`, `schema_invalid`). Failed live patch calls preserve current notes by returning a no-op patch and logging safe metadata only.
