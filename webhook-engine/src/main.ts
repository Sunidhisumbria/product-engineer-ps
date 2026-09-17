import { serve } from "@hono/node-server";
import { systemClock } from "./clock";
import { loadConfig } from "./config";
import { createSql } from "./db";
import { createApp } from "./http/app";
import { createEventStore } from "./store/event-store";

const config = loadConfig();
const sql = createSql(config.databaseUrl);
const store = createEventStore(sql);
const app = createApp({ store, clock: systemClock });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

async function shutdown() {
  server.close();
  await sql.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
