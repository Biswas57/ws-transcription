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

### Handler Ordering

- Form and notes handlers process queued transcription passes with concurrency `1`.
- This is intentional because session transcript, attributes, and notes state are mutated sequentially.
- Any future parallelism needs sequence guards before applying results.

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

### Notes AI Post-Processing Over HTTP

- Future notes Summarise/Reorganise actions should use server-to-server HTTP endpoints on `ws-transcription`.
- `formify-web` should call those endpoints from protected tRPC/server code.
- The browser WebSocket protocol remains focused on live audio transcription only.
- Do not duplicate OpenAI/Groq provider logic directly in `formify-web` unless this decision is revisited.

### Notes Transform Source Of Truth

- Notes post-processing actions should operate on the current visible notes markdown supplied by `formify-web`.
- Preview-only transforms do not affect future recording.
- Only explicit apply/replace actions update the canonical notes markdown that is sent back as continuation context.
- The backend does not need a `currentNotesOrigin` field for v1.

### Notes Continuation Context

- Notes mode supports optional continuation context in the `start` payload so multi-segment recordings can resume from current visible notes.
- Continuation notes seed backend notes state but do not change auth, binary audio handling, or outbound message types.
- Notes content must not be logged.

### Free-App Safety Limits

- Usage limits and observability are fair-use safeguards, not monetisation.
- Do not reintroduce Stripe, Pro tiers, subscription checks, or paid feature gates in this repo.
- Any future diagnostics must avoid raw transcript, notes, or PII content and prefer counts, timings, limits, and status flags.
