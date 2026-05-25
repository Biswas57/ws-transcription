# AI Agent Context

## What This Repo Does

This repo is the Formify transcription WebSocket server. It accepts browser-recorded WebM/Opus audio over a WebSocket, sends audio chunks to OpenAI Whisper, cleans up the transcript with GPT, then returns either:

- structured form attributes in `forms` mode
- live and final Markdown notes in `notes` mode

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

- `app.ts`: WebSocket server on port `5551`; connection lifecycle, optional origin check, JWT verification, mode routing.
- `types.ts`: WebSocket message types, shared constants, handler interfaces, audio state shapes.
- `handlers/FormFillHandler.ts`: `forms` mode implementation; buffers audio, transcribes, revises, extracts fields, sends incremental/final attributes.
- `handlers/NotesHandler.ts`: `notes` mode implementation; buffers audio, transcribes, revises, updates Markdown notes, sends incremental/final notes.
- `transcription.ts`: WebM validation/header handling, Whisper API call, transcript overlap merge.
- `parse-gpt.ts`: OpenAI GPT prompts and calls for transcript revision, field extraction, final verification, note generation.
- `ws-token.ts`: JWT mint/verify helpers for WebSocket session tokens.
- `parse-groq.ts`: older Groq-based parser path; not used by the active handlers.
- `load/`: WebSocket load-test harness.
- `test/`: local WebSocket test clients.
- `unused/`: currently untracked/unused modules moved out of active compilation.

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
- `GROQ_API_KEY`: only relevant to the older `parse-groq.ts` path.

## WebSocket Contract

The client connects to the WebSocket server, sends JSON text control messages, and streams binary audio frames.

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

## Audio And Parsing Flow

1. Client sends `start`; server verifies the JWT and selects the handler.
2. Client streams WebM/Opus chunks as binary WebSocket frames.
3. Handler buffers chunks until `MIN_CHUNK_NUM`.
4. Handler snapshots the buffer and processes it sequentially.
5. Whisper transcribes the audio buffer.
6. GPT revises the transcript segment.
7. Forms mode extracts attributes; notes mode updates Markdown notes.
8. Server sends incremental updates.
9. On `stop`, queued work drains, remaining audio is processed, and a final GPT pass runs.

## Safe-Change Rules

- Before code edits, check `TASKS.md` and work only on the requested ticket ID.
- After code edits, update `TASKS.md`; update `DECISIONS.md` only when a real technical decision changes.
- Do not weaken WebSocket auth. Dev/test clients may mint local tokens using `WS_TOKEN_SECRET`, but production browser code must not.
- Keep WebSocket payload changes coordinated with the Formify web app.
- Avoid broad refactors in handlers unless also adding ordering tests; handler queues currently rely on sequential mutation.
- Preserve ESM-compatible imports for built output.
- Keep pnpm as the package manager; do not reintroduce `package-lock.json`.
- Prefer small, typed protocol changes in `types.ts` before changing runtime payloads.
- Do not wire unused cache/cost modules back in without a specific design.
- Run `pnpm build` after TypeScript changes.

## Known Risks

- Final GPT passes currently use a fixed character limit and preserve the beginning/end of long transcripts while dropping the middle.
- Handler queues are intentionally concurrency `1`; increasing concurrency can corrupt transcript, attributes, or notes ordering unless sequence guards are added.
- `corrected_audio` is not currently sent in form update/final messages. Reintroducing it needs frontend coordination.
- Tests and load tests require a running WebSocket server.
- Load tests exercise real OpenAI calls unless mocked elsewhere, so they can incur cost.
- `parse-groq.ts` remains as an unused alternate path and may drift from the active OpenAI implementation.
- `unused/` contains non-active modules and should not be assumed part of the runtime.
