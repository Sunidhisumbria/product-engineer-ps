import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Clock } from "../clock";
import { acceptEvent } from "../ingest/accept-event";
import type { EventStore } from "../store/event-store";

const eventBody = z.object({
  eventId: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(255),
  occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  payload: z.record(z.string(), z.unknown()),
});

export type AppDeps = {
  store: EventStore;
  clock: Clock;
};

export function createApp({ store, clock }: AppDeps) {
  const app = new Hono();

  app.post(
    "/events",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    zValidator("json", eventBody, (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        }));
        return c.json({ error: "invalid_event", issues }, 400);
      }
    }),
    async (c) => {
      const result = await acceptEvent(store, clock, c.req.valid("json"));
      const location = `/events/${encodeURIComponent(result.event.eventId)}`;

      switch (result.kind) {
        case "accepted":
          return c.json(result.event, 202, { Location: location });
        case "duplicate":
          return c.json(result.event, 200, { Location: location });
        case "conflict":
          return c.json(
            {
              error: "event_id_conflict",
              message: `Event ${result.event.eventId} was already accepted with different content`,
            },
            409,
            { Location: location },
          );
      }
    },
  );

  app.get("/events/:eventId", async (c) => {
    const eventId = c.req.param("eventId");
    const event = await store.findById(eventId);
    if (!event) return c.json({ error: "event_not_found" }, 404);

    const attempts = await store.listAttempts(eventId);
    return c.json({ ...event, attempts });
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: "bad_request", message: error.message }, error.status);
    }
    console.error("Unhandled request error", error);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
