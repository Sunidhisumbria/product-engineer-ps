import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReceiverApp, type ReceivedDelivery } from "../receiver/app";
import { createDeliveryWorker } from "../src/delivery/delivery-worker";
import { createHttpWebhookSender } from "../src/delivery/webhook-sender";
import { createApp } from "../src/http/app";
import { silentLogger } from "../src/logger";
import { createDeliveryQueue } from "../src/store/delivery-queue";
import { createEventStore } from "../src/store/event-store";
import { FakeClock, useTestDatabase } from "./helpers";

const sql = useTestDatabase();
const clock = new FakeClock();
const receiver = createReceiverApp(silentLogger);
let receiverServer: ServerType;
let receiverUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    receiverServer = serve({ fetch: receiver.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      receiverUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => receiverServer.close(resolve));
});

describe("end to end", () => {
  it("submits over HTTP, retries a failing receiver, and exposes the history", async () => {
    const api = createApp({ store: createEventStore(sql), clock });
    const worker = createDeliveryWorker({
      queue: createDeliveryQueue(sql),
      sender: createHttpWebhookSender({ url: `${receiverUrl}/webhook`, timeoutMs: 2000 }),
      clock,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10_000 },
      settings: { requestTimeoutMs: 2000, leaseMs: 10_000, pollIntervalMs: 10, batchSize: 10 },
      logger: silentLogger,
      random: () => 1,
    });

    await receiver.request("/mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "fail_then_ok", failures: 1 }),
    });

    const submitted = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "evt_e2e",
        type: "incident.created",
        occurredAt: "2026-09-15T10:00:00Z",
        payload: { incidentId: "inc_456", severity: "high" },
      }),
    });
    expect(submitted.status).toBe(202);

    await worker.runOnce();
    clock.advance(1000);
    await worker.runOnce();

    const history = await (await api.request("/events/evt_e2e")).json();
    expect(history).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
      attempts: [
        { attemptNumber: 1, outcome: "retryable_failure", httpStatus: 503 },
        { attemptNumber: 2, outcome: "succeeded", httpStatus: 200 },
      ],
    });

    const received = (await (
      await receiver.request("/deliveries?webhookId=evt_e2e")
    ).json()) as ReceivedDelivery[];
    expect(received.map(({ attempt, respondedWith }) => ({ attempt, respondedWith }))).toEqual([
      { attempt: 1, respondedWith: 503 },
      { attempt: 2, respondedWith: 200 },
    ]);
  });
});
