import { serve } from "@hono/node-server";
import { systemClock } from "./clock";
import { loadConfig } from "./config";
import { createSql } from "./db";
import { createDeliveryWorker } from "./delivery/delivery-worker";
import { createHttpWebhookSender } from "./delivery/webhook-sender";
import { createApp } from "./http/app";
import { consoleLogger as logger } from "./logger";
import { createDeliveryQueue } from "./store/delivery-queue";
import { createEventStore } from "./store/event-store";

const config = loadConfig();
const sql = createSql(config.databaseUrl);

const app = createApp({ store: createEventStore(sql), clock: systemClock });

const worker = createDeliveryWorker({
  queue: createDeliveryQueue(sql),
  sender: createHttpWebhookSender({
    url: config.webhookUrl,
    timeoutMs: config.worker.requestTimeoutMs,
  }),
  clock: systemClock,
  retryPolicy: config.retry,
  settings: config.worker,
  logger,
}).start();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("api_listening", { url: `http://localhost:${info.port}` });
  logger.info("worker_started", {
    webhook_url: config.webhookUrl,
    max_attempts: config.retry.maxAttempts,
  });
});

async function shutdown(signal: string) {
  logger.info("shutting_down", { signal });
  server.close();
  await worker.stop();
  await sql.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
