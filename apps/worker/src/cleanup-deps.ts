import { getSql } from "@packetchat/db";
import type { CleanupDeps, CleanupTarget, ExpirableRecord } from "./cleanup";
import { deleteObject } from "@packetchat/files";
import { logger } from "@packetchat/observability";

export type PurgeObject = (bucket: string, key: string) => Promise<void>;

// Deletes run in bounded batches so a large backlog cannot build one giant
// statement or hold row locks for the whole table at once.
const DELETE_BATCH_SIZE = 500;

// A single cleanup pass only ever claims this many rows per target. The job is
// recurring, so a backlog drains over several runs instead of one long delete.
const LIST_LIMIT = 5000;

// agent_runs.status values that mean the run is finished and can never move
// again. Everything else ('queued', 'preparing', 'running', 'waiting_input')
// is still live and must never be deleted.
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "timed_out"];

// attachments.status while the ingestion worker may still be writing to the
// row. Treated as live even past the cutoff.
const IN_FLIGHT_ATTACHMENT_STATUS = "processing";

type ExpiredRow = { id: string; created_at: Date | string };
type IdRow = { id: string };

// Minimal structural view of the postgres.js client: tagged-template queries
// plus the array helper used for `in ${sql(ids)}`. Narrowing it here keeps the
// adapter injectable so the unit tests can drive it without a database.
export type CleanupSql = {
  <T extends readonly unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  (values: string[]): unknown;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRecords(rows: readonly ExpiredRow[]): ExpirableRecord[] {
  return rows.map((row) => ({ id: row.id, createdAt: toDate(row.created_at) }));
}

function chunk(ids: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    batches.push(ids.slice(start, start + size));
  }
  return batches;
}

async function listExpired(sql: CleanupSql, target: CleanupTarget, cutoff: Date): Promise<ExpirableRecord[]> {
  switch (target) {
    case "job-failures": {
      const rows = await sql<ExpiredRow[]>`
        select id, created_at
        from job_failures
        where created_at < ${cutoff}
        order by created_at asc
        limit ${LIST_LIMIT}
      `;
      return toRecords(rows);
    }
    case "completed-runs": {
      // Both timestamps must be past the cutoff: a long-lived run that only
      // finished yesterday is still recent history and stays.
      const rows = await sql<ExpiredRow[]>`
        select id, created_at
        from agent_runs
        where status in ${sql(TERMINAL_RUN_STATUSES)}
          and created_at < ${cutoff}
          and coalesce(ended_at, created_at) < ${cutoff}
        order by created_at asc
        limit ${LIST_LIMIT}
      `;
      return toRecords(rows);
    }
    case "orphan-attachments": {
      // An attachment is only an orphan when nothing owns it: no conversation,
      // no message, and no knowledge document pointing at it. All three
      // foreign keys use `on delete set null`/`cascade`, so a row can outlive
      // its owner without any other trace.
      const rows = await sql<ExpiredRow[]>`
        select a.id, a.created_at
        from attachments as a
        where a.created_at < ${cutoff}
          and a.conversation_id is null
          and a.message_id is null
          and a.status <> ${IN_FLIGHT_ATTACHMENT_STATUS}
          and not exists (
            select 1
            from knowledge_documents kd
            where kd.attachment_id = a.id
          )
        order by a.created_at asc
        limit ${LIST_LIMIT}
      `;
      return toRecords(rows);
    }
    default: {
      const unreachable: never = target;
      throw new Error(`Unknown cleanup target: ${String(unreachable)}`);
    }
  }
}

async function deleteBatch(sql: CleanupSql, target: CleanupTarget, ids: string[], purgeObject: PurgeObject): Promise<number> {
  switch (target) {
    case "job-failures": {
      const rows = await sql<IdRow[]>`
        delete from job_failures
        where id in ${sql(ids)}
        returning id
      `;
      return rows.length;
    }
    case "completed-runs": {
      // The status guard is repeated here: a run listed as terminal cannot go
      // back, but re-checking means a bad or stale id list can never delete a
      // live run.
      const rows = await sql<IdRow[]>`
        delete from agent_runs
        where id in ${sql(ids)}
          and status in ${sql(TERMINAL_RUN_STATUSES)}
        returning id
      `;
      return rows.length;
    }
    case "orphan-attachments": {
      // Orphan-ness can be undone between the list and the delete (a new
      // knowledge document may adopt the attachment), so the predicate is
      // re-evaluated inside the delete.
      //
      // The row carries the only record of its object: bucket and object_key
      // exist nowhere else. Deleting the row first would strand the object in
      // the bucket with nothing left to identify it by, so the object goes
      // first - the same order the knowledge-document delete routes use. An
      // object we fail to delete keeps its row and is retried on the next run,
      // which leaves a recoverable orphan rather than an unattributable one.
      const candidates = await sql<{ id: string; bucket: string; object_key: string }[]>`
        select a.id, a.bucket, a.object_key
        from attachments as a
        where a.id in ${sql(ids)}
          and a.conversation_id is null
          and a.message_id is null
          and a.status <> ${IN_FLIGHT_ATTACHMENT_STATUS}
          and not exists (
            select 1
            from knowledge_documents kd
            where kd.attachment_id = a.id
          )
      `;

      const purged: string[] = [];
      for (const candidate of candidates) {
        try {
          await purgeObject(candidate.bucket, candidate.object_key);
          purged.push(candidate.id);
        } catch (error) {
          logger.warn("Cleanup left an attachment row in place: object delete failed", {
            attachmentId: candidate.id,
            bucket: candidate.bucket,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (purged.length === 0) return 0;

      const rows = await sql<IdRow[]>`
        delete from attachments as a
        where a.id in ${sql(purged)}
          and a.conversation_id is null
          and a.message_id is null
          and a.status <> ${IN_FLIGHT_ATTACHMENT_STATUS}
          and not exists (
            select 1
            from knowledge_documents kd
            where kd.attachment_id = a.id
          )
        returning a.id
      `;
      return rows.length;
    }
    default: {
      const unreachable: never = target;
      throw new Error(`Unknown cleanup target: ${String(unreachable)}`);
    }
  }
}

/**
 * Real database implementation of CleanupDeps.
 *
 * Note: deleting an orphan attachment row does not remove its object from
 * storage. Blob removal is handled by the web delete routes and is out of
 * scope here, so an object whose row is reaped this way is left in the bucket.
 *
 * The default-argument cast is needed because postgres.js overloads one
 * callable for tagged templates and for helpers; CleanupSql keeps only the two
 * shapes this adapter uses.
 */
// Object removal is injected so tests can exercise the delete ordering without
// reaching object storage.
export function createCleanupDeps(
  sql: CleanupSql = getSql() as unknown as CleanupSql,
  purgeObject: PurgeObject = deleteObject
): CleanupDeps {
  return {
    now: () => new Date(),
    listExpired: (target, cutoff) => listExpired(sql, target, cutoff),
    deleteByIds: async (target, ids) => {
      if (ids.length === 0) return 0;

      let deleted = 0;
      for (const batch of chunk(ids, DELETE_BATCH_SIZE)) {
        deleted += await deleteBatch(sql, target, batch, purgeObject);
      }
      return deleted;
    }
  };
}
