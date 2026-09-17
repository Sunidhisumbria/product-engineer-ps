import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpWebhookSender,
  MAX_BODY_EXCERPT_CHARS,
} from "../src/delivery/webhook-sender";
import type { StoredEvent } from "../src/events";

const event: StoredEvent = {
  eventId: "evt_123",
  type: "incident.created",
  occurredAt: new Date("2026-09-15T10:00:00Z"),
  payload: { incidentId: "inc_456", severity: "high" },
  status: "delivering",
  attemptCount: 2,
  nextAttemptAt: null,
  lockedUntil: null,
  lastError: null,
  createdAt: new Date("2026-09-15T10:00:00Z"),
  updatedAt: new Date("2026-09-15T10:00:00Z"),
};

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

const servers: ReturnType<typeof createServer>[] = [];

async function startReceiver(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => handler(request, body, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("HTTP webhook sender", () => {
  it("posts the event with identifying headers and returns the response", async () => {
    let received: { headers: IncomingMessage["headers"]; body: unknown } | undefined;
    const url = await startReceiver((request, body, response) => {
      received = { headers: request.headers, body: JSON.parse(body) };
      response.writeHead(200).end("ok");
    });

    const result = await createHttpWebhookSender({ url, timeoutMs: 1000 }).send(event, 3);

    expect(result).toEqual({ kind: "response", status: 200, bodyExcerpt: "ok" });
    expect(received?.headers["webhook-id"]).toBe("evt_123");
    expect(received?.headers["webhook-attempt"]).toBe("3");
    expect(received?.body).toEqual({
      eventId: "evt_123",
      type: "incident.created",
      occurredAt: "2026-09-15T10:00:00.000Z",
      payload: { incidentId: "inc_456", severity: "high" },
    });
  });

  it("reports a timeout when the receiver does not answer in time", async () => {
    const url = await startReceiver(() => {});

    const result = await createHttpWebhookSender({ url, timeoutMs: 50 }).send(event, 1);

    expect(result).toEqual({ kind: "timeout", timeoutMs: 50 });
  });

  it("reports a network error when nothing is listening", async () => {
    const url = await startReceiver(() => {});
    const [server] = servers.splice(0);
    await new Promise((resolve) => server?.close(resolve));

    const result = await createHttpWebhookSender({ url, timeoutMs: 1000 }).send(event, 1);

    expect(result.kind).toBe("network_error");
    expect(result.kind === "network_error" && result.message).toContain("ECONNREFUSED");
  });

  it("does not follow redirects", async () => {
    const url = await startReceiver((_request, _body, response) => {
      response.writeHead(302, { Location: "http://example.com/elsewhere" }).end();
    });

    const result = await createHttpWebhookSender({ url, timeoutMs: 1000 }).send(event, 1);

    expect(result).toMatchObject({ kind: "response", status: 302 });
  });

  it("keeps only an excerpt of a large response body", async () => {
    const url = await startReceiver((_request, _body, response) => {
      response.writeHead(500).end("x".repeat(1_000_000));
    });

    const result = await createHttpWebhookSender({ url, timeoutMs: 1000 }).send(event, 1);

    expect(result).toMatchObject({ kind: "response", status: 500 });
    expect(result.kind === "response" && result.bodyExcerpt.length).toBe(MAX_BODY_EXCERPT_CHARS);
  });

  it("parses Retry-After given in seconds", async () => {
    const url = await startReceiver((_request, _body, response) => {
      response.writeHead(429, { "Retry-After": "7" }).end();
    });

    const result = await createHttpWebhookSender({ url, timeoutMs: 1000 }).send(event, 1);

    expect(result).toMatchObject({ kind: "response", status: 429, retryAfterMs: 7000 });
  });
});
