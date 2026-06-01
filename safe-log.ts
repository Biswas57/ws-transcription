export function safeErrorInfo(err: unknown): string {
    if (!err || typeof err !== "object") return `type=${typeof err}`;

    const obj = err as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
    };

    const parts: string[] = [];
    const name = typeof obj.name === "string" && obj.name ? obj.name : err.constructor?.name;
    if (name) parts.push(`name=${name}`);
    if (typeof obj.code === "string" || typeof obj.code === "number") parts.push(`code=${String(obj.code)}`);
    if (typeof obj.status === "string" || typeof obj.status === "number") parts.push(`status=${String(obj.status)}`);
    if (typeof obj.statusCode === "string" || typeof obj.statusCode === "number") parts.push(`statusCode=${String(obj.statusCode)}`);

    return parts.length > 0 ? parts.join(" ") : "type=object";
}
