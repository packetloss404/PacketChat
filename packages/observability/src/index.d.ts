export type LogFields = Record<string, unknown>;
export declare const logger: {
    debug: (message: string, fields?: LogFields) => void;
    info: (message: string, fields?: LogFields) => void;
    warn: (message: string, fields?: LogFields) => void;
    error: (message: string, fields?: LogFields) => void;
};
export declare function getRequestId(headers: Headers): string;
export type AuditAction = "bootstrap.completed" | "auth.login.success" | "auth.login.failure" | "auth.logout" | "auth.refresh.reused" | "user.created" | "user.updated" | "user.byok.updated" | "provider.created" | "provider.tested" | "chat.created" | "agent.published";
export type AuditOutcome = "success" | "failure";
//# sourceMappingURL=index.d.ts.map