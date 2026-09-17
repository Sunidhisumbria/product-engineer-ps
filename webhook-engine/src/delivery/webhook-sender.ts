import { describeError } from "../errors";
import type { StoredEvent } from "../events";

export type SendResult =
  | { kind: "response"; status: number; bodyExcerpt: string; retryAfterMs?: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "network_error"; message: string };

export type WebhookSender = {
  send(event: StoredEvent, attemptNumber: number): Promise<SendResult>;
};

export const MAX_BODY_EXCERPT_CHARS = 2048;

export function createHttpWebhookSender(options: { url: string; timeoutMs: number }): WebhookSender {
  const { url, timeoutMs } = options;

  return {
    async send(event, attemptNumber) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "Content-Type": "application/json",
            "Webhook-Id": event.eventId,
            "Webhook-Attempt": String(attemptNumber),
          },
          body: JSON.stringify({
            eventId: event.eventId,
            type: event.type,
            occurredAt: event.occurredAt,
            payload: event.payload,
          }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          return { kind: "timeout", timeoutMs };
        }
        return { kind: "network_error", message: describeError(error) };
      }

      return {
        kind: "response",
        status: response.status,
        bodyExcerpt: await readBodyExcerpt(response),
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      };
    },
  };
}

export function summarizeResult(result: SendResult): string {
  switch (result.kind) {
    case "response":
      return `HTTP ${result.status}`;
    case "timeout":
      return `timed out after ${result.timeoutMs}ms`;
    case "network_error":
      return result.message;
  }
}

async function readBodyExcerpt(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_BODY_EXCERPT_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  } catch {
    await reader.cancel().catch(() => {});
  }
  return text.replaceAll("\u0000", "").slice(0, MAX_BODY_EXCERPT_CHARS);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value) * 1000;
}
