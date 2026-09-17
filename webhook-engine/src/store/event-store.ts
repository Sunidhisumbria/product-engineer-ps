import type { JSONValue } from "postgres";
import type { Sql } from "../db";
import type { DeliveryAttempt, EventInput, StoredEvent } from "../events";

export type EventStore = ReturnType<typeof createEventStore>;

export function createEventStore(sql: Sql) {
  return {
    async insertIfAbsent(input: EventInput, now: Date): Promise<StoredEvent | null> {
      const [row] = await sql<StoredEvent[]>`
        INSERT INTO events
          (event_id, type, occurred_at, payload, status, next_attempt_at, created_at, updated_at)
        VALUES
          (${input.eventId}, ${input.type}, ${input.occurredAt}, ${sql.json(input.payload as JSONValue)},
           'pending', ${now}, ${now}, ${now})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING *
      `;
      return row ?? null;
    },

    async findWithContentMatch(
      input: EventInput,
    ): Promise<{ event: StoredEvent; sameContent: boolean } | null> {
      const [row] = await sql<(StoredEvent & { sameContent: boolean })[]>`
        SELECT *,
          (type = ${input.type}
            AND occurred_at = ${input.occurredAt}
            AND payload = ${sql.json(input.payload as JSONValue)}) AS same_content
        FROM events
        WHERE event_id = ${input.eventId}
      `;
      if (!row) return null;
      const { sameContent, ...event } = row;
      return { event, sameContent };
    },

    async findById(eventId: string): Promise<StoredEvent | null> {
      const [row] = await sql<StoredEvent[]>`
        SELECT * FROM events WHERE event_id = ${eventId}
      `;
      return row ?? null;
    },

    async listAttempts(eventId: string): Promise<DeliveryAttempt[]> {
      return sql<DeliveryAttempt[]>`
        SELECT * FROM delivery_attempts
        WHERE event_id = ${eventId}
        ORDER BY attempt_number
      `;
    },
  };
}
