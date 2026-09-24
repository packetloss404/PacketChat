export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type ApprovalDecision = "approved" | "rejected";

export type StepSnapshot = {
  sequenceNo: number;
  stepType: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output?: { decision?: ApprovalDecision } | null;
};

export type RunSnapshot = {
  id: string;
  status: RunStatus;
};

export type ResumeState =
  | { kind: "blocked"; pendingApprovalSeq: number }
  | { kind: "resume"; fromSequenceNo: number }
  | { kind: "halt"; reason: "rejected" | "terminal" };

/**
 * What a resumed run needs to pick up where the paused one left off.
 *
 * `approvalSequenceNo` is the sequence number of the approval step the caller
 * just resolved; zero means "no approval was involved" (a fresh run). The
 * executor only treats the run as a resume when this is greater than zero.
 * `nextSequenceNo` continues the run's `unique (run_id, sequence_no)` step
 * numbering instead of restarting at 1 and colliding with the paused steps.
 */
export type ExecuteRunResume = {
  approvalSequenceNo: number;
  nextSequenceNo: number;
};

export type ResumePlan =
  | { kind: "blocked"; pendingApprovalSeq: number }
  | { kind: "halt"; reason: "rejected" | "terminal" }
  | { kind: "resume"; approvalSequenceNo: number; nextSequenceNo: number };

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);

const APPROVAL_STEP_TYPE = "approval";

function isApprovalStep(step: StepSnapshot): boolean {
  return step.stepType === APPROVAL_STEP_TYPE;
}

export function computeResumeState(run: RunSnapshot, steps: StepSnapshot[]): ResumeState {
  if (TERMINAL_STATUSES.has(run.status)) {
    return { kind: "halt", reason: "terminal" };
  }

  const approvalSteps = steps.filter(isApprovalStep);

  const runningApproval = approvalSteps.find((step) => step.status === "running");
  if (runningApproval) {
    return { kind: "blocked", pendingApprovalSeq: runningApproval.sequenceNo };
  }

  if (approvalSteps.length === 0) {
    return { kind: "resume", fromSequenceNo: 0 };
  }

  const latestApproval = approvalSteps.reduce((latest, step) =>
    step.sequenceNo > latest.sequenceNo ? step : latest
  );

  if (latestApproval.output?.decision === "rejected") {
    return { kind: "halt", reason: "rejected" };
  }

  return { kind: "resume", fromSequenceNo: latestApproval.sequenceNo };
}

export function applyApprovalDecision(
  steps: StepSnapshot[],
  sequenceNo: number,
  decision: ApprovalDecision
): StepSnapshot[] {
  return steps.map((step) => {
    if (step.sequenceNo !== sequenceNo) {
      return step;
    }
    return {
      ...step,
      status: decision === "approved" ? "completed" : "cancelled",
      output: { ...(step.output ?? {}), decision }
    };
  });
}

export function nextSequenceNo(steps: Array<{ sequenceNo: number }>): number {
  return steps.reduce((max, step) => Math.max(max, step.sequenceNo), 0) + 1;
}

/**
 * Turns a step/run snapshot into the action the caller should take. This is the
 * shared state machine for the approval route, the worker's job loader and the
 * in-process fallback: a resolved approved approval resumes, a rejected one
 * halts, a still-running approval blocks, and a terminal run is already over.
 */
export function planResume(run: RunSnapshot, steps: StepSnapshot[]): ResumePlan {
  const state = computeResumeState(run, steps);
  if (state.kind !== "resume") return state;

  return {
    kind: "resume",
    approvalSequenceNo: state.fromSequenceNo,
    nextSequenceNo: nextSequenceNo(steps)
  };
}
