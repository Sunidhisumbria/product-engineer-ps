import { serve } from "@hono/node-server";
import { z } from "zod";
import { loadDotEnv } from "../src/config";
import { consoleLogger as logger } from "../src/logger";
import { createReceiverApp } from "./app";

loadDotEnv();
const port = z.coerce.number().int().positive().default(4000).parse(process.env.RECEIVER_PORT);
const app = createReceiverApp(logger);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info("receiver_listening", { url: `http://localhost:${info.port}/webhook` });
});
