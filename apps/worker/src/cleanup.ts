export type RetentionPolicy = {
  jobFailuresDays: number;
  completedRunsDays: number;
  orphanAttachmentsDays: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = {
  jobFailuresDays: 30,
  completedRunsDays: 90,
  orphanAttachmentsDays: 7
};

export type ExpirableRecord = { id: string; createdAt: Date };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export function selectExpired<T extends ExpirableRecord>(records: T[], cutoff: Date): T[] {
  const cutoffTime = cutoff.getTime();
  return records.filter((record) => record.createdAt.getTime() < cutoffTime);
}

export type CleanupTarget = "job-failures" | "completed-runs" | "orphan-attachments";

export type CleanupDeps = {
  now: () => Date;
  listExpired: (target: CleanupTarget, cutoff: Date) => Promise<ExpirableRecord[]>;
  deleteByIds: (target: CleanupTarget, ids: string[]) => Promise<number>;
};

export type CleanupSummary = {
  deleted: Record<CleanupTarget, number>;
  cutoffs: Record<CleanupTarget, string>;
};

const TARGET_DAYS: Record<CleanupTarget, keyof RetentionPolicy> = {
  "job-failures": "jobFailuresDays",
  "completed-runs": "completedRunsDays",
  "orphan-attachments": "orphanAttachmentsDays"
};

export async function runCleanup(
  deps: CleanupDeps,
  policy: RetentionPolicy = DEFAULT_RETENTION
): Promise<CleanupSummary> {
  const now = deps.now();
  const deleted = {} as Record<CleanupTarget, number>;
  const cutoffs = {} as Record<CleanupTarget, string>;

  const targets = Object.keys(TARGET_DAYS) as CleanupTarget[];
  for (const target of targets) {
    const days = policy[TARGET_DAYS[target]];
    const cutoff = computeCutoff(now, days);
    cutoffs[target] = cutoff.toISOString();

    const expired = await deps.listExpired(target, cutoff);
    const ids = expired.map((record) => record.id);

    if (ids.length === 0) {
      deleted[target] = 0;
      continue;
    }

    deleted[target] = await deps.deleteByIds(target, ids);
  }

  return { deleted, cutoffs };
}
