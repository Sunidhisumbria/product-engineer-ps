import { setTimeout as sleep } from "node:timers/promises";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Logger } from "../src/logger";

export const receiverModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ok") }),
  z.object({ mode: z.literal("fail_then_ok"), failures: z.number().int().min(1) }),
  z.object({
    mode: z.literal("always_fail"),
    status: z.number().int().min(500).max(599).default(503),
  }),
  z.object({
    mode: z.literal("reject"),
    status: z.number().int().min(400).max(499).default(400),
  }),
  z.object({
    mode: z.literal("slow_then_ok"),
    delayMs: z.number().int().min(0),
    slowRequests: z.number().int().min(1).default(1),
  }),
]);

export type ReceiverMode = z.input<typeof receiverModeSchema>;

export type ReceivedDelivery = {
  webhookId: string;
  attempt: number;
  receivedAt: string;
  respondedWith: number;
  duplicate: boolean;
};

export function createReceiverApp(logger: Logger) {
  let mode: z.output<typeof receiverModeSchema> = { mode: "ok" };
  const deliveries: ReceivedDelivery[] = [];
  const requestsPerWebhook = new Map<string, number>();
  const acceptedWebhookIds = new Set<string>();

  async function respond(webhookId: string): Promise<number> {
    const current = mode;
    const previousRequests = requestsPerWebhook.get(webhookId) ?? 0;
    requestsPerWebhook.set(webhookId, previousRequests + 1);

    switch (current.mode) {
      case "ok":
        return 200;
      case "fail_then_ok":
        return previousRequests < current.failures ? 503 : 200;
      case "always_fail":
      case "reject":
        return current.status;
      case "slow_then_ok":
        if (previousRequests < current.slowRequests) await sleep(current.delayMs);
        return 200;
    }
  }

  const app = new Hono();

  app.post("/webhook", async (c) => {
    const webhookId = c.req.header("Webhook-Id") ?? "(missing)";
    const attempt = Number(c.req.header("Webhook-Attempt"));
    const status = await respond(webhookId);

    const accepted = status >= 200 && status < 300;
    const duplicate = accepted && acceptedWebhookIds.has(webhookId);
    if (accepted) acceptedWebhookIds.add(webhookId);

    deliveries.push({
      webhookId,
      attempt,
      receivedAt: new Date().toISOString(),
      respondedWith: status,
      duplicate,
    });
    logger.info("webhook_received", { webhook_id: webhookId, attempt, responded: status, duplicate });

    return c.json({ duplicate }, status as ContentfulStatusCode);
  });

  app.get("/mode", (c) => c.json(mode));

  app.put("/mode", zValidator("json", receiverModeSchema), (c) => {
    mode = c.req.valid("json");
    requestsPerWebhook.clear();
    logger.info("receiver_mode_changed", { mode: JSON.stringify(mode) });
    return c.json(mode);
  });

  app.get("/deliveries", (c) => {
    const webhookId = c.req.query("webhookId");
    return c.json(webhookId ? deliveries.filter((d) => d.webhookId === webhookId) : deliveries);
  });

  app.delete("/deliveries", (c) => {
    deliveries.length = 0;
    requestsPerWebhook.clear();
    acceptedWebhookIds.clear();
    return c.body(null, 204);
  });

  return app;
}
