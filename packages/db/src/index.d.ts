import postgres from "postgres";
export type SqlClient = postgres.Sql;
export declare function getSql(): SqlClient;
export declare function checkDatabase(): Promise<void>;
export declare function closeDatabase(): Promise<void>;
export declare function recordAuditEvent(input: {
    actorUserId?: string | null;
    action: string;
    outcome?: "success" | "failure";
    targetType?: string | null;
    targetId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
}): Promise<void>;
export { default as postgres } from "postgres";
//# sourceMappingURL=index.d.ts.map