ALTER TABLE mailbox_poll_state
  ADD COLUMN watch_expiration TIMESTAMPTZ,
  ADD COLUMN watch_last_renewed_at TIMESTAMPTZ;

CREATE INDEX mailbox_poll_state_watch_due_idx
  ON mailbox_poll_state(watch_expiration);

CREATE TABLE ai_usage_daily (
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  flash_lite_requests INTEGER NOT NULL DEFAULT 0 CHECK (flash_lite_requests >= 0),
  flash_requests INTEGER NOT NULL DEFAULT 0 CHECK (flash_requests >= 0),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_date)
);
