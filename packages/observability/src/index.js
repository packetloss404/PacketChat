const levelOrder = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};
function currentLevel() {
    const level = process.env.LOG_LEVEL;
    return level && level in levelOrder ? level : "info";
}
function write(level, message, fields = {}) {
    if (levelOrder[level] < levelOrder[currentLevel()])
        return;
    const entry = {
        ts: new Date().toISOString(),
        level,
        service: process.env.SERVICE_NAME ?? "packetchat",
        message,
        ...fields
    };
    const line = JSON.stringify(entry);
    if (level === "error")
        console.error(line);
    else if (level === "warn")
        console.warn(line);
    else
        console.log(line);
}
export const logger = {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
};
export function getRequestId(headers) {
    return headers.get("x-request-id") ?? crypto.randomUUID();
}
