export type EventStatus = "pending" | "delivering" | "succeeded" | "failed";

export type AttemptOutcome =
  | "in_progress"
  | "succeeded"
  | "retryable_failure"
  | "permanent_failure"
  | "abandoned";

export type EventInput = {
  eventId: string;
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
};

export type StoredEvent = EventInput & {
  status: EventStatus;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lockedUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DeliveryAttempt = {
  eventId: string;
  attemptNumber: number;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  error: string | null;
  responseBody: string | null;
};
