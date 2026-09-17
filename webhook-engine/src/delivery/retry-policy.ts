import type { RetryPolicy } from "../config";
import type { SendResult } from "./webhook-sender";

export type AttemptClassification = "succeeded" | "retryable_failure" | "permanent_failure";

export type NextStep =
  | { kind: "succeed" }
  | { kind: "retry"; delayMs: number }
  | { kind: "give_up"; reason: "non_retryable" | "attempts_exhausted" };

export function classifyResult(result: SendResult): AttemptClassification {
  switch (result.kind) {
    case "timeout":
    case "network_error":
      return "retryable_failure";
    case "response":
      if (result.status >= 200 && result.status < 300) return "succeeded";
      if (result.status === 408 || result.status === 429 || result.status >= 500) {
        return "retryable_failure";
      }
      return "permanent_failure";
  }
}

export function backoffDelayMs(
  attemptNumber: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** (attemptNumber - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.round(capped / 2 + random() * (capped / 2));
}

export function planNextStep(
  classification: AttemptClassification,
  attemptNumber: number,
  policy: RetryPolicy,
  options: { retryAfterMs?: number; random?: () => number } = {},
): NextStep {
  if (classification === "succeeded") return { kind: "succeed" };
  if (classification === "permanent_failure") return { kind: "give_up", reason: "non_retryable" };
  if (attemptNumber >= policy.maxAttempts) return { kind: "give_up", reason: "attempts_exhausted" };

  const backoff = backoffDelayMs(attemptNumber, policy, options.random);
  const delayMs = Math.min(Math.max(backoff, options.retryAfterMs ?? 0), policy.maxDelayMs);
  return { kind: "retry", delayMs };
}
