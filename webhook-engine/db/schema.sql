CREATE TABLE IF NOT EXISTS events (
  event_id        text        PRIMARY KEY,
  type            text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  payload         jsonb       NOT NULL,


  status          text        NOT NULL
  CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed')),
  attempt_count   integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  locked_until    timestamptz,
  last_error      text,

  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS events_due_idx
  ON events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS events_expired_lease_idx
  ON events (locked_until) WHERE status = 'delivering';


CREATE TABLE IF NOT EXISTS delivery_attempts (
  event_id        text        NOT NULL REFERENCES events (event_id),
  attempt_number  integer     NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  duration_ms     integer,

  outcome         text        NOT NULL
  CHECK (outcome IN ('in_progress', 'succeeded', 'retryable_failure',
  'permanent_failure', 'abandoned')),
  http_status     integer,
  error           text,
  response_body   text, 

  PRIMARY KEY (event_id, attempt_number)
);
