import { describe, expect, it } from "vitest";
import type { RetryPolicy } from "../src/config";
import { backoffDelayMs, classifyResult, planNextStep } from "../src/delivery/retry-policy";
import type { SendResult } from "../src/delivery/webhook-sender";

const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

const response = (status: number): SendResult => ({ kind: "response", status, bodyExcerpt: "" });

describe("classifyResult", () => {
  it.each([200, 201, 202, 204])("treats HTTP %i as delivered", (status) => {
    expect(classifyResult(response(status))).toBe("succeeded");
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i", (status) => {
    expect(classifyResult(response(status))).toBe("retryable_failure");
  });

  it.each([301, 302, 400, 401, 403, 404, 410, 422])("does not retry HTTP %i", (status) => {
    expect(classifyResult(response(status))).toBe("permanent_failure");
  });

  it("retries timeouts and network errors", () => {
    expect(classifyResult({ kind: "timeout", timeoutMs: 5000 })).toBe("retryable_failure");
    expect(classifyResult({ kind: "network_error", message: "ECONNREFUSED" })).toBe(
      "retryable_failure",
    );
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and stays between half and all of the exponential delay", () => {
    const highest = [1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, policy, () => 1));
    const lowest = [1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, policy, () => 0));

    expect(highest).toEqual([1000, 2000, 4000, 8000]);
    expect(lowest).toEqual([500, 1000, 2000, 4000]);
  });

  it("never exceeds the maximum delay", () => {
    expect(backoffDelayMs(50, policy, () => 1)).toBe(30_000);
  });
});

describe("planNextStep", () => {
  const random = () => 1;

  it("completes on success", () => {
    expect(planNextStep("succeeded", 1, policy)).toEqual({ kind: "succeed" });
  });

  it("schedules a retry while attempts remain", () => {
    expect(planNextStep("retryable_failure", 2, policy, { random })).toEqual({
      kind: "retry",
      delayMs: 2000,
    });
  });

  it("gives up when the final attempt fails", () => {
    expect(planNextStep("retryable_failure", 5, policy, { random })).toEqual({
      kind: "give_up",
      reason: "attempts_exhausted",
    });
  });

  it("gives up immediately on a non-retryable failure", () => {
    expect(planNextStep("permanent_failure", 1, policy)).toEqual({
      kind: "give_up",
      reason: "non_retryable",
    });
  });

  it("waits at least as long as Retry-After, but no longer than the maximum delay", () => {
    expect(planNextStep("retryable_failure", 1, policy, { random, retryAfterMs: 10_000 })).toEqual({
      kind: "retry",
      delayMs: 10_000,
    });
    expect(planNextStep("retryable_failure", 1, policy, { random, retryAfterMs: 600_000 })).toEqual(
      { kind: "retry", delayMs: 30_000 },
    );
  });
});
