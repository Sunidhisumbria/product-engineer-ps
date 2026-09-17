import type { Clock } from "../clock";
import type { RetryPolicy, WorkerSettings } from "../config";
import { describeError } from "../errors";
import type { StoredEvent } from "../events";
import type { Logger } from "../logger";
import type { AttemptCompletion, DeliveryQueue } from "../store/delivery-queue";
import { classifyResult, planNextStep, type NextStep } from "./retry-policy";
import { summarizeResult, type WebhookSender } from "./webhook-sender";

export type DeliveryWorkerDeps = {
  queue: DeliveryQueue;
  sender: WebhookSender;
  clock: Clock;
  retryPolicy: RetryPolicy;
  settings: WorkerSettings;
  logger: Logger;
  random?: () => number;
};

export type DeliveryWorker = ReturnType<typeof createDeliveryWorker>;

const LEASE_EXPIRED_ERROR = "lease expired before the attempt outcome was recorded";

type EventTransition = Pick<AttemptCompletion, "eventStatus" | "nextAttemptAt" | "lastError">;

export function createDeliveryWorker(deps: DeliveryWorkerDeps) {
  const { queue, sender, clock, retryPolicy, settings, logger, random = Math.random } = deps;

  async function runOnce(): Promise<{ recovered: number; claimed: number }> {
    const recovered = await recoverExpiredLeases();
    const claimed = await queue.claimDue(clock.now(), settings.batchSize, settings.leaseMs);
    await Promise.all(claimed.map(deliverSafely));
    return { recovered, claimed: claimed.length };
  }

  async function recoverExpiredLeases(): Promise<number> {
    const now = clock.now();
    const expired = await queue.findExpiredLeases(now, settings.batchSize);
    let recovered = 0;

    for (const event of expired) {
      const attemptNumber = event.attemptCount;
      const step = planNextStep("retryable_failure", attemptNumber, retryPolicy, { random });
      const transition = toEventTransition(step, LEASE_EXPIRED_ERROR, attemptNumber, now);
      const applied = await queue.completeAttempt({
        eventId: event.eventId,
        attemptNumber,
        finishedAt: now,
        durationMs: null,
        outcome: "abandoned",
        httpStatus: null,
        error: LEASE_EXPIRED_ERROR,
        responseBody: null,
        ...transition,
      });
      if (!applied) continue;

      recovered++;
      logger.warn("attempt_abandoned", {
        event: event.eventId,
        attempt: attemptNumber,
        status: transition.eventStatus,
        next_attempt_at: transition.nextAttemptAt?.toISOString(),
      });
    }
    return recovered;
  }

  async function deliverSafely(event: StoredEvent): Promise<void> {
    try {
      await deliver(event);
    } catch (error) {
      logger.error("delivery_crashed", {
        event: event.eventId,
        attempt: event.attemptCount,
        error: describeError(error),
      });
    }
  }

  async function deliver(event: StoredEvent): Promise<void> {
    const attemptNumber = event.attemptCount;
    const startedAt = clock.now();
    const result = await sender.send(event, attemptNumber);
    const finishedAt = clock.now();

    const classification = classifyResult(result);
    const retryAfterMs = result.kind === "response" ? result.retryAfterMs : undefined;
    const step = planNextStep(classification, attemptNumber, retryPolicy, { retryAfterMs, random });
    const summary = summarizeResult(result);
    const transition = toEventTransition(step, summary, attemptNumber, finishedAt);

    const applied = await queue.completeAttempt({
      eventId: event.eventId,
      attemptNumber,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outcome: classification,
      httpStatus: result.kind === "response" ? result.status : null,
      error: classification === "succeeded" ? null : summary,
      responseBody: result.kind === "response" ? result.bodyExcerpt : null,
      ...transition,
    });

    const fields = { event: event.eventId, attempt: attemptNumber, result: summary };
    if (!applied) {
      logger.warn("stale_attempt_result_discarded", fields);
      return;
    }

    switch (step.kind) {
      case "succeed":
        logger.info("delivery_succeeded", fields);
        break;
      case "retry":
        logger.warn("delivery_retry_scheduled", { ...fields, retry_in_ms: step.delayMs });
        break;
      case "give_up":
        logger.error("delivery_failed", { ...fields, reason: step.reason });
        break;
    }
  }

  function start(): { stop(): Promise<void> } {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> = Promise.resolve();

    async function loop(): Promise<void> {
      let batchWasFull = false;
      try {
        const { claimed } = await runOnce();
        batchWasFull = claimed === settings.batchSize;
      } catch (error) {
        logger.error("worker_tick_failed", { error: describeError(error) });
      }
      if (stopped) return;
      timer = setTimeout(() => {
        running = loop();
      }, batchWasFull ? 0 : settings.pollIntervalMs);
    }

    running = loop();

    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  return { runOnce, start };
}

function toEventTransition(
  step: NextStep,
  summary: string,
  attemptNumber: number,
  now: Date,
): EventTransition {
  switch (step.kind) {
    case "succeed":
      return { eventStatus: "succeeded", nextAttemptAt: null, lastError: null };
    case "retry":
      return {
        eventStatus: "pending",
        nextAttemptAt: new Date(now.getTime() + step.delayMs),
        lastError: summary,
      };
    case "give_up":
      return {
        eventStatus: "failed",
        nextAttemptAt: null,
        lastError:
          step.reason === "non_retryable"
            ? `${summary} (not retryable)`
            : `${summary} (gave up after ${attemptNumber} attempts)`,
      };
  }
}
