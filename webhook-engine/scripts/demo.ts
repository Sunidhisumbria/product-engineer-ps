import { setTimeout as sleep } from "node:timers/promises";
import type { ReceivedDelivery, ReceiverMode } from "../receiver/app";
import { loadConfig, loadDotEnv } from "../src/config";
import { describeError } from "../src/errors";

loadDotEnv();
const config = loadConfig();
const apiUrl = process.env.API_URL ?? `http://localhost:${config.port}`;
const receiverUrl = process.env.RECEIVER_URL ?? new URL(config.webhookUrl).origin;

type AttemptView = {
  attemptNumber: number;
  outcome: string;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  finishedAt: string | null;
};

type EventView = {
  eventId: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  attempts: AttemptView[];
};

const isTerminal = (event: EventView) => event.status === "succeeded" || event.status === "failed";

const scenarios: Record<string, { description: string; run: () => Promise<void> }> = {
  success: {
    description: "Receiver returns 200; delivered on the first attempt",
    run: () => deliverWithReceiver("success", { mode: "ok" }),
  },
  retry: {
    description: "Receiver fails twice with 503, then succeeds",
    run: () => deliverWithReceiver("retry", { mode: "fail_then_ok", failures: 2 }),
  },
  exhausted: {
    description: `Receiver always returns 503; gives up after ${config.retry.maxAttempts} attempts`,
    run: () => deliverWithReceiver("exhausted", { mode: "always_fail", status: 503 }),
  },
  rejected: {
    description: "Receiver returns 400; not retried",
    run: () => deliverWithReceiver("rejected", { mode: "reject", status: 400 }),
  },
  duplicate: {
    description: "Same event submitted concurrently and again later; delivered once",
    run: duplicateScenario,
  },
  timeout: {
    description: "Receiver processes the event but answers after the timeout; delivered twice",
    run: timeoutScenario,
  },
};

async function deliverWithReceiver(name: string, mode: ReceiverMode) {
  await setReceiverMode(mode);
  const eventId = newEventId(name);
  await submit(eventBody(eventId), "POST /events");
  const event = await watch(eventId, isTerminal);
  printFinalState(event);
  await printReceiverView(eventId);
}

async function duplicateScenario() {
  await setReceiverMode({ mode: "ok" });
  const eventId = newEventId("duplicate");
  const body = eventBody(eventId);

  const statuses = await Promise.all(Array.from({ length: 5 }, () => post(body)));
  console.log(`5 concurrent POST /events for ${eventId} -> ${statuses.join(", ")}`);

  const event = await watch(eventId, isTerminal);
  printFinalState(event);

  await submit(body, "POST /events again after delivery");
  await submit(
    { ...body, payload: { ...body.payload, severity: "low" } },
    "POST /events same eventId, different payload",
  );

  await sleep(config.worker.pollIntervalMs * 3);
  await printReceiverView(eventId);
}

async function timeoutScenario() {
  await setReceiverMode({
    mode: "slow_then_ok",
    delayMs: config.worker.requestTimeoutMs + 250,
    slowRequests: 1,
  });
  const eventId = newEventId("timeout");
  await submit(eventBody(eventId), "POST /events");

  const event = await watch(eventId, isTerminal);
  printFinalState(event);

  await sleep(500);
  await printReceiverView(eventId);
  console.log("The receiver accepted attempt 1 after the sender had already timed out, so attempt 2 is a");
  console.log("duplicate delivery. Receivers should deduplicate on the Webhook-Id header.");
}

async function watch(eventId: string, until: (event: EventView) => boolean): Promise<EventView> {
  const deadline = Date.now() + 120_000;
  let printed = 0;

  for (;;) {
    const event = await getJson<EventView>(`${apiUrl}/events/${encodeURIComponent(eventId)}`);
    const finished = event.attempts.filter((attempt) => attempt.outcome !== "in_progress");
    for (const attempt of finished.slice(printed)) printAttempt(attempt, event);
    printed = finished.length;

    if (until(event)) return event;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${eventId} (${event.status})`);
    await sleep(250);
  }
}

function printAttempt(attempt: AttemptView, event: EventView) {
  const result = attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : (attempt.error ?? "");
  const duration = attempt.durationMs === null ? "" : `${attempt.durationMs}ms`;
  const next =
    event.status === "pending" &&
    attempt.attemptNumber === event.attemptCount &&
    event.nextAttemptAt &&
    attempt.finishedAt
      ? `-> retry in ${Date.parse(event.nextAttemptAt) - Date.parse(attempt.finishedAt)}ms`
      : "";
  console.log(
    `  attempt ${attempt.attemptNumber}  ${attempt.outcome.padEnd(17)}  ${result.padEnd(22)}  ${duration.padStart(7)}  ${next}`,
  );
}

function printFinalState(event: EventView) {
  console.log(
    `Final state: ${event.status} after ${event.attemptCount} attempt(s)` +
      (event.lastError ? ` -- ${event.lastError}` : ""),
  );
}

async function printReceiverView(eventId: string) {
  const deliveries = await getJson<ReceivedDelivery[]>(
    `${receiverUrl}/deliveries?webhookId=${encodeURIComponent(eventId)}`,
  );
  console.log(`Receiver saw ${deliveries.length} request(s) for ${eventId}:`);
  for (const delivery of deliveries) {
    console.log(
      `  Webhook-Attempt ${delivery.attempt} -> responded ${delivery.respondedWith}` +
        (delivery.duplicate ? "  (duplicate of an already accepted delivery)" : ""),
    );
  }
}

function newEventId(name: string) {
  return `evt_${name}_${Date.now().toString(36)}`;
}

function eventBody(eventId: string) {
  return {
    eventId,
    type: "incident.created",
    occurredAt: new Date().toISOString(),
    payload: { incidentId: "inc_456", severity: "high" },
  };
}

async function submit(body: unknown, label: string) {
  const status = await post(body);
  console.log(`${label} -> ${status}`);
}

async function post(body: unknown): Promise<number> {
  const response = await fetch(`${apiUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.body?.cancel();
  return response.status;
}

async function setReceiverMode(mode: ReceiverMode) {
  const response = await fetch(`${receiverUrl}/mode`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode),
  });
  if (!response.ok) throw new Error(`Could not set receiver mode: HTTP ${response.status}`);
  console.log(`Receiver mode: ${JSON.stringify(await response.json())}`);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

const name = process.argv[2];
const scenario = name ? scenarios[name] : undefined;

if (!scenario) {
  console.log("Usage: npm run demo -- <scenario>\n");
  for (const [key, { description }] of Object.entries(scenarios)) {
    console.log(`  ${key.padEnd(10)} ${description}`);
  }
  process.exitCode = name ? 1 : 0;
} else {
  console.log(`== ${name}: ${scenario.description}\n`);
  try {
    await scenario.run();
  } catch (error) {
    console.error(
      `\nDemo failed: ${describeError(error)}` +
        "\nAre the API (npm run dev) and receiver (npm run receiver) both running?",
    );
    process.exitCode = 1;
  }
}
