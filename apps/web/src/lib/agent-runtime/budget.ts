export type BudgetReason = "steps" | "tokens" | "time" | "payload";

export class BudgetExceededError extends Error {
  readonly reason: BudgetReason;

  constructor(reason: BudgetReason, message: string) {
    super(message);
    this.name = "BudgetExceededError";
    this.reason = reason;
  }
}

export type RunBudgetLimits = {
  maxSteps: number;
  maxTotalTokens: number;
  maxWallClockMs: number;
  maxPayloadBytes: number;
};

export type RunBudgetSnapshot = {
  steps: number;
  tokens: number;
  payloadBytes: number;
  elapsedMs: number;
  limits: RunBudgetLimits;
};

function clampNonNegative(n: number): number {
  return n > 0 ? n : 0;
}

export class RunBudget {
  private readonly limits: RunBudgetLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private steps = 0;
  private tokens = 0;
  private payloadBytes = 0;

  constructor(limits: RunBudgetLimits, opts?: { now?: () => number }) {
    this.limits = limits;
    this.now = opts?.now ?? Date.now;
    this.startedAt = this.now();
  }

  private elapsedMs(): number {
    return clampNonNegative(this.now() - this.startedAt);
  }

  startStep(): void {
    this.steps += 1;
    this.checkOrThrow();
  }

  recordTokens(n: number): void {
    this.tokens += clampNonNegative(n);
  }

  recordPayloadBytes(n: number): void {
    this.payloadBytes += clampNonNegative(n);
  }

  remainingSteps(): number {
    return clampNonNegative(this.limits.maxSteps - this.steps);
  }

  isExhausted(): boolean {
    return (
      this.steps >= this.limits.maxSteps ||
      this.tokens >= this.limits.maxTotalTokens ||
      this.payloadBytes >= this.limits.maxPayloadBytes ||
      this.elapsedMs() >= this.limits.maxWallClockMs
    );
  }

  checkOrThrow(): void {
    if (this.steps >= this.limits.maxSteps) {
      throw new BudgetExceededError(
        "steps",
        `Step budget exceeded: ${this.steps}/${this.limits.maxSteps}`
      );
    }
    if (this.tokens >= this.limits.maxTotalTokens) {
      throw new BudgetExceededError(
        "tokens",
        `Token budget exceeded: ${this.tokens}/${this.limits.maxTotalTokens}`
      );
    }
    if (this.payloadBytes >= this.limits.maxPayloadBytes) {
      throw new BudgetExceededError(
        "payload",
        `Payload budget exceeded: ${this.payloadBytes}/${this.limits.maxPayloadBytes} bytes`
      );
    }
    const elapsed = this.elapsedMs();
    if (elapsed >= this.limits.maxWallClockMs) {
      throw new BudgetExceededError(
        "time",
        `Wall-clock budget exceeded: ${elapsed}/${this.limits.maxWallClockMs} ms`
      );
    }
  }

  snapshot(): RunBudgetSnapshot {
    return {
      steps: this.steps,
      tokens: this.tokens,
      payloadBytes: this.payloadBytes,
      elapsedMs: this.elapsedMs(),
      limits: { ...this.limits }
    };
  }
}
