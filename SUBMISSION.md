# Product Engineering Challenge Submission

## Candidate

- **Name:** **Sunidhi**
- **Email:** **sunidhisumbria@gmail.com**
- **GitHub:** [Sunidhisumbria](https://github.com/Sunidhisumbria)
- **Selected problem:** [Problem 2: Webhook retry engine](problems/02-webhook-retry-engine/README.md)
- **Demo video:** **TODO: link (shared so anyone with the link can view)**

All code is in [`webhook-engine/`](webhook-engine/). It is a small TypeScript service. It accepts events over HTTP, stores them in Postgres and delivers them to one webhook endpoint. Retries are bounded, and every attempt is recorded.

## Run the project

**Prerequisites:** Node.js 22 or later (tested on 24.15), npm, and Docker with Compose v2. Ports 3000, 4000 and 5433 must be free.

```bash
git clone https://github.com/Sunidhisumbria/product-engineer-ps.git
cd product-engineer-ps/webhook-engine
npm ci
docker compose up -d --wait     # Postgres 17 on localhost:5433
npm run db:migrate
```

Then open three terminals, all in `webhook-engine/`:

```bash
# 1. API on :3000; the delivery worker runs in the same process
npm run dev

# 2. Fake webhook receiver on :4000, with a switchable failure mode
npm run receiver

# 3. Run a scenario (run `npm run demo` with no argument to list them)
npm run demo -- retry
```

No `.env` file is needed because every setting has a default. To change settings, copy `.env.example` to `.env`. There are no secrets.

### Scenarios

Each scenario sets the receiver's mode, submits an event, and prints every attempt as it finishes. Then it prints the final state and the requests the receiver actually got.

| Command | What happens | Covers |
| --- | --- | --- |
| `npm run demo -- success` | Receiver returns 200. The event is delivered on attempt 1. | AC1, AC5 |
| `npm run demo -- retry` | Receiver returns 503, 503, then 200. The wait before each retry grows. | AC2, AC5 |
| `npm run demo -- exhausted` | Receiver always returns 503. The event becomes `failed` after 5 attempts. | AC3 |
| `npm run demo -- rejected` | Receiver returns 400. The event fails at once with no retry. | Retry classification |
| `npm run demo -- duplicate` | The same event is sent 5 times at once, again after delivery, and once with a different payload. Responses are `202` once and `200` four times, then `200`, then `409`. **The receiver gets exactly 1 request.** | AC4 |
| `npm run demo -- timeout` | The receiver handles attempt 1 but replies after the sender's timeout, so attempt 2 is a duplicate delivery. | Delivery guarantee |

Real output from `npm run demo -- retry`:

```text
POST /events evt_retry_mu5fohzf -> 202
  attempt 1  retryable_failure  HTTP 503                   39ms  -> retry in 742ms
  attempt 2  retryable_failure  HTTP 503                    6ms  -> retry in 1740ms
  attempt 3  succeeded          HTTP 200                    2ms
Final state: succeeded after 3 attempt(s)
Receiver saw 3 request(s) for evt_retry_mu5fohzf:
  Webhook-Attempt 1 -> responded 503
  Webhook-Attempt 2 -> responded 503
  Webhook-Attempt 3 -> responded 200
```

**To see an event's state and attempt history (AC5):** run `curl http://localhost:3000/events/<eventId>`. In Windows PowerShell, use `curl.exe`.

```jsonc
{
  "eventId": "evt_retry_mu5fohzf",
  "type": "incident.created",
  "status": "succeeded",
  "attemptCount": 3,
  "nextAttemptAt": null,
  "lastError": null,
  // ...occurredAt, payload, createdAt, updatedAt, lockedUntil
  "attempts": [
    { "attemptNumber": 1, "startedAt": "2026-09-17T11:15:48.531Z", "finishedAt": "2026-09-17T11:15:48.580Z",
      "durationMs": 39, "outcome": "retryable_failure", "httpStatus": 503, "error": "HTTP 503", "responseBody": "..." },
    { "attemptNumber": 2, "outcome": "retryable_failure", "httpStatus": 503, "error": "HTTP 503", "...": "..." },
    { "attemptNumber": 3, "outcome": "succeeded", "httpStatus": 200, "error": null, "...": "..." }
  ]
}
```

The worker also writes one log line for each attempt outcome:

```text
2026-09-17T11:15:48.591Z WARN  delivery_retry_scheduled event=evt_retry_mu5fohzf attempt=1 result="HTTP 503" retry_in_ms=742
2026-09-17T11:15:49.639Z WARN  delivery_retry_scheduled event=evt_retry_mu5fohzf attempt=2 result="HTTP 503" retry_in_ms=1740
2026-09-17T11:15:51.702Z INFO  delivery_succeeded event=evt_retry_mu5fohzf attempt=3 result="HTTP 200"
```

<details>
<summary><strong>Optional: recovery after the process crashes mid-delivery</strong></summary>

The automated tests cover this case (see [Run the tests](#run-the-tests)). To see it happen live:

1. Start the API with a longer timeout and lease: `REQUEST_TIMEOUT_MS=10000 LEASE_MS=25000 npm run dev`. In PowerShell: `$env:REQUEST_TIMEOUT_MS=10000; $env:LEASE_MS=25000; npm run dev`.
2. Make the receiver answer slowly:
   - bash: `curl -X PUT localhost:4000/mode -H 'Content-Type: application/json' -d '{"mode":"slow_then_ok","delayMs":8000}'`
   - PowerShell: `Invoke-RestMethod -Method Put http://localhost:4000/mode -ContentType application/json -Body '{"mode":"slow_then_ok","delayMs":8000}'`
3. Submit an event:
   - bash: `curl -X POST localhost:3000/events -H 'Content-Type: application/json' -d '{"eventId":"evt_crash_1","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"incidentId":"inc_456"}}'`
   - PowerShell: `Invoke-RestMethod -Method Post http://localhost:3000/events -ContentType application/json -Body '{"eventId":"evt_crash_1","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"incidentId":"inc_456"}}'`
4. Within 8 seconds, while the receiver is still waiting, press **Ctrl+C twice** in the API terminal. The first press starts a graceful shutdown, which would wait for the attempt to finish. The second press exits immediately.
5. Restart the API with the same command. Until the lease expires, `GET /events/evt_crash_1` shows `status: "delivering"` with attempt 1 `in_progress`. About 25 seconds after the claim, attempt 1 is recorded as `abandoned` ("lease expired before the attempt outcome was recorded"), and attempt 2 succeeds.

The receiver marks attempt 2 as a duplicate because it had finished handling attempt 1. This is one of the duplicate cases described [below](#what-could-still-cause-a-receiver-to-observe-a-duplicate-delivery).

</details>

### API

| Request | Response |
| --- | --- |
| `POST /events` with a new `eventId` | `202`, the stored event, and a `Location` header |
| `POST /events` with a known `eventId` and the same content | `200` and the existing event in its current state. Nothing new is scheduled. |
| `POST /events` with a known `eventId` and different content | `409 event_id_conflict`. The original event is unchanged. |
| `POST /events` with an invalid body or a body over 256 KB | `400 invalid_event` listing each problem field, or `413` |
| `GET /events/:eventId` | `200` with the event and its attempts in order, or `404` |

Request body: `{ "eventId": string, "type": string, "occurredAt": ISO-8601 with offset, "payload": object }`. This matches the brief's example contract.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://webhooks:webhooks@localhost:5433/webhooks` | Postgres connection |
| `PORT` | `3000` | API port |
| `WEBHOOK_URL` | `http://localhost:4000/webhook` | The single delivery endpoint |
| `MAX_ATTEMPTS` | `5` | Maximum total attempts, including the first |
| `RETRY_BASE_DELAY_MS` / `RETRY_MAX_DELAY_MS` | `1000` / `30000` | Backoff base and upper limit |
| `REQUEST_TIMEOUT_MS` | `5000` | Timeout for each delivery request |
| `LEASE_MS` | `30000` | How long a claimed event is locked to one worker. Must be more than 2 × `REQUEST_TIMEOUT_MS`, or startup fails. |
| `POLL_INTERVAL_MS` / `WORKER_BATCH_SIZE` | `500` / `10` | How often the worker checks for due events, and how many it claims at once |
| `RECEIVER_PORT` | `4000` | Port for the fake receiver |

## Run the tests

The tests use the Postgres container from `docker compose up -d --wait`. They create and migrate a separate `webhooks_test` database themselves. They make no calls to external or paid services.

```bash
cd webhook-engine
npm test             # 51 tests, about 3 s
npm run typecheck
```

| Required by the brief | Tests |
| --- | --- |
| Successful delivery | `delivery-worker`: *delivers a pending event and records a successful attempt*; `end-to-end` |
| Temporary failure, then a retry | `delivery-worker`: *retries a temporary failure after the backoff delay and records both attempts*; `end-to-end` (real HTTP to the fake receiver) |
| Attempts run out, or a terminal failure | `delivery-worker`: *stops retrying once the attempt limit is reached*, *fails immediately on a non-retryable response* |
| The same event ID submitted again | `ingestion`: *returns the existing event…*, *creates exactly one event when identical submissions race*, *rejects a reused event id with different content…*; `delivery-worker`: *delivers a repeatedly submitted event only once* |
| **Beyond the brief:** crashes and concurrency | *recovers an event whose worker crashed mid-delivery*, *counts an abandoned attempt toward the limit*, *discards the result of a worker whose lease was taken over*, *recovers the event when the sender throws unexpectedly*, *never lets two workers claim the same event* |

The other tests cover the retry rules on their own (which results are retryable, the backoff limits, `Retry-After`) and the HTTP sender against a local `node:http` server (headers, timeout, network error, redirects not followed, response body cut to 2 KB).

**The tests don't wait on real time.** Time comes from an injected `Clock`. Worker tests call `worker.runOnce()` and move a `FakeClock` forward instead of sleeping, and the backoff's randomness is fixed. The one real wait is the sender's timeout test, which uses a very short timeout. The tests run against real Postgres on purpose, because the guarantees that matter most are in SQL: the unique `eventId`, claims that skip rows another worker has locked (`FOR UPDATE SKIP LOCKED`), and conditional updates.

## Architecture and data flow

```mermaid
flowchart LR
    caller(["Caller"]) -->|"POST /events, GET /events/:id"| api["HTTP API<br/>src/http/app.ts"]
    api --> ingest["acceptEvent<br/>src/ingest"]
    ingest --> store["EventStore<br/>src/store/event-store.ts"]
    api --> store
    store --> db[("Postgres<br/>events<br/>delivery_attempts")]
    worker["DeliveryWorker<br/>src/delivery/delivery-worker.ts"] --> queue["DeliveryQueue<br/>src/store/delivery-queue.ts"]
    queue --> db
    worker --> policy["Retry policy<br/>pure functions"]
    worker --> sender["WebhookSender<br/>HTTP + timeout"]
    sender -->|"POST, Webhook-Id, Webhook-Attempt"| endpoint(["Webhook endpoint"])
```

| Component | Responsibility |
| --- | --- |
| **HTTP API** (`src/http/app.ts`) | Validates requests with Zod and turns ingestion results into `202`, `200` or `409`. Serves an event with its attempt history. |
| **Ingestion** (`src/ingest/accept-event.ts`) | Inserts the event only if its ID is new. If the ID exists, compares the content and returns `accepted`, `duplicate` or `conflict`. |
| **Event store** (`src/store/event-store.ts`) | SQL for inserting and reading events and attempts |
| **Delivery queue** (`src/store/delivery-queue.ts`) | SQL for claiming due events, finding expired leases, and recording an attempt's result. A result is saved only if its worker still owns the event. |
| **Delivery worker** (`src/delivery/delivery-worker.ts`) | Runs a loop: recover events whose lease expired, claim a batch, send, classify the result, record it, and log the outcome. |
| **Retry policy** (`src/delivery/retry-policy.ts`) | Pure functions with no I/O: classify a send result, compute the backoff, and decide the next step (`succeed`, `retry` or `give_up`) |
| **Webhook sender** (`src/delivery/webhook-sender.ts`) | Makes one HTTP POST with a timeout and doesn't follow redirects. Returns a `SendResult` value (`response`, `timeout` or `network_error`) instead of throwing. |
| **Fake receiver** (`receiver/`) and **demo** (`scripts/demo.ts`) | Tools for testing and the demo; the service doesn't use them |

Every component receives what it depends on as an argument (store, queue, sender, clock, logger). `src/main.ts` connects them. That's why the worker tests can use a scripted sender and a fake clock with a real database.

### Data model

- **`events`**: one row per `eventId`, which is the primary key. **The event row is also the delivery job.** It holds `status`, `attempt_count`, `next_attempt_at`, `locked_until` and `last_error`, so there is no separate job table that could drift out of sync with the events.
- **`delivery_attempts`**: one row per attempt, keyed by `(event_id, attempt_number)`, which gives the history its order.

### Event states

```mermaid
stateDiagram-v2
    [*] --> pending: POST /events (new eventId)
    pending --> delivering: worker claims it (attempt n starts, lease set)
    delivering --> succeeded: 2xx response
    delivering --> pending: retryable failure or lease expired, attempts left
    delivering --> failed: non-retryable failure, or no attempts left
    succeeded --> [*]
    failed --> [*]
```

An attempt's outcome starts as `in_progress` and ends as one of `succeeded`, `retryable_failure`, `permanent_failure` or `abandoned`. `abandoned` means the worker's lease expired before it recorded a result.

### What happens to one event

1. **Accept.** `POST /events` runs `INSERT … ON CONFLICT (event_id) DO NOTHING` with `status = pending` and `next_attempt_at = now`. Storing and scheduling are one statement. The `202` is sent only after the insert commits, so an accepted event is never lost and never left unscheduled.
2. **Claim.** A single SQL statement picks due `pending` rows using `FOR UPDATE SKIP LOCKED`. The same statement sets them to `delivering`, adds 1 to `attempt_count`, sets `locked_until = now + LEASE_MS`, and inserts an `in_progress` attempt row. **Every request the receiver sees therefore has an attempt row, written before the request is sent.**
3. **Send.** The worker POSTs `{eventId, type, occurredAt, payload}` to `WEBHOOK_URL` with the headers `Webhook-Id: <eventId>` and `Webhook-Attempt: <n>`.
4. **Decide.** The retry policy classifies the result and chooses `succeed`, `retry` with a delay, or `give_up`.
5. **Record.** In one transaction, the worker updates the event with `WHERE status = 'delivering' AND attempt_count = n` and then fills in the attempt row. If no row matches, another worker has taken over; this result is thrown away and logged as `stale_attempt_result_discarded`.
6. **Recover.** Each loop starts by finding `delivering` events whose `locked_until` has passed. Their current attempt is closed as `abandoned`, and the event is rescheduled or failed by the same retry policy. That way an event whose worker died isn't stuck in `delivering` forever.

## Technology choices

| Choice | Why | Trade-off accepted |
| --- | --- | --- |
| **TypeScript on Node.js** | Quick to iterate on. Event states, attempt outcomes and `SendResult` are union types, and in `strict` mode the compiler reports a function that forgets to return a value for one of them. | One process runs one thread. That's fine here because delivery mostly waits on I/O. |
| **Postgres as both the store and the queue** | One place holds the data, so ingestion and scheduling commit in the same statement. Idempotency is a primary key, and `FOR UPDATE SKIP LOCKED` gives safe claiming across workers without another system. | The worker polls, which adds up to `POLL_INTERVAL_MS` of delay and some steady light load. Reviewers need Docker. |
| **Hono + `@hono/node-server`** | Small, built on web-standard `Request`/`Response`, and testable with `app.request()` without opening a port | Less built in than NestJS or Fastify; this service doesn't need more. |
| **Zod** | One validation approach at both edges: request bodies and environment config. Invalid config stops startup with a readable error. | Adds a dependency |
| **postgres.js** | Tagged-template SQL, so values are always parameterized and the SQL stays visible where it's used. | No ORM or migration tool, so the schema is one file that is safe to re-run. |
| **Vitest against real Postgres** | Tests the constraints and locking the design depends on, rather than mocks of them | The tests need the database container running. |

**Alternatives considered:**
- **SQLite** would make setup simpler, but it doesn't support `SKIP LOCKED` and handles concurrent writers poorly. That would hide the "many workers" question instead of answering it.
- **Redis with BullMQ** would give retries for free. But the retry policy and state machine, which are what this exercise is about, would then live inside a library, with a second store to keep consistent with Postgres.
- **An in-memory queue** loses accepted events when the process crashes.
- **Kafka or SQS** add infrastructure the brief rules out.

## Important decisions

### 1. The event row is the job, so idempotency comes from a primary key

A retry job exists only as the state of the event row. A second submission can't create a second job because there's nowhere to put one. **Simultaneous duplicate submissions** are settled by Postgres: all of them run `INSERT … ON CONFLICT DO NOTHING`, and they wait on the same key until the first transaction commits. Exactly one gets the row back and responds `202`. The rest read the existing row and respond `200` with its current state. No application-level locks are involved. The tests check this with 10 simultaneous submissions, and the demo shows it with 5.

**A reused ID with different content returns `409` instead of `200`.** Returning the old event silently would hide a caller bug where two different events share an ID. "Same content" means the same `type`, the same `occurredAt` as a point in time, and an equal `payload` compared as `jsonb`, so key order and whitespace don't matter.

### 2. Leases fenced by the attempt number, for crash recovery

A worker can die at any point, including after the receiver has handled the request. A claimed event therefore has a lease (`locked_until`), and results are written with the check `attempt_count = n`. Three rules follow:

- **An event whose worker died is picked up again.** After its lease expires, its attempt is recorded as `abandoned` and the retry policy handles it normally.
- **A worker whose lease expired can't overwrite newer state.** If it finishes after another worker has taken the event over, its update matches no row and is discarded.
- **Abandoned attempts count toward `MAX_ATTEMPTS`.** An event that crashes the worker every time still ends in `failed`, so it can't loop forever.

Config checks at startup that `LEASE_MS > 2 × REQUEST_TIMEOUT_MS`, so a healthy worker finishes or times out well before its lease expires.

### 3. Retry only failures that a retry can fix

| Result | Classified as | Why |
| --- | --- | --- |
| `2xx` | Success | The receiver acknowledged it. The response body is ignored. |
| `408`, `429`, `5xx` | Retryable | The receiver is overloaded, timed out or temporarily broken. |
| Timeout, connection refused or reset, DNS error | Retryable | Temporary network conditions |
| `3xx` | **Permanent** | Redirects are not followed. A moved endpoint is a configuration problem that should be visible, and following redirects silently could send data to a different host. |
| Other `4xx` (400, 401, 403, 404, 410, 422, …) | **Permanent** | Sending the same request again won't change the answer. |

**Retry limits and backoff:** at most `MAX_ATTEMPTS` (5) attempts in total. The wait after attempt *n* is a random value between ½·*d* and *d*, where *d* = min(`base` × 2^(n−1), `max`). The randomness spreads out retries so they don't all hit the endpoint at the same moment when it recovers. With the defaults, the waits after attempts 1 to 4 are 0.5–1 s, 1–2 s, 2–4 s and 4–8 s, and if attempt 5 fails the event becomes `failed`. A `Retry-After` given in seconds is treated as a minimum wait, but the wait never goes above `RETRY_MAX_DELAY_MS`, so the whole retry window stays bounded. The defaults are short on purpose so the demo runs in seconds. In production, I would spread about 8–10 attempts over several hours.

### Smaller choices worth noting

- **Response bodies are cut at 2,048 characters, and null bytes are removed** before storing, so a misbehaving receiver can't fill the database.
- **Errors never escape the worker loop.** A failure inside a delivery is logged as `delivery_crashed`, and the event recovers through its lease. A failure of a whole loop pass is logged as `worker_tick_failed`, and the loop keeps running.
- **Shutdown is graceful.** On `SIGINT` or `SIGTERM`, the API stops accepting requests and the worker finishes its current batch. A second Ctrl+C exits immediately.

## Delivery guarantee

**At-least-once delivery, with a limit on attempts.**

- Every accepted event ends as either `succeeded` or `failed`, and that state can be seen through `GET /events/:eventId`.
- `succeeded` means at least one request got a `2xx` response.
- The endpoint receives **at most `MAX_ATTEMPTS` requests for each event, even after crashes**, because abandoned attempts use up the limit too.
- Every request the receiver gets has a recorded attempt, because the attempt row is written before the request is sent.
- **Receivers should treat `Webhook-Id` as an idempotency key.** It equals `eventId` and is the same on every attempt. Receivers should ignore IDs they have already processed and still return `2xx` for them. `Webhook-Attempt` is only informational.
- **Order is not guaranteed.** A retried event can arrive after a later event. Receivers that care about order should use `occurredAt`.

### What each attempt records

| Field | Meaning |
| --- | --- |
| `attemptNumber` | Starts at 1. With `eventId`, it forms the key. |
| `startedAt` | When the worker claimed the event for this attempt |
| `finishedAt`, `durationMs` | When the result was recorded, and how long the HTTP request took |
| `outcome` | `in_progress`, `succeeded`, `retryable_failure`, `permanent_failure` or `abandoned` |
| `httpStatus` | The response status, or `null` for timeouts, network errors and abandoned attempts |
| `error` | A short summary such as `HTTP 503`, `timed out after 5000ms`, the network error message, or the lease-expired reason |
| `responseBody` | The first 2,048 characters of the response |

The event row keeps the latest summary: `status`, `attemptCount`, `nextAttemptAt` and `lastError`, for example `HTTP 503 (gave up after 5 attempts)`. Response headers and the full response body are not stored.

## Assumptions and limitations

**Assumptions**
- There is one endpoint, read from `WEBHOOK_URL` at startup. Changing it affects every event that hasn't been delivered yet.
- An `eventId` identifies one logical event permanently. Idempotency records never expire, and events are kept indefinitely.
- Any `2xx` counts as delivered. Receivers can't reject an event through the response body.

**Known limitations and unfinished work**
- `Retry-After` is read only as a number of seconds. The HTTP-date form is ignored, and normal backoff applies.
- There is no way to manually replay a `failed` event, and no endpoint to list or search events. Events can be looked up by ID, and everything is in the logs.
- A lease isn't extended during a request. If a process pauses (GC, a stalled database) for longer than the gap between the timeout and the lease, two attempts can overlap and the receiver can get a duplicate. The fencing check still keeps the recorded state correct.
- The API and the worker run in the same process.
- The worker polls for due events, so a new event waits up to `POLL_INTERVAL_MS` before its first attempt.
- The stored response body is not redacted.
- There are no request signatures, authentication or rate limits; the brief puts them out of scope.
- The schema is a single file that is safe to re-run, not versioned migrations.

## Production and scale

What I would change first, in order:

1. **Run the API and the worker as separate processes** from the same code. Ingestion then stays available when delivery is overloaded, and each side scales on its own. They already communicate only through the database.
2. **Use the database's clock (`now()`) for scheduling and leases.** Today the application's clock is injected so tests are deterministic. With many hosts, clock drift could let one worker take over a lease that is still active.
3. **Add a production retry schedule, manual replay, and a dead-letter view** for `failed` events. An endpoint outage longer than the retry window needs a way to recover.
4. **Sign requests with HMAC and a timestamp**, so receivers can verify where a request came from and reject replayed ones.
5. **Keep tables small:** partition or archive `delivery_attempts` and old finished events.
6. **Block private and internal network addresses** if endpoints ever become configurable by users, to prevent SSRF.

### What could still cause a receiver to observe a duplicate delivery?

- **The receiver handled the request, but the answer never arrived:** the response came after the timeout, the connection reset after processing, or a proxy returned `5xx` after the request reached the receiver. The `timeout` demo shows the first case.
- **The worker crashed after the receiver returned `2xx` but before the result was saved.** The lease expires, and the event is sent again.
- **A worker paused for longer than its lease** while its request was still in flight, so a second worker started another attempt at the same time.
- **The receiver returned an error after it had already processed the event**, which makes the failure look retryable.
- In the future: manual replays, or a new endpoint added while events are still waiting.

For all of these, receivers should deduplicate on `Webhook-Id`.

### How would you operate this with many workers?

The core already supports it. Claims use `FOR UPDATE SKIP LOCKED`, so workers never claim the same row (a test checks this). Leases and the fencing check make crashes and overlapping attempts safe. Running N copies of the worker works today. Next steps:

- Separate worker processes, with a limit on concurrent deliveries per process
- Database time for leases, and connection pooling (for example PgBouncer), because each worker holds connections
- Extend the lease during long requests instead of relying only on `LEASE_MS > 2 × timeout`
- Use `LISTEN/NOTIFY` to wake idle workers instead of polling fast
- On deploys, stop claiming new events and let current attempts finish, which `stop()` already does

Only if Postgres became the measured bottleneck would I move the queue into something like SQS or Kafka. Postgres would stay the source of truth for state and history.

### How would you prevent one failing endpoint from consuming all capacity?

With a single endpoint, the current protections are short timeouts, backoff that moves failing events out of the due set, and a batch size limit. A slow or failing event waits in `pending` and doesn't hold a worker. With many endpoints I would add:

- **Per-endpoint concurrency limits and fair claiming:** take due events from endpoints in rotation instead of in global `next_attempt_at` order, so a backlog for one endpoint can't starve the others.
- **A per-endpoint circuit breaker:** after N consecutive failures, pause the endpoint by pushing its pending events' `next_attempt_at` later. Then send one test request, and resume when it succeeds. If failures continue, disable the endpoint and notify its owner.
- **Separate lanes for first attempts and retries**, so a large retry backlog doesn't delay fresh events.
- **Timeouts per endpoint**, so slow endpoints give up workers quickly.

### What metrics and alerts would you add in production?

**Metrics**
- Events received, labeled by result (`accepted`, `duplicate`, `conflict`, `invalid`)
- Attempts labeled by outcome and HTTP status class
- Attempt duration (histogram)
- End-to-end delivery latency, from `createdAt` to `succeeded`
- Queue depth: the number of events that are due now
- Age of the oldest due event
- Number of events in `delivering`
- Counts of `abandoned` attempts, discarded stale results and `worker_tick_failed`
- Terminal `failed` count per endpoint
- Database pool saturation

**Alerts**
- The oldest due event is older than a few minutes, which means workers are stalled or falling behind.
- The success rate for an endpoint falls below its threshold over a time window.
- Terminal failures spike.
- `abandoned` attempts keep appearing, which points to workers crashing or being killed.
- `worker_tick_failed` repeats, usually because the database can't be reached.
- `POST /events` returns `5xx`.

## AI usage

I used Claude Code, Anthropic's coding agent, in VS Code as a development assistant for this challenge.

I chose Problem 2, directed the implementation, and iterated on the solution through prompts, code review, debugging, and testing. I ran and verified every demo scenario myself, both locally and in GitHub Codespaces, including the retry, duplicate, timeout, exhausted, and crash-recovery scenarios. I also reviewed the final code and documentation and recorded the demo video.

Claude Code assisted with implementation, test development, debugging, and drafting parts of the documentation. I reviewed and validated its output rather than treating generated code as automatically correct. Where behavior or design decisions mattered, I tested them against the requirements and the actual running system.

The final implementation reflects the decisions I made during the challenge, including using Postgres for persistence and job coordination, bounded retries, idempotent event handling, and at-least-once delivery. I am comfortable explaining the implementation and the trade-offs in a follow-up discussion.

## Credibility note

**Cross Fader** is a live online radio platform with free and paid tiers, on web, iOS and Android. It is built with Node.js/Express, MongoDB Atlas, React, Stripe subscriptions, Twilio OTP, and AzuraCast/Icecast for streaming.

**The problem it solved:** listeners stream live radio, and subscribers pay for the paid tier through recurring monthly Stripe subscriptions.

**My contribution:** I fixed a series of production issues that the client reported on the live system, covering streaming, payments and login.
- **The live stream wouldn't play.** The player connected directly to Icecast on port 8000, which can't be reached from outside the server. I routed the stream through AzuraCast's HTTPS proxy and made the backend the only place that defines the stream URL.
- **Uploaded songs never played.** The code hard-coded a playlist ID that no longer existed, and AzuraCast still reported every upload as successful. I moved the IDs into config and added a check that reads each upload back, so an upload that doesn't reach a playlist now fails with a clear error.
- **Real cards were rejected but the test card worked.** A `LIVE_KEY || TEST_KEY` fallback had silently switched production into Stripe test mode. I removed the fallback, so a missing key now fails loudly.
- **Part of the secret key appeared in the browser.** Stripe's error text includes part of the API key, and the controllers passed it straight into a UI toast. I added error sanitising with key redaction, plus a second redaction layer in the global error handler. A test harness checked the real HTTP responses, and all 6 cases passed.
- **The replacement key belonged to another company.** The key the client supplied authenticated, but it was for a different business's Stripe account. I wrote a read-only preflight script that checks the account identity, whether it can accept charges, and its product, price and webhook. It caught the problem before any subscriber was charged by the wrong legal entity.
- **"Payment is not happening."** Instead of reasoning from the code, I pulled the payment history from Stripe. It showed 14 successful card charges; every failure was Cash App Pay, the default tab, stuck waiting at its QR code step. I fixed its redirect URL, and the offered payment methods are now declared in code.

**Scale and operational complexity:** 270 users, recurring monthly subscriptions taking real money through a live Stripe account, three apps (web, iOS and Android) on one backend, and several external services: Stripe, Twilio and AzuraCast/Icecast. Every fix was made on the live production system.

**A difficult decision: fixing phone login on the server, and not rushing the data fix.** One user could log in with their email but not their phone number. Phone login compared numbers exactly as typed, but numbers were stored in mixed formats. I audited the users collection:
- 8 of 270 records had a formatted phone number.
- 6 accounts were locked out of phone login, one of them a paying subscriber.
- A signup from only days earlier was affected, so the problem was still happening.

I normalised numbers to digits on the server at all 10 places where they are read or written. That fixed web, iOS and Android in one deploy, with no app-store release. My first pass covered only 3 of those places. When I was asked whether the change could break existing users, I checked again and found the other 7, including OTP verification. Without those, a user would have passed login and then failed at the OTP step.

For the stored data, I didn't run a quick update on production. First I confirmed two things: no unique index could make the update fail, and no query depends on the copies of the number stored on other records. Then I took a field-level backup, wrote a restore script, and dry-ran both. The migration is prepared and awaiting sign-off.

**Current status:**
- The stream and upload fixes are committed (July 2026).
- The key configuration, error redaction and phone normalisation are deployed.
- A live end-to-end card payment with a refund hasn't been run yet.
- The Cash App Pay fix isn't confirmed yet, because Cash App Pay is US-only.

**Evidence:** the live site is at https://www.cfader.com/.
