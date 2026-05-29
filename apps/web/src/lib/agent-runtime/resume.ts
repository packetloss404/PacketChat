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
