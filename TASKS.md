# Tasks

Use this file as the working ticket list for future AI-agent turns. Work on only the requested ticket ID.

## Completed

### T-001 Fix test-client ESM/ts-node import issue

- Status: Done
- Risk: Low
- Summary: Test clients now match the current WebSocket auth contract by sending `mode` and JWT `token`. `test-client` runs with `tsx`, so source files can keep ESM-style `.js` imports such as `../ws-token.js` without creating root `.js` files.
- Validation: `pnpm build` passed. `pnpm test-client` reached the WebSocket connection step; with no server running it reports `ECONNREFUSED`, which is expected.
- Notes: Requires `WS_TOKEN_SECRET` in `.env` and a running server for a full success path.

### T-002 Improve load-test failure logging and default WS_URL

- Status: Done
- Risk: Low
- Summary: Load tests now default to `ws://localhost:5551`, allow `WS_URL`, print that the server must be started separately, and report per-VU failure reasons such as `connection-error`, `auth-failure`, `server-error`, `timeout`, or `unexpected-close`.
- Validation: `pnpm build` passed. `pnpm load-test -- -c 2 -r 1 -d 5` reports clear `ECONNREFUSED` failures when the server is not running.
- Notes: Load tests still exercise real API paths when the server is running.

### T-003 Verify WS_TOKEN_SECRET fails closed

- Status: Done
- Risk: Low
- Summary: Added a focused auth test that starts the built WebSocket server and verifies missing `WS_TOKEN_SECRET`, missing token, invalid token, expired token, and token mode mismatch all fail closed. Also verifies a valid token with matching mode reaches `started`.
- Validation: `pnpm build` passed. `pnpm test-auth` passed with all six auth cases.
- Notes: Test does not stream audio or call OpenAI.

## Active

### T-004 Smoke test mode/token WebSocket start flow

- Status: Active
- Risk: Low
- Goal: With the WebSocket server running, verify that a valid token plus `mode: "forms"` reaches `started`, a valid token plus `mode: "notes"` reaches `started`, invalid/missing tokens are rejected, `stop` can be sent without crashing, and `test-client`/`load-test` reach expected connection/auth behavior.
- Validation:
  - `pnpm build`
  - `pnpm test-auth`
  - `pnpm test-client` with server running
  - `pnpm load-test -- -c 2 -r 1 -d 5` with server running
- Notes: Do not change application code unless the smoke test reveals a confirmed bug. Full audio processing may call OpenAI APIs.

## Backlog

### T-005 Later: long-session transcript chunking strategy

- Status: Backlog
- Risk: Medium
- Goal: Replace the current final-pass beginning/end transcript truncation with chunked processing or rolling summaries for long sessions.
- Notes: Needs product/frontend expectations for long recordings before implementation.
