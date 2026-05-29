import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BudgetExceededError,
  RunBudget,
  type RunBudgetLimits
} from "./budget";

function makeLimits(overrides?: Partial<RunBudgetLimits>): RunBudgetLimits {
  return {
    maxSteps: 5,
    maxTotalTokens: 1000,
    maxWallClockMs: 10_000,
    maxPayloadBytes: 4096,
    ...overrides
  };
}

function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("startStep trips the steps limit with reason 'steps'", () => {
  const budget = new RunBudget(makeLimits({ maxSteps: 2 }), { now: () => 0 });
  budget.startStep();
  assert.throws(
    () => budget.startStep(),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "steps");
      return true;
    }
  );
});

test("checkOrThrow trips the tokens limit with reason 'tokens'", () => {
  const budget = new RunBudget(makeLimits({ maxTotalTokens: 100 }), { now: () => 0 });
  budget.recordTokens(100);
  assert.throws(
    () => budget.checkOrThrow(),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "tokens");
      return true;
    }
  );
});

test("checkOrThrow trips the payload limit with reason 'payload'", () => {
  const budget = new RunBudget(makeLimits({ maxPayloadBytes: 50 }), { now: () => 0 });
  budget.recordPayloadBytes(75);
  assert.throws(
    () => budget.checkOrThrow(),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "payload");
      return true;
    }
  );
});

test("checkOrThrow trips the time limit with reason 'time' using injected clock", () => {
  const clock = fakeClock([0, 9000]);
  const budget = new RunBudget(makeLimits({ maxWallClockMs: 5000 }), { now: clock });
  assert.throws(
    () => budget.checkOrThrow(),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "time");
      return true;
    }
  );
});

test("checkOrThrow reports the first exceeded reason in order steps, tokens, payload, time", () => {
  const clock = fakeClock([0, 9999]);
  const budget = new RunBudget(
    { maxSteps: 1, maxTotalTokens: 1, maxWallClockMs: 1, maxPayloadBytes: 1 },
    { now: clock }
  );
  // Tokens, payload, and time are all over budget too, but startStep crosses the
  // step limit and checkOrThrow must report "steps" first.
  budget.recordTokens(5);
  budget.recordPayloadBytes(5);
  assert.throws(
    () => budget.startStep(),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.reason, "steps");
      return true;
    }
  );
});

test("remainingSteps tracks consumed steps and clamps to zero", () => {
  const budget = new RunBudget(makeLimits({ maxSteps: 3 }), { now: () => 0 });
  assert.equal(budget.remainingSteps(), 3);
  budget.startStep();
  assert.equal(budget.remainingSteps(), 2);
  budget.startStep();
  assert.equal(budget.remainingSteps(), 1);
});

test("isExhausted is true once any limit is reached", () => {
  const budget = new RunBudget(makeLimits({ maxTotalTokens: 10 }), { now: () => 0 });
  assert.equal(budget.isExhausted(), false);
  budget.recordTokens(10);
  assert.equal(budget.isExhausted(), true);
});

test("negative inputs clamp to zero for tokens and payload", () => {
  const budget = new RunBudget(makeLimits(), { now: () => 0 });
  budget.recordTokens(-50);
  budget.recordPayloadBytes(-100);
  const snap = budget.snapshot();
  assert.equal(snap.tokens, 0);
  assert.equal(snap.payloadBytes, 0);
});

test("snapshot reflects deterministic elapsed time and accumulated counters", () => {
  const clock = fakeClock([1000, 1000, 3500]);
  const budget = new RunBudget(makeLimits({ maxSteps: 10 }), { now: clock });
  budget.startStep();
  budget.recordTokens(40);
  budget.recordPayloadBytes(128);
  const snap = budget.snapshot();
  assert.equal(snap.steps, 1);
  assert.equal(snap.tokens, 40);
  assert.equal(snap.payloadBytes, 128);
  assert.equal(snap.elapsedMs, 2500);
  assert.deepEqual(snap.limits, makeLimits({ maxSteps: 10 }));
});
