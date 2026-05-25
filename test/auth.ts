import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { WebSocket } from "ws";

const WS_URL = process.env.WS_URL ?? "ws://localhost:5551";
const TEST_SECRET = "auth-test-secret";

type ServerHandle = {
    proc: ChildProcessWithoutNullStreams;
    cwd: string;
};

type ServerEnv = {
    wsTokenSecret?: string;
};

type WsResult = {
    messages: Array<{ type?: string; code?: string; mode?: string }>;
    closeCode?: number;
};

function makeToken(mode: "forms" | "notes", expiresIn: SignOptions["expiresIn"] = "120s"): string {
    return jwt.sign({ userId: "auth-test-user", mode }, TEST_SECRET, { expiresIn });
}

async function waitForServer(proc: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("server did not start in time")), 5000);

        proc.stdout.on("data", (chunk: Buffer) => {
            if (chunk.toString("utf8").includes("WebSocket server listening")) {
                clearTimeout(timeout);
                resolve();
            }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            if (text.includes("EADDRINUSE")) {
                clearTimeout(timeout);
                reject(new Error("port 5551 is already in use"));
            }
        });

        proc.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`server exited before startup with code ${String(code)}`));
        });
    });
}

async function startServer(env: ServerEnv): Promise<ServerHandle> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ws-auth-test-"));
    const proc = spawn("node", [path.resolve("dist/app.js")], {
        cwd,
        env: {
            PATH: process.env.PATH ?? "",
            NODE_ENV: "test",
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "unused-auth-test-key",
            ...(env.wsTokenSecret === undefined ? {} : { WS_TOKEN_SECRET: env.wsTokenSecret }),
        },
    });

    await waitForServer(proc);
    return { proc, cwd };
}

async function stopServer(server: ServerHandle): Promise<void> {
    if (!server.proc.killed) server.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1000);
        server.proc.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
    await fs.rm(server.cwd, { recursive: true, force: true });
}

async function sendStart(payload: object): Promise<WsResult> {
    const messages: WsResult["messages"] = [];

    return new Promise<WsResult>((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("WebSocket auth case timed out"));
        }, 3000);

        ws.on("open", () => {
            ws.send(JSON.stringify(payload));
        });

        ws.on("message", (data) => {
            messages.push(JSON.parse(data.toString("utf8")));
            if (messages.at(-1)?.type === "started") {
                ws.close();
            }
        });

        ws.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ messages, closeCode: code });
        });

        ws.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
}

async function withServer(env: ServerEnv, fn: () => Promise<void>): Promise<void> {
    const server = await startServer(env);
    try {
        await fn();
    } finally {
        await stopServer(server);
    }
}

async function expectErrorCase(name: string, env: ServerEnv, payload: object, expectedCode: string): Promise<void> {
    await withServer(env, async () => {
        const result = await sendStart(payload);
        const error = result.messages.find((msg) => msg.type === "error");
        assert(error?.code === expectedCode, `${name}: expected ${expectedCode}, got ${JSON.stringify(result.messages)}`);
        assert(result.closeCode === 1008, `${name}: expected close code 1008, got ${String(result.closeCode)}`);
        console.log(`ok - ${name}`);
    });
}

async function main(): Promise<void> {
    await expectErrorCase(
        "missing WS_TOKEN_SECRET fails closed",
        {},
        { action: "start", mode: "forms", token: makeToken("forms"), blocks: { auth: ["name"] } },
        "invalid-token"
    );

    await expectErrorCase(
        "missing token is rejected",
        { wsTokenSecret: TEST_SECRET },
        { action: "start", mode: "forms", blocks: { auth: ["name"] } },
        "missing-token"
    );

    await expectErrorCase(
        "invalid token is rejected",
        { wsTokenSecret: TEST_SECRET },
        { action: "start", mode: "forms", token: "not-a-jwt", blocks: { auth: ["name"] } },
        "invalid-token"
    );

    await expectErrorCase(
        "expired token is rejected",
        { wsTokenSecret: TEST_SECRET },
        { action: "start", mode: "forms", token: makeToken("forms", "-1s"), blocks: { auth: ["name"] } },
        "invalid-token"
    );

    await expectErrorCase(
        "token mode mismatch is rejected",
        { wsTokenSecret: TEST_SECRET },
        { action: "start", mode: "forms", token: makeToken("notes"), blocks: { auth: ["name"] } },
        "mode-mismatch"
    );

    await withServer({ wsTokenSecret: TEST_SECRET }, async () => {
        const result = await sendStart({
            action: "start",
            mode: "forms",
            token: makeToken("forms"),
            blocks: { auth: ["name"] },
        });
        const started = result.messages.find((msg) => msg.type === "started");
        assert(started?.mode === "forms", `valid token: expected started/forms, got ${JSON.stringify(result.messages)}`);
        console.log("ok - valid token with correct mode reaches started");
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
