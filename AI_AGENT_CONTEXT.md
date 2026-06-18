# AI Agent Context

## What This Repo Does

This repo is the Formify transcription WebSocket server plus backend-owned Notes transform service. It accepts browser-recorded WebM/Opus audio over a WebSocket, sends audio chunks to OpenAI Whisper, cleans up the transcript with GPT, then returns either:

- structured form attributes in `forms` mode
- live and final Markdown notes in `notes` mode

It also exposes Bearer-protected server-to-server HTTP endpoints for post-processing supplied visible Notes markdown.

The server is designed for Australian professional contexts such as healthcare, finance, social work, HR, and meetings.

## Connection To The Other Formify Repo

The main Formify web app is separate from this repo. This server expects the web app to:

1. Mint/request a short-lived WebSocket JWT using the same `WS_TOKEN_SECRET`.
2. Open a WebSocket connection to this service, normally `ws://localhost:5551` in local dev.
3. Send a `start` message with `mode`, `token`, and mode-specific config.
4. Stream binary WebM/Opus audio chunks.
5. Send `stop` when recording ends.
6. Render incremental/final responses from this server.

`ws-token.ts` documents the intended shared auth convention. In production, the web app should mint tokens from a protected backend route, not from browser code.

## Main Files

- `app.ts`: shared HTTP/WebSocket server on port `5551`; connection lifecycle, optional origin check, JWT verification, mode routing, and HTTP route attachment.
- `notes-transform-routes.ts`: Bearer-protected HTTP routes for Notes summarise/reorganise transforms.
- `types.ts`: WebSocket message types, shared constants, handler interfaces, audio state shapes.
- `handlers/FormFillHandler.ts`: `forms` mode implementation; buffers audio, transcribes, revises, extracts fields, sends incremental/final attributes.
- `handlers/NotesHandler.ts`: `notes` mode implementation; buffers audio, transcribes, revises, updates Markdown notes, sends incremental/final notes.
- `transcription.ts`: WebM validation/header handling, Whisper API call, transcript overlap merge.
- `parse-gpt.ts`: compatibility facade that re-exports GPT helpers for existing handlers/routes/tests.
- `gpt/`: OpenAI GPT config, provider helpers, JSON helpers, transcript revision, Forms extraction/final parsing, Notes live/final generation, and Notes transform logic.
- `ws-token.ts`: JWT mint/verify helpers for WebSocket session tokens.
- `load/`: WebSocket load-test harness.
- `tools/manual/`: source-run WebSocket smoke clients.
- `test/`: focused backend tests and shared fixtures.

## Commands

Install dependencies:

```bash
pnpm install
```

Build:

```bash
pnpm build
```

Run server:

```bash
pnpm start
```

Run source test client, with the server already running:

```bash
pnpm test-client
```

Other test clients:

```bash
pnpm test-client:single
pnpm test-client:live
```

Run load test, with the server already running:

```bash
pnpm load-test
```

Short load-test smoke run:

```bash
pnpm load-test -- -c 2 -r 1 -d 5
```

Override WebSocket URL:

```bash
WS_URL=ws://localhost:5551 pnpm load-test
```

## Env Vars

- `OPENAI_API_KEY`: required for Whisper and GPT calls.
- `WS_TOKEN_SECRET`: required by both the web app token minting path and this WebSocket server.
- `ALLOWED_ORIGIN`: optional exact origin allowlist for WebSocket connections.
- `WS_URL`: optional local test/load client target URL.
- `VAD_MODE`: optional Notes VAD mode, one of `off`, `dry-run`, or `gate`; default is `off`.
- `WHISPER_REQUEST_TIMEOUT_MS`: optional Whisper request timeout.
- `GPT_REQUEST_TIMEOUT_MS`: optional GPT request timeout.
- `NOTES_TRANSFORM_SECRET`: required for server-to-server Notes transform and finalisation recovery HTTP endpoints; callers send `Authorization: Bearer <secret>`.

## HTTP Notes Transform Contract

The Notes transform endpoints are server-to-server only. The browser should not call them directly and must never receive `NOTES_TRANSFORM_SECRET`.

Auth:

```txt
Authorization: Bearer <NOTES_TRANSFORM_SECRET>
```

Routes:

```txt
POST /notes/transform/summarise
POST /notes/transform/reorganise
```

Summarise request/response:

```json
{ "notesMarkdown": "## Current notes\n\n- ...", "noteStyle": "meeting" }
```

```json
{ "summaryMarkdown": "## Summary\n\n- ..." }
```

Reorganise request/response:

```json
{ "notesMarkdown": "## Current notes\n\n- ...", "noteStyle": "meeting", "targetSections": ["Decisions", "Actions"] }
```

```json
{ "reorganisedMarkdown": "## Decisions\n\n- ..." }
```

Both transforms operate only on supplied current visible `notesMarkdown`; they do not use audio, transcript, DB state, previous backend session state, or hidden note history. Errors return JSON `{ "error": { "code": "...", "message": "..." } }` without echoing note content.

## WebSocket Contract

The client connects to the WebSocket server, sends JSON text control messages, and streams binary audio frames.

WebSocket message shapes should remain stable unless frontend coordination is explicitly planned. The backend does not send `corrected_audio`. The existing-shape error code `transcription-overloaded` may be sent when a per-session reliability/cost-safety queue cap is reached.

### Inbound: Forms Start

```json
{
  "action": "start",
  "mode": "forms",
  "token": "<jwt>",
  "blocks": {
    "personal": ["full_name", "date_of_birth"]
  }
}
```

### Inbound: Notes Start

```json
{
  "action": "start",
  "mode": "notes",
  "token": "<jwt>",
  "noteStyle": "clinical",
  "sections": ["History", "Assessment", "Plan"]
}
```

### Inbound: Audio

Binary WebSocket frames containing WebM/Opus audio chunks.

### Inbound: Stop

```json
{ "action": "stop" }
```

### Outbound Messages

Started:

```json
{ "type": "started", "mode": "forms" }
```

Authenticated Notes starts may include an additive recovery handle:

```json
{ "type": "started", "mode": "notes", "finalisationRecoveryId": "opaque-id" }
```

Forms incremental:

```json
{
  "type": "attributes_update",
  "attributes": {
    "full_name": "Example Name"
  }
}
```

Forms final:

```json
{
  "type": "final_attributes",
  "attributes": {
    "full_name": "Example Name"
  }
}
```

Notes incremental:

```json
{
  "type": "notes_update",
  "notesMarkdown": "## Summary\n- ..."
}
```

Notes final:

```json
{
  "type": "notes_final",
  "notesMarkdown": "## Summary\n- ..."
}
```

Error:

```json
{
  "type": "error",
  "code": "invalid-token",
  "message": "Session token is invalid or expired. Please refresh the page."
}
```

Possible error codes include auth/session errors such as `missing-token`, `invalid-token`, `mode-mismatch`, `bad-json`, `unknown-action`, and backend processing errors such as `audio-buffer-overflow`, `transcription-failed`, and `transcription-overloaded`.

## Audio And Parsing Flow

1. Client sends `start`; server verifies the JWT and selects the handler.
2. Client streams WebM/Opus chunks as binary WebSocket frames.
3. Handler buffers chunks until the mode-specific chunk threshold.
4. Handler snapshots the buffer and processes it sequentially.
5. Whisper transcribes the audio buffer.
6. GPT revises the transcript segment.
7. Forms mode extracts attributes; notes mode updates Markdown notes.
8. Server sends incremental updates.
9. On `stop`, queued work drains, remaining audio is processed, and a final GPT pass runs.

### Forms Operating Invariants

- Forms must preserve short meaningful values such as `yes`, `no`, `John`, `Tuesday`, `$500`, `3pm`, `N/A`, single-word names, and one-word options.
- Forms must not use Notes-style `MIN_WORD_COUNT = 5` filtering.
- Forms accepts non-empty meaningful transcript for incremental/final extraction.
- Forms VAD gate remains disabled.
- Forms stop is idempotent; duplicate stop cannot duplicate finalisation.
- Late audio after stop begins is ignored.
- Final attributes should be sent at most once.

### Notes Operating Invariants

Notes coalescing happens after Whisper/revision, before notes update:

```txt
audio batch
-> Whisper transcription
-> reviseTranscription
-> revised transcript text
-> append to pendingNotesTranscript
-> maybe run generateNotesIncremental
```

Coalescing is not raw audio batching. It combines revised transcript text before a Notes GPT update.

After Stop:

1. Stop receiving new audio.
2. Finish accepted transcription/revision work.
3. Run at most one stop-flush notes update if pending transcript exists.
4. Run one final notes pass.

Do not drain stale incremental GPT backlog.

Continuation uses `continuation: true` and `currentNotesMarkdown`. The backend seeds from supplied current notes markdown; the old full transcript is not required.

VAD modes are `off`, `dry-run`, and `gate`. VAD defaults to `off`, fails open to Whisper, is intended for Notes gate behaviour only, does not gate Forms, must never skip stop flush, and logs safe metadata only.

### Notes Finalisation Recovery

T-135 is the backend half of cross-repo T-186. Keep normal WebSocket `notes_final` delivery as the fast path; the recovery mailbox is only for mobile/background cases where finalisation completes but the client misses the message.

- Authenticated Notes `started` may include an opaque `finalisationRecoveryId`; Forms `started` remains unchanged.
- `POST /notes/finalisation-recovery` is an internal server-to-server route protected by `NOTES_TRANSFORM_SECRET`.
- Recovery is reserved at Notes start, marked `pending` when Stop/finalisation begins, and expires terminal results shortly after completion/failure.
- Return the same user-visible final outcome the WebSocket would have delivered. Existing fail-open final notes should be recoverable as `succeeded`, not converted into a different failure state.
- Store successful `notesMarkdown` only briefly in memory for recovery; do not store transcript, audio, prompts, provider output, or raw errors in recovery metadata.
- The browser should call `formify-web`; web server/tRPC derives authenticated owner/session state and calls this backend using internal Bearer auth.
- Guard recovery by owner/session. Mismatches should return safe `not_found`-style semantics and must not log raw user IDs or recovery/session IDs.
- Summarise/Reorganise should continue to use existing async transform jobs unless proven insufficient; T-135 is mainly for missed `notes_final` recovery.

### Active Notes Recording Interruption Recovery

T-188 covers mobile/background disconnects while Notes recording is still active and before Stop/finalisation begins. It is resume-first active recording recovery, not auto-finalisation.

- Authenticated Notes sessions with a signed `recordingSessionId` may snapshot accepted text state for the same short window used by Notes cap reconnect continuity.
- The snapshot may include current notes, accepted transcript, pending revised transcript, safe counts, and the finalisation recovery ID. Do not store raw audio, prompts, provider output, secrets, or raw logs.
- Quick reconnect / Resume should reuse the same backend-signed `recordingSessionId`; Start New Recording should mint a fresh one.
- Reconnect claims interrupted state once, restores accepted text, and then normal recording or Stop/finalisation paths continue.
- V1 does not auto-finalise after expiry. Expired interrupted state is discarded safely; T-135 still handles recovery after Stop/finalisation starts or completes.

### Handler Lifecycle And Backpressure

- Forms and Notes handlers guard against closed/stale async continuations.
- In-flight Whisper/GPT completions must check handler state before mutating state, queueing follow-up model work, or sending messages.
- Old sessions must not emit `attributes_update`, `final_attributes`, `notes_update`, or `notes_final` into newer sessions on the same socket.
- Per-session queue caps prevent unbounded transcription/revision backlog.
- Overloaded sessions send existing-shape error code `transcription-overloaded` and ignore further chunks until stop/close.
- Queue caps are reliability/fair-use/cost-safety controls, not monetisation.

### Revision Failure Behaviour

If Whisper succeeds but `reviseTranscription` fails, the backend must return raw Whisper text rather than dropping the segment. Logs should include safe metadata only.

### Logging And Privacy

Runtime logs must not include raw user IDs, raw client close reasons, Notes section names, unknown field keys, final attributes, transcripts, notes, form values, JWTs/tokens, or secrets.

Safe logs include counts, lengths, timings, mode, booleans, safe error names/codes, truncation flags, and VAD metadata without content.

## Safe-Change Rules

- Before code edits, check `TASKS.md` and work only on the requested ticket ID.
- After code edits, update `TASKS.md`; update `DECISIONS.md` only when a real technical decision changes.
- Do not weaken WebSocket auth. Dev/test clients may mint local tokens using `WS_TOKEN_SECRET`, but production browser code must not.
- Keep WebSocket payload changes coordinated with the Formify web app.
- Avoid broad refactors in handlers unless also adding ordering tests; handler queues currently rely on sequential mutation.
- Preserve ESM-compatible imports for built output.
- Keep pnpm as the package manager; do not reintroduce `package-lock.json`.
- Prefer small, typed protocol changes in `types.ts` before changing runtime payloads.
- Run `pnpm build` after TypeScript changes.
- Do not add Stripe, Pro tiers, subscriptions, upgrade paths, premium gates, pricing logic, or paywalls. Backend controls are allowed only for reliability, fair-use, cost-safety, and abuse prevention.
- Do not start HTTP notes transform endpoints unless explicitly requested.

## Known Risks

- Final GPT passes currently use a fixed character limit and preserve the beginning/end of long transcripts while dropping the middle.
- Verify `NOTES_FINAL_TRANSCRIPT_CHAR_LIMIT` with production/beta `truncated: true` logs and dense long-session simulations before changing it.
- Handler queues are intentionally concurrency `1`; increasing concurrency can corrupt transcript, attributes, or notes ordering unless sequence guards are added.
- `corrected_audio` is not currently sent in form update/final messages. Reintroducing it needs frontend coordination.

## Ticket Source Of Truth

Use `TASKS.md` as the current ticket list. Keep `DECISIONS.md` and this file as durable context, not short-term status reports.
