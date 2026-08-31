CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE users ADD COLUMN email_hash TEXT UNIQUE;
UPDATE users SET email_hash=pending_email_hash WHERE email_hash IS NULL AND pending_email_hash IS NOT NULL;

ALTER TABLE oauth_sessions
  ADD COLUMN pkce_verifier_envelope JSONB,
  ADD COLUMN exchange_started_at TIMESTAMPTZ,
  ADD COLUMN exchange_completed_at TIMESTAMPTZ,
  ADD COLUMN last_error_code TEXT;

ALTER TABLE oauth_sessions ADD CONSTRAINT oauth_sessions_pkce_envelope_ck CHECK (
  pkce_verifier_envelope IS NULL OR
  pkce_verifier_envelope ?& ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']
);

ALTER TABLE emails
  ADD COLUMN sender_display_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN sender_address_envelope JSONB,
  ADD COLUMN body_preview_envelope JSONB,
  ADD COLUMN summary TEXT NOT NULL DEFAULT '',
  ADD COLUMN intent TEXT NOT NULL DEFAULT '',
  ADD COLUMN actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN failure_reason_code TEXT;

ALTER TABLE emails ADD CONSTRAINT emails_actions_array_ck CHECK (jsonb_typeof(actions)='array');
ALTER TABLE emails ADD CONSTRAINT emails_sender_envelope_ck CHECK (
  sender_address_envelope IS NULL OR
  sender_address_envelope ?& ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']
);
ALTER TABLE emails ADD CONSTRAINT emails_body_preview_envelope_ck CHECK (
  body_preview_envelope IS NULL OR
  body_preview_envelope ?& ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']
);

ALTER TABLE mail_send_operations
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN provider_thread_id TEXT;

CREATE TABLE mailbox_poll_state (
  mailbox_ref TEXT PRIMARY KEY,
  history_id TEXT,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures>=0),
  last_error_code TEXT,
  last_succeeded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mailbox_poll_state_due_idx ON mailbox_poll_state(next_poll_at)
  WHERE lease_until IS NULL;

ALTER TABLE proposal_approvals
  ADD COLUMN token_envelope JSONB,
  ADD COLUMN rejection_constraints JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE proposal_approvals ADD CONSTRAINT proposal_approval_token_envelope_ck CHECK (
  token_envelope IS NULL OR
  token_envelope ?& ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']
);

ALTER TABLE calendar_operations
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN resolved_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_by TEXT,
  ADD COLUMN resolution_note TEXT,
  ADD COLUMN dead_lettered_at TIMESTAMPTZ;
CREATE UNIQUE INDEX outbox_calendar_operation_uq ON outbox_events(event_type,aggregate_id)
  WHERE event_type='calendar_operation_execute';

CREATE TABLE sent_reply_embeddings (
  mail_id UUID PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE faq_entries
  ADD COLUMN embedding vector(768),
  ADD COLUMN embedding_model TEXT,
  ADD COLUMN embedding_version TEXT;

CREATE TABLE user_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash TEXT NOT NULL,
  business_unit_ref UUID NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('member','manager','faq_reviewer')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days',
  consumed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_invitations_active_uq
  ON user_invitations(email_hash,business_unit_ref) WHERE consumed_at IS NULL;

CREATE TABLE error_acknowledgements (
  correlation_id TEXT NOT NULL,
  attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(correlation_id,attendee_ref)
);

CREATE TABLE provider_credentials (
  attendee_ref UUID PRIMARY KEY REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  secret_resource_name TEXT NOT NULL,
  credential_status TEXT NOT NULL DEFAULT 'active'
    CHECK (credential_status IN ('active','invalid','revoked')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE operational_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  alert_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  reason_code TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operational_alerts_open_idx ON operational_alerts(created_at)
  WHERE acknowledged_at IS NULL;
