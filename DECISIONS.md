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
  - `{ type: "started", mode }`
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

### Logging And Privacy

- Runtime logs must not include raw user IDs, raw client close reasons, Notes section names, unknown field keys, final attributes, transcripts, notes, form values, JWTs/tokens, or secrets.
- Safe logs include counts, lengths, timings, mode, booleans, safe error names/codes, truncation flags, and VAD metadata without content.

### OpenAI Storage And Provider State

- OpenAI Responses calls default to `store: false` through the central GPT provider helper.
- Live Chat Completions calls also set `store: false` where supported by the current SDK.
- Formify keeps canonical notes and forms app-owned; provider-owned Responses state, Conversations, and `previous_response_id` are not used by default.
- Runtime logs must not include raw transcripts, notes, prompts, generated markdown, form values, template names, field labels, section names, secrets, tokens, user IDs, emails, or raw session IDs.
- This is privacy-first backend hygiene only. Medical, HIPAA, or regulated professional use would require separate legal, compliance, security, access-control, audit-log, retention, and incident-response work.
