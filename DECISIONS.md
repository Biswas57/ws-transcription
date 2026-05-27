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

### Notes AI Post-Processing Over HTTP

- Future notes Summarise/Reorganise actions should use server-to-server HTTP endpoints on `ws-transcription`.
- `formify-web` should call those endpoints from protected tRPC/server code.
- The browser WebSocket protocol remains focused on live audio transcription only.
- Do not duplicate OpenAI/Groq provider logic directly in `formify-web` unless this decision is revisited.
