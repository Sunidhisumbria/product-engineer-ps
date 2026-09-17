import type { Clock } from "../clock";
import type { EventInput, StoredEvent } from "../events";
import type { EventStore } from "../store/event-store";

export type AcceptResult =
  | { kind: "accepted"; event: StoredEvent }
  | { kind: "duplicate"; event: StoredEvent }
  | { kind: "conflict"; event: StoredEvent };

export async function acceptEvent(
  store: EventStore,
  clock: Clock,
  input: EventInput,
): Promise<AcceptResult> {
  const inserted = await store.insertIfAbsent(input, clock.now());
  if (inserted) return { kind: "accepted", event: inserted };

  const existing = await store.findWithContentMatch(input);
  if (!existing) {
    throw new Error(`Event ${input.eventId} conflicted on insert but could not be read back`);
  }
  return existing.sameContent
    ? { kind: "duplicate", event: existing.event }
    : { kind: "conflict", event: existing.event };
}
