import postgres from "postgres";
import { getConfig } from "@packetchat/config";
let client;
export function getSql() {
    if (!client) {
        const config = getConfig();
        client = postgres(config.DATABASE_URL, {
            max: 10,
            idle_timeout: 20,
            connect_timeout: 10,
            prepare: false
        });
    }
    return client;
}
export async function checkDatabase() {
    const sql = getSql();
    await sql `select 1`;
}
export async function closeDatabase() {
    if (client) {
        await client.end({ timeout: 5 });
        client = undefined;
    }
}
export async function recordAuditEvent(input) {
    const sql = getSql();
    await sql `
    insert into audit_events (
      actor_user_id,
      action,
      outcome,
      target_type,
      target_id,
      ip_address,
      user_agent,
      metadata
    ) values (
      ${input.actorUserId ?? null},
      ${input.action},
      ${input.outcome ?? "success"},
      ${input.targetType ?? null},
      ${input.targetId ?? null},
      ${input.ipAddress ?? null},
      ${input.userAgent ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
  `;
}
export { default as postgres } from "postgres";
