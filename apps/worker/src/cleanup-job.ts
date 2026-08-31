import { CLEANUP_TARGETS, type CleanupJob } from "@packetchat/jobs";
import { DEFAULT_RETENTION, runCleanup, type CleanupDeps, type CleanupTarget, type RetentionPolicy } from "./cleanup";
import { createCleanupDeps } from "./cleanup-deps";

// Mirrors the private TARGET_DAYS map in ./cleanup, which is not exported.
const RETENTION_KEYS: Record<CleanupTarget, keyof RetentionPolicy> = {
  "job-failures": "jobFailuresDays",
  "completed-runs": "completedRunsDays",
  "orphan-attachments": "orphanAttachmentsDays"
};

export type CleanupJobReport = {
  targets: CleanupTarget[];
  deleted: Partial<Record<CleanupTarget, number>>;
  cutoffs: Partial<Record<CleanupTarget, string>>;
};

/**
 * "all" fans out to every target; anything else must be one of the three known
 * targets. An unrecognised value throws rather than being skipped, so a payload
 * from a stale producer fails the job instead of quietly cleaning nothing.
 */
export function selectCleanupTargets(target: CleanupJob["target"]): CleanupTarget[] {
  if (target === "all") return [...CLEANUP_TARGETS];
  if (!(CLEANUP_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`Unknown cleanup target: ${String(target)}`);
  }
  return [target];
}

/**
 * olderThanDays overrides the retention window of every selected target. It must
 * be a whole number of days and at least 1: zero or negative would put the
 * cutoff at or after now and sweep live rows.
 */
export function resolveRetentionPolicy(targets: CleanupTarget[], olderThanDays?: number): RetentionPolicy {
  if (olderThanDays === undefined) return DEFAULT_RETENTION;
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new Error(`Invalid olderThanDays: ${String(olderThanDays)}`);
  }

  const policy = { ...DEFAULT_RETENTION };
  for (const target of targets) {
    policy[RETENTION_KEYS[target]] = olderThanDays;
  }
  return policy;
}

/**
 * runCleanup always walks all three targets. Wrapping the deps rather than the
 * orchestration keeps a single-target job from touching the other two: an
 * unselected target lists nothing and deletes nothing.
 */
export function restrictCleanupTargets(deps: CleanupDeps, targets: CleanupTarget[]): CleanupDeps {
  const selected = new Set(targets);
  return {
    now: deps.now,
    listExpired: async (target, cutoff) => (selected.has(target) ? deps.listExpired(target, cutoff) : []),
    deleteByIds: async (target, ids) => (selected.has(target) ? deps.deleteByIds(target, ids) : 0)
  };
}

// Skipped targets come back from runCleanup as zero, which would read as "we
// checked and found nothing". Report only what was actually selected.
function pickSelected<T>(values: Record<CleanupTarget, T>, targets: CleanupTarget[]): Partial<Record<CleanupTarget, T>> {
  const picked: Partial<Record<CleanupTarget, T>> = {};
  for (const target of targets) {
    picked[target] = values[target];
  }
  return picked;
}

export async function runCleanupJob(job: CleanupJob, deps: CleanupDeps = createCleanupDeps()): Promise<CleanupJobReport> {
  const targets = selectCleanupTargets(job.target);
  const policy = resolveRetentionPolicy(targets, job.olderThanDays);
  const summary = await runCleanup(restrictCleanupTargets(deps, targets), policy);

  return {
    targets,
    deleted: pickSelected(summary.deleted, targets),
    cutoffs: pickSelected(summary.cutoffs, targets)
  };
}
