import type { Sql } from "../db";
import type { AttemptOutcome, EventStatus, StoredEvent } from "../events";

export type AttemptCompletion = {
  eventId: string;
  attemptNumber: number;
  finishedAt: Date;
  durationMs: number | null;
  outcome: Exclude<AttemptOutcome, "in_progress">;
  httpStatus: number | null;
  error: string | null;
  responseBody: string | null;
  eventStatus: Exclude<EventStatus, "delivering">;
  nextAttemptAt: Date | null;
  lastError: string | null;
};

export type DeliveryQueue = ReturnType<typeof createDeliveryQueue>;

export function createDeliveryQueue(sql: Sql) {
  return {
    async claimDue(now: Date, limit: number, leaseMs: number): Promise<StoredEvent[]> {
      const lockedUntil = new Date(now.getTime() + leaseMs);
      return sql<StoredEvent[]>`
        WITH due AS MATERIALIZED (
          SELECT event_id FROM events
          WHERE status = 'pending' AND next_attempt_at <= ${now}
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
          UPDATE events SET
            status = 'delivering',
            attempt_count = events.attempt_count + 1,
            next_attempt_at = NULL,
            locked_until = ${lockedUntil},
            updated_at = ${now}
          FROM due
          WHERE events.event_id = due.event_id
          RETURNING events.*
        ),
        started AS (
          INSERT INTO delivery_attempts (event_id, attempt_number, started_at, outcome)
          SELECT event_id, attempt_count, ${now}, 'in_progress' FROM claimed
        )
        SELECT * FROM claimed
      `;
    },

    async findExpiredLeases(now: Date, limit: number): Promise<StoredEvent[]> {
      return sql<StoredEvent[]>`
        SELECT * FROM events
        WHERE status = 'delivering' AND locked_until <= ${now}
        ORDER BY locked_until
        LIMIT ${limit}
      `;
    },

    async completeAttempt(completion: AttemptCompletion): Promise<boolean> {
      const c = completion;
      return sql.begin(async (tx) => {
        const [owned] = await tx`
          UPDATE events SET
            status = ${c.eventStatus},
            next_attempt_at = ${c.nextAttemptAt},
            locked_until = NULL,
            last_error = ${c.lastError},
            updated_at = ${c.finishedAt}
          WHERE event_id = ${c.eventId}
            AND status = 'delivering'
            AND attempt_count = ${c.attemptNumber}
          RETURNING event_id
        `;
        if (!owned) return false;

        await tx`
          UPDATE delivery_attempts SET
            outcome = ${c.outcome},
            finished_at = ${c.finishedAt},
            duration_ms = ${c.durationMs},
            http_status = ${c.httpStatus},
            error = ${c.error},
            response_body = ${c.responseBody}
          WHERE event_id = ${c.eventId} AND attempt_number = ${c.attemptNumber}
        `;
        return true;
      });
    },
  };
}
