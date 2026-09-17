import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app";
import { createEventStore } from "../src/store/event-store";
import { FakeClock, useTestDatabase } from "./helpers";

const sql = useTestDatabase();
const clock = new FakeClock();
const app = createApp({ store: createEventStore(sql), clock });

const event = {
  eventId: "evt_123",
  type: "incident.created",
  occurredAt: "2026-09-15T10:00:00Z",
  payload: { incidentId: "inc_456", severity: "high", service_name: "checkout" },
};

function submit(body: unknown) {
  return app.request("/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getEvent(eventId: string) {
  const response = await app.request(`/events/${eventId}`);
  return (await response.json()) as { payload: Record<string, unknown>; attempts: unknown[] };
}

async function countEvents(eventId: string) {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM events WHERE event_id = ${eventId}
  `;
  return row?.count;
}

describe("event ingestion", () => {
  it("accepts a new event as pending and due immediately", async () => {
    const response = await submit(event);

    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe("/events/evt_123");
    expect(await response.json()).toMatchObject({
      eventId: "evt_123",
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: clock.now().toISOString(),
    });

    const stored = await getEvent("evt_123");
    expect(stored.payload).toEqual(event.payload);
    expect(stored.attempts).toEqual([]);
  });

  it("returns the existing event when the same event is submitted again", async () => {
    const first = await submit(event);
    const second = await submit(event);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ eventId: "evt_123", status: "pending" });
    expect(await countEvents("evt_123")).toBe(1);
  });

  it("creates exactly one event when identical submissions race", async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => submit(event)));
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
    expect(await countEvents("evt_123")).toBe(1);
  });

  it("rejects a reused event id with different content and keeps the original", async () => {
    await submit(event);
    const response = await submit({ ...event, payload: { ...event.payload, severity: "low" } });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "event_id_conflict" });

    const stored = await getEvent("evt_123");
    expect(stored.payload.severity).toBe("high");
  });

  it("treats the same payload with reordered keys as a duplicate", async () => {
    await submit(event);
    const response = await submit({
      ...event,
      payload: { service_name: "checkout", severity: "high", incidentId: "inc_456" },
    });

    expect(response.status).toBe(200);
  });

  it("rejects an invalid event without storing it", async () => {
    const response = await submit({ ...event, eventId: "", occurredAt: "yesterday" });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: { path: string }[] };
    expect(body.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["eventId", "occurredAt"]),
    );
    expect(await countEvents("")).toBe(0);
  });

  it("rejects malformed JSON with a JSON error body", async () => {
    const response = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_request" });
  });

  it("returns 404 for an unknown event", async () => {
    const response = await app.request("/events/evt_missing");
    expect(response.status).toBe(404);
  });
});
