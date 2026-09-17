import { beforeEach, describe, expect, it } from "vitest";
import type { RetryPolicy, WorkerSettings } from "../src/config";
import { createDeliveryWorker } from "../src/delivery/delivery-worker";
import type { SendResult, WebhookSender } from "../src/delivery/webhook-sender";
import type { StoredEvent } from "../src/events";
import { acceptEvent } from "../src/ingest/accept-event";
import { silentLogger } from "../src/logger";
import { createDeliveryQueue } from "../src/store/delivery-queue";
import { createEventStore } from "../src/store/event-store";
import { FakeClock, useTestDatabase } from "./helpers";

const sql = useTestDatabase();
const store = createEventStore(sql);
const queue = createDeliveryQueue(sql);

const retryPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };
const settings: WorkerSettings = {
  requestTimeoutMs: 1000,
  leaseMs: 5000,
  pollIntervalMs: 10,
  batchSize: 10,
};

const ok: SendResult = { kind: "response", status: 200, bodyExcerpt: "ok" };
const unavailable: SendResult = { kind: "response", status: 503, bodyExcerpt: "down" };
const badRequest: SendResult = { kind: "response", status: 400, bodyExcerpt: "bad" };

class ScriptedSender implements WebhookSender {
  readonly calls: { eventId: string; attemptNumber: number }[] = [];

  constructor(private readonly results: (SendResult | Promise<SendResult>)[]) {}

  async send(event: StoredEvent, attemptNumber: number): Promise<SendResult> {
    this.calls.push({ eventId: event.eventId, attemptNumber });
    const next = this.results.shift();
    if (!next) throw new Error(`Unexpected send for ${event.eventId}`);
    return next;
  }
}

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock();
});

function workerWith(sender: WebhookSender) {
  return createDeliveryWorker({
    queue,
    sender,
    clock,
    retryPolicy,
    settings,
    logger: silentLogger,
    random: () => 1,
  });
}

async function submit(eventId = "evt_1") {
  return acceptEvent(store, clock, {
    eventId,
    type: "incident.created",
    occurredAt: clock.now(),
    payload: { incidentId: "inc_1" },
  });
}

async function inspect(eventId = "evt_1") {
  const event = await store.findById(eventId);
  const attempts = await store.listAttempts(eventId);
  return { event, attempts };
}

describe("delivery worker", () => {
  it("delivers a pending event and records a successful attempt", async () => {
    await submit();
    const sender = new ScriptedSender([ok]);

    await workerWith(sender).runOnce();

    const { event, attempts } = await inspect();
    expect(sender.calls).toEqual([{ eventId: "evt_1", attemptNumber: 1 }]);
    expect(event).toMatchObject({ status: "succeeded", attemptCount: 1, lastError: null });
    expect(event?.lockedUntil).toBeNull();
    expect(attempts).toMatchObject([
      { attemptNumber: 1, outcome: "succeeded", httpStatus: 200, responseBody: "ok" },
    ]);
  });

  it("retries a temporary failure after the backoff delay and records both attempts", async () => {
    await submit();
    const sender = new ScriptedSender([unavailable, ok]);
    const worker = workerWith(sender);

    await worker.runOnce();
    const afterFailure = await inspect();
    expect(afterFailure.event).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError: "HTTP 503",
      nextAttemptAt: new Date(clock.now().getTime() + 1000),
    });

    await worker.runOnce();
    expect(sender.calls).toHaveLength(1);

    clock.advance(1000);
    await worker.runOnce();

    const { event, attempts } = await inspect();
    expect(event).toMatchObject({ status: "succeeded", attemptCount: 2, lastError: null });
    expect(attempts).toMatchObject([
      { attemptNumber: 1, outcome: "retryable_failure", httpStatus: 503, error: "HTTP 503" },
      { attemptNumber: 2, outcome: "succeeded", httpStatus: 200, error: null },
    ]);
  });

  it("stops retrying once the attempt limit is reached", async () => {
    await submit();
    const sender = new ScriptedSender([unavailable, unavailable, unavailable]);
    const worker = workerWith(sender);

    for (let i = 0; i < 6; i++) {
      await worker.runOnce();
      clock.advance(retryPolicy.maxDelayMs);
    }

    const { event, attempts } = await inspect();
    expect(sender.calls).toHaveLength(3);
    expect(event).toMatchObject({
      status: "failed",
      attemptCount: 3,
      nextAttemptAt: null,
      lastError: "HTTP 503 (gave up after 3 attempts)",
    });
    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      "retryable_failure",
      "retryable_failure",
      "retryable_failure",
    ]);
  });

  it("fails immediately on a non-retryable response", async () => {
    await submit();
    const sender = new ScriptedSender([badRequest]);
    const worker = workerWith(sender);

    await worker.runOnce();
    clock.advance(retryPolicy.maxDelayMs);
    await worker.runOnce();

    const { event } = await inspect();
    expect(sender.calls).toHaveLength(1);
    expect(event).toMatchObject({ status: "failed", lastError: "HTTP 400 (not retryable)" });
  });

  it("delivers a repeatedly submitted event only once", async () => {
    await submit();
    await submit();
    const sender = new ScriptedSender([ok]);
    const worker = workerWith(sender);

    await worker.runOnce();
    await submit();
    clock.advance(retryPolicy.maxDelayMs);
    await worker.runOnce();

    expect(sender.calls).toHaveLength(1);
    expect((await inspect()).event?.status).toBe("succeeded");
  });

  it("never lets two workers claim the same event", async () => {
    for (let i = 1; i <= 20; i++) await submit(`evt_${i}`);

    const [first, second] = await Promise.all([
      queue.claimDue(clock.now(), 15, settings.leaseMs),
      queue.claimDue(clock.now(), 15, settings.leaseMs),
    ]);

    const claimedIds = [...first, ...second].map((event) => event.eventId);
    expect(claimedIds).toHaveLength(20);
    expect(new Set(claimedIds).size).toBe(20);
  });

  it("recovers an event whose worker crashed mid-delivery", async () => {
    await submit();
    await queue.claimDue(clock.now(), 10, settings.leaseMs);

    clock.advance(settings.leaseMs);
    const sender = new ScriptedSender([ok]);
    const worker = workerWith(sender);
    const { recovered } = await worker.runOnce();

    expect(recovered).toBe(1);
    expect((await inspect()).event).toMatchObject({ status: "pending", attemptCount: 1 });

    clock.advance(1000);
    await worker.runOnce();

    const { event, attempts } = await inspect();
    expect(sender.calls).toEqual([{ eventId: "evt_1", attemptNumber: 2 }]);
    expect(event).toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        outcome: "abandoned",
        error: "lease expired before the attempt outcome was recorded",
      },
      { attemptNumber: 2, outcome: "succeeded" },
    ]);
  });

  it("counts an abandoned attempt toward the limit", async () => {
    await submit();
    await sql`UPDATE events SET attempt_count = ${retryPolicy.maxAttempts - 1}`;
    await queue.claimDue(clock.now(), 10, settings.leaseMs);

    clock.advance(settings.leaseMs);
    await workerWith(new ScriptedSender([])).runOnce();

    expect((await inspect()).event).toMatchObject({
      status: "failed",
      lastError: `lease expired before the attempt outcome was recorded (gave up after ${retryPolicy.maxAttempts} attempts)`,
    });
  });

  it("discards the result of a worker whose lease was taken over", async () => {
    await submit();
    let releaseSlowSend!: (result: SendResult) => void;
    let slowSendStarted!: () => void;
    const started = new Promise<void>((resolve) => (slowSendStarted = resolve));
    const slowSender: WebhookSender = {
      send: () => {
        slowSendStarted();
        return new Promise((resolve) => (releaseSlowSend = resolve));
      },
    };

    const slowRun = workerWith(slowSender).runOnce();
    await started;

    clock.advance(settings.leaseMs);
    const healthyWorker = workerWith(new ScriptedSender([ok]));
    await healthyWorker.runOnce();
    clock.advance(1000);
    await healthyWorker.runOnce();

    releaseSlowSend(unavailable);
    await slowRun;

    const { event, attempts } = await inspect();
    expect(event).toMatchObject({ status: "succeeded", attemptCount: 2, lastError: null });
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["abandoned", "succeeded"]);
  });

  it("recovers the event when the sender throws unexpectedly", async () => {
    await submit();
    const brokenSender: WebhookSender = {
      send: async () => {
        throw new Error("bug in sender");
      },
    };

    await workerWith(brokenSender).runOnce();
    expect((await inspect()).event).toMatchObject({ status: "delivering", attemptCount: 1 });

    clock.advance(settings.leaseMs);
    const sender = new ScriptedSender([ok]);
    const worker = workerWith(sender);
    await worker.runOnce();
    clock.advance(1000);
    await worker.runOnce();

    expect((await inspect()).event).toMatchObject({ status: "succeeded", attemptCount: 2 });
  });
});
