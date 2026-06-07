import { createHash } from "crypto";
import { shortHash } from "./safe-log.js";
import { MAX_NOTES_SESSION_MS } from "./types.js";

export const NOTES_RECONNECT_CAP_GRACE_MS = 2 * 60_000;

export type NotesCapWindowState = "active" | "reconnectable" | "closed";

export type NotesCapWindow = {
    recordingSessionId: string;
    capStartedAtMs: number;
    capDeadlineMs: number;
    state: NotesCapWindowState;
    reconnectGraceUntilMs: number;
    lastBackendSessionId?: string;
};

export type NotesCapWindowLease = {
    recordingSessionIdHash: string;
    userHash: string;
    backendSessionId: string;
    capStartedAtMs: number;
    capDeadlineMs: number;
    capWindowReused: boolean;
    expiredOnStart: boolean;
    reason: NotesCapWindowResolveReason;
    markReconnectable: () => void;
    close: () => void;
};

export type NotesCapWindowResolveReason =
    | "no-existing-window"
    | "reused-active"
    | "reused-reconnectable"
    | "expired"
    | "grace-missed"
    | "not-continuation"
    | "closed"
    | "invalid-recording-session-id";

type ResolveInput = {
    userId: string;
    recordingSessionId?: string;
    backendSessionId: string;
    continuationRequested: boolean;
    nowMs?: number;
};

const windows = new Map<string, NotesCapWindow>();

function safeUserHash(userId: string): string {
    return shortHash(`user:${userId}`);
}

function safeRecordingSessionHash(recordingSessionId: string): string {
    return shortHash(`recording:${recordingSessionId}`);
}

function registryKey(userId: string, recordingSessionId: string): string {
    return createHash("sha256")
        .update("notes-cap")
        .update("\0")
        .update(userId)
        .update("\0")
        .update(recordingSessionId)
        .digest("hex");
}

function isValidRecordingSessionId(recordingSessionId: string | undefined): recordingSessionId is string {
    return typeof recordingSessionId === "string" &&
        recordingSessionId.trim().length > 0 &&
        recordingSessionId.length <= 200;
}

function cleanupNotesCapWindows(nowMs = Date.now()): void {
    for (const [key, entry] of windows) {
        if (entry.state === "closed") {
            windows.delete(key);
            continue;
        }

        if (entry.state === "reconnectable" && nowMs > entry.reconnectGraceUntilMs) {
            windows.delete(key);
            continue;
        }

        if (nowMs > entry.capDeadlineMs + NOTES_RECONNECT_CAP_GRACE_MS) {
            windows.delete(key);
        }
    }
}

function makeLease(
    input: ResolveInput & { recordingSessionId: string; nowMs: number },
    key: string,
    entry: NotesCapWindow,
    capWindowReused: boolean,
    expiredOnStart: boolean,
    reason: NotesCapWindowResolveReason
): NotesCapWindowLease {
    const userHash = safeUserHash(input.userId);
    const recordingSessionIdHash = safeRecordingSessionHash(input.recordingSessionId);

    return {
        recordingSessionIdHash,
        userHash,
        backendSessionId: input.backendSessionId,
        capStartedAtMs: entry.capStartedAtMs,
        capDeadlineMs: entry.capDeadlineMs,
        capWindowReused,
        expiredOnStart,
        reason,
        markReconnectable: () => markNotesCapWindowReconnectable(key, input.backendSessionId),
        close: () => closeNotesCapWindow(key, input.backendSessionId),
    };
}

function logResolve(lease: NotesCapWindowLease): void {
    console.log(
        `[${lease.backendSessionId}][notes-cap] Window resolved — ` +
        `userHash: ${lease.userHash}, ` +
        `recordingSessionHash: ${lease.recordingSessionIdHash}, ` +
        `capWindowReused: ${lease.capWindowReused}, ` +
        `expiredOnStart: ${lease.expiredOnStart}, ` +
        `reason: ${lease.reason}, ` +
        `capRemainingMs: ${lease.capDeadlineMs - Date.now()}`
    );
}

export function resolveNotesCapWindow(input: ResolveInput): NotesCapWindowLease | null {
    const nowMs = input.nowMs ?? Date.now();
    cleanupNotesCapWindows(nowMs);

    if (!isValidRecordingSessionId(input.recordingSessionId)) {
        if (input.recordingSessionId !== undefined) {
            console.warn(
                `[${input.backendSessionId}][notes-cap] Ignoring invalid recording session id — ` +
                `chars: ${String(input.recordingSessionId).length}`
            );
        }
        return null;
    }

    const recordingSessionId = input.recordingSessionId;
    const key = registryKey(input.userId, recordingSessionId);
    const existing = windows.get(key);
    const base = { ...input, recordingSessionId, nowMs };

    if (existing) {
        const previousState = existing.state;
        const expiredOnStart = nowMs >= existing.capDeadlineMs;
        const withinGrace = nowMs <= existing.reconnectGraceUntilMs;
        const canReplaceActive =
            input.continuationRequested &&
            previousState === "active";
        const canReconnectWithinGrace =
            input.continuationRequested &&
            previousState === "reconnectable" &&
            withinGrace;

        if (canReplaceActive || canReconnectWithinGrace) {
            existing.state = "active";
            existing.lastBackendSessionId = input.backendSessionId;
            const reason: NotesCapWindowResolveReason = expiredOnStart
                ? "expired"
                : previousState === "reconnectable"
                    ? "reused-reconnectable"
                    : "reused-active";
            const lease = makeLease(base, key, existing, true, expiredOnStart, reason);
            logResolve(lease);
            return lease;
        }

        const reason: NotesCapWindowResolveReason = existing.state === "closed"
            ? "closed"
            : !input.continuationRequested
                ? "not-continuation"
                : "grace-missed";
        const fresh = createFreshWindow(recordingSessionId, nowMs, input.backendSessionId);
        windows.set(key, fresh);
        const lease = makeLease(base, key, fresh, false, false, reason);
        logResolve(lease);
        return lease;
    }

    const fresh = createFreshWindow(recordingSessionId, nowMs, input.backendSessionId);
    windows.set(key, fresh);
    const lease = makeLease(base, key, fresh, false, false, "no-existing-window");
    logResolve(lease);
    return lease;
}

function createFreshWindow(recordingSessionId: string, nowMs: number, backendSessionId: string): NotesCapWindow {
    return {
        recordingSessionId,
        capStartedAtMs: nowMs,
        capDeadlineMs: nowMs + MAX_NOTES_SESSION_MS,
        state: "active",
        reconnectGraceUntilMs: nowMs + NOTES_RECONNECT_CAP_GRACE_MS,
        lastBackendSessionId: backendSessionId,
    };
}

function markNotesCapWindowReconnectable(key: string, backendSessionId: string, nowMs = Date.now()): void {
    cleanupNotesCapWindows(nowMs);
    const entry = windows.get(key);
    if (!entry || entry.state === "closed") return;

    if (entry.lastBackendSessionId !== backendSessionId) {
        console.log(
            `[${backendSessionId}][notes-cap] Stale reconnectable mark ignored — ` +
            `activeBackendSessionId: ${entry.lastBackendSessionId ?? "none"}`
        );
        return;
    }

    entry.state = "reconnectable";
    entry.reconnectGraceUntilMs = nowMs + NOTES_RECONNECT_CAP_GRACE_MS;
    console.log(
        `[${backendSessionId}][notes-cap] Window reconnectable — ` +
        `graceRemainingMs: ${NOTES_RECONNECT_CAP_GRACE_MS}, ` +
        `capRemainingMs: ${entry.capDeadlineMs - nowMs}`
    );
}

function closeNotesCapWindow(key: string, backendSessionId: string): void {
    const entry = windows.get(key);
    if (!entry) return;

    if (entry.lastBackendSessionId !== backendSessionId) {
        console.log(
            `[${backendSessionId}][notes-cap] Stale close ignored — ` +
            `activeBackendSessionId: ${entry.lastBackendSessionId ?? "none"}`
        );
        return;
    }

    entry.state = "closed";
    windows.delete(key);
    console.log(`[${backendSessionId}][notes-cap] Window closed`);
}

export function clearNotesCapWindowsForTest(): void {
    windows.clear();
}

export function getNotesCapWindowForTest(userId: string, recordingSessionId: string): NotesCapWindow | null {
    const entry = windows.get(registryKey(userId, recordingSessionId));
    return entry ? { ...entry } : null;
}

export function markNotesCapWindowReconnectableForTest(
    userId: string,
    recordingSessionId: string,
    backendSessionId: string,
    nowMs = Date.now()
): void {
    markNotesCapWindowReconnectable(registryKey(userId, recordingSessionId), backendSessionId, nowMs);
}

export function closeNotesCapWindowForTest(
    userId: string,
    recordingSessionId: string,
    backendSessionId: string
): void {
    closeNotesCapWindow(registryKey(userId, recordingSessionId), backendSessionId);
}
