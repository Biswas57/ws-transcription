/**
 * ws-token.ts
 *
 * Short-lived signed tokens that gate WebSocket session access.
 *
 * Flow:
 *   1. Frontend calls tRPC `transcription.getSessionToken` (protectedProcedure)
 *   2. Server mints a JWT signed with WS_TOKEN_SECRET, embedding userId + mode
 *   3. Frontend sends { action: "start", ..., token: "<jwt>" } as first WS message
 *   4. WS server verifies the token, extracts userId/mode, and reads signed metadata
 *      such as recordingSessionId for Notes cap continuity.
 *   5. On success, the session starts; on failure, the server sends error + closes.
 *
 * The secret (WS_TOKEN_SECRET) must be set in both:
 *   - Next.js env  (.env / Vercel env vars)
 *   - WS server env (.env in ws-transcription/)
 *
 * Tokens expire in 2 minutes — enough for page load -> connect -> start,
 * but short enough to be useless if leaked.
 */

import jwt from "jsonwebtoken";

const TTL_SECONDS = 120; // 2 minutes

export interface WSTokenPayload {
    userId: string;
    mode: "forms" | "notes";
    recordingSessionId?: string;
    /** issued-at — used to detect replay beyond TTL */
    iat?: number;
    exp?: number;
}

function getSecret(): string {
    const secret = process.env.WS_TOKEN_SECRET;
    if (!secret) throw new Error("WS_TOKEN_SECRET is not set");
    return secret;
}

/**
 * Mint a signed session token.
 * Call this from the tRPC router (Next.js side) only.
 */
export function mintWSToken(
    userId: string,
    mode: "forms" | "notes",
    recordingSessionId?: string
): string {
    const payload: Omit<WSTokenPayload, "iat" | "exp"> = {
        userId,
        mode,
        ...(mode === "notes" && recordingSessionId ? { recordingSessionId } : {}),
    };

    return jwt.sign(payload, getSecret(), {
        expiresIn: TTL_SECONDS,
    });
}

/**
 * Verify and decode a session token.
 * Call this from the WS server only.
 * Throws if invalid, expired, or secret missing.
 */
export function verifyWSToken(token: string): WSTokenPayload {
    return jwt.verify(token, getSecret()) as WSTokenPayload;
}
