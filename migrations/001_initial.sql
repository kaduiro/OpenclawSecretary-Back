CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE business_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  calendar_account TEXT NOT NULL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX business_units_active_calendar_account_uq
  ON business_units (lower(calendar_account)) WHERE disabled_at IS NULL;
CREATE TRIGGER business_units_updated_at BEFORE UPDATE ON business_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject_hash TEXT UNIQUE,
  pending_email_hash TEXT UNIQUE,
  attendee_ref UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  workspace_access_type TEXT NOT NULL CHECK (workspace_access_type IN ('personal_oauth','business_unit_dwd')),
  provisioning_status TEXT NOT NULL DEFAULT 'active'
    CHECK (provisioning_status IN ('oauth_provisioning','pending_subject_bind','active','disabled')),
  provisioning_started_at TIMESTAMPTZ,
  subject_bound_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_state_ck CHECK (
    (provisioning_status = 'pending_subject_bind' AND google_subject_hash IS NULL AND pending_email_hash IS NOT NULL)
    OR (provisioning_status IN ('active','oauth_provisioning') AND google_subject_hash IS NOT NULL)
    OR provisioning_status = 'disabled'
  )
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_unit_memberships (
  business_unit_ref UUID NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager','faq_reviewer')),
  title_pattern TEXT CHECK (length(title_pattern) <= 200),
  active_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_until TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_unit_ref, attendee_ref, active_from),
  CHECK (active_until IS NULL OR active_until > active_from)
);
CREATE UNIQUE INDEX business_unit_memberships_one_active_uq
  ON business_unit_memberships(business_unit_ref, attendee_ref) WHERE active_until IS NULL;
CREATE UNIQUE INDEX business_unit_memberships_title_pattern_uq
  ON business_unit_memberships(business_unit_ref, lower(title_pattern))
  WHERE active_until IS NULL AND title_pattern IS NOT NULL;

CREATE TABLE user_roles (
  attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('faq_reviewer','bu_supervisor')),
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (attendee_ref, role, granted_at)
);
CREATE UNIQUE INDEX user_roles_active_uq ON user_roles(attendee_ref, role) WHERE revoked_at IS NULL;

CREATE TABLE oauth_sessions (
  id UUID PRIMARY KEY,
  session_secret_hash BYTEA NOT NULL UNIQUE,
  state_hash BYTEA NOT NULL UNIQUE,
  nonce_hash BYTEA NOT NULL,
  pkce_challenge TEXT NOT NULL,
  return_uri TEXT NOT NULL CHECK (return_uri ~ '^http://(127[.]0[.]0[.]1|\[::1\]):[0-9]{4,5}/callback$'),
  handoff_challenge TEXT NOT NULL CHECK (handoff_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  handoff_code_hash BYTEA UNIQUE,
  handoff_envelope JSONB,
  handoff_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  redeem_attempts INTEGER NOT NULL DEFAULT 0 CHECK (redeem_attempts BETWEEN 0 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((handoff_code_hash IS NULL) = (handoff_envelope IS NULL)),
  CHECK (handoff_envelope IS NULL OR (
    handoff_envelope ?& ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']
  ))
);
CREATE INDEX oauth_sessions_cleanup_idx ON oauth_sessions(expires_at) WHERE consumed_at IS NULL AND expired_at IS NULL;

CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_ref TEXT NOT NULL,
  gmail_id TEXT NOT NULL,
  owner_attendee_ref UUID REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  business_unit_ref UUID REFERENCES business_units(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT '未対応'
    CHECK (status IN ('processing','未対応','pending_calendar','pending_reply_approval','draft_missing','対応中','回答済み','解決済み','保留')),
  analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (analysis_status IN ('pending','succeeded','failed','skipped_bounce')),
  card_type TEXT NOT NULL DEFAULT 'manual_action_required'
    CHECK (card_type IN ('approval_ready','manual_action_required','bounce_notice')),
  subject TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'none' CHECK (urgency IN ('high','medium','low','none')),
  category TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  claimer_attendee_ref UUID REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ,
  card_version INTEGER NOT NULL DEFAULT 1 CHECK (card_version > 0),
  approval_token_hash BYTEA,
  approval_token_envelope JSONB,
  approval_subject_hash TEXT,
  token_expires_at TIMESTAMPTZ,
  approval_token_consumed_at TIMESTAMPTZ,
  reply_draft_envelope JSONB,
  draft_id TEXT,
  hud_display_ready BOOLEAN NOT NULL DEFAULT false,
  pii_masked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_ref, gmail_id),
  CHECK ((owner_attendee_ref IS NOT NULL) <> (business_unit_ref IS NOT NULL)),
  CHECK ((claimer_attendee_ref IS NULL) = (claimed_at IS NULL)),
  CHECK (reply_draft_envelope IS NULL OR reply_draft_envelope ?&
    ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']),
  CHECK (approval_token_envelope IS NULL OR approval_token_envelope ?&
    ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion'])
);
CREATE INDEX emails_owner_idx ON emails(owner_attendee_ref);
CREATE INDEX emails_business_unit_idx ON emails(business_unit_ref);
CREATE INDEX emails_pending_idx ON emails(received_at DESC) WHERE hud_display_ready;
CREATE TRIGGER emails_updated_at BEFORE UPDATE ON emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_id UUID REFERENCES emails(id) ON DELETE SET NULL,
  actor_attendee_ref UUID REFERENCES users(attendee_ref) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'received','analyzed','hud_shown','approved','rejected','sent','mail_claimed','mail_unclaimed',
    'mail_transferred','mail_force_claimed','mail_bounced','token_reissued','send_result_unknown',
    'user_provisioned','user_bound','user_disabled','cal_participant_approved','cal_participant_rejected',
    'cal_all_approved','cal_any_rejected','cal_selection_conflict','cal_succeeded','cal_partial_failed',
    'cal_replan_required','cal_replanned','cal_candidate_limited','cal_superseded','cal_cancelled',
    'faq_suggested','faq_registered','draft_saved','draft_deleted','error_minor','error_critical'
  )),
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION reject_timeline_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'timeline_events is append-only';
END;
$$;
CREATE TRIGGER timeline_events_no_update BEFORE UPDATE OR DELETE ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION reject_timeline_mutation();

CREATE TABLE mail_send_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_id UUID NOT NULL REFERENCES emails(id) ON DELETE RESTRICT,
  card_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared','draft_created','sending','reconciling','succeeded','result_unknown','failed_terminal')),
  draft_id TEXT,
  provider_message_id TEXT,
  operation_marker TEXT NOT NULL UNIQUE,
  last_error_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  reconcile_lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mail_id, card_version)
);
CREATE INDEX mail_send_operations_reconcile_idx ON mail_send_operations(next_attempt_at)
  WHERE status IN ('sending','result_unknown','reconciling');
CREATE TRIGGER mail_send_operations_updated_at BEFORE UPDATE ON mail_send_operations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE calendar_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_id UUID NOT NULL REFERENCES emails(id) ON DELETE RESTRICT,
  parent_proposal_id UUID REFERENCES calendar_proposals(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('active','manual_review_required','execution_pending','executed','executed_with_failures','superseded','cancelled')),
  slots JSONB NOT NULL DEFAULT '[]',
  selected_slot_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(mail_id, revision)
);
CREATE TRIGGER calendar_proposals_updated_at BEFORE UPDATE ON calendar_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE proposal_approvals (
  proposal_id UUID NOT NULL REFERENCES calendar_proposals(id) ON DELETE RESTRICT,
  attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','invalidated')),
  token_hash BYTEA NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  card_version INTEGER NOT NULL CHECK (card_version > 0),
  selected_slot_id TEXT,
  rejection_reason_code TEXT,
  rejection_reason_detail TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(proposal_id, attendee_ref)
);

CREATE TABLE calendar_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL UNIQUE REFERENCES calendar_proposals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','partial_failed','failed','replan_required','result_unknown')),
  execution_plan_envelope JSONB NOT NULL CHECK (execution_plan_envelope ?&
    ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']),
  plan_digest BYTEA NOT NULL,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER calendar_operations_updated_at BEFORE UPDATE ON calendar_operations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE calendar_operation_results (
  operation_id UUID NOT NULL REFERENCES calendar_operations(id) ON DELETE RESTRICT,
  attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','result_unknown','skipped')),
  provider_event_id TEXT,
  error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(operation_id, attendee_ref)
);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','retry','dispatched','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_dispatch_idx ON outbox_events(next_attempt_at, created_at)
  WHERE status IN ('pending','retry');

CREATE TABLE event_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_id UUID REFERENCES emails(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hard_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);
CREATE TABLE event_inbox_recipients (
  event_id UUID NOT NULL REFERENCES event_inbox(id) ON DELETE CASCADE,
  target_attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE CASCADE,
  acked_at TIMESTAMPTZ,
  PRIMARY KEY(event_id, target_attendee_ref)
);
CREATE INDEX event_inbox_hard_ttl_idx ON event_inbox(hard_expires_at);

CREATE TABLE faq_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_mail_id UUID NOT NULL REFERENCES emails(id) ON DELETE RESTRICT,
  content_envelope JSONB NOT NULL CHECK (content_envelope ?&
    ARRAY['version','algorithm','ciphertext','encryptedDek','nonce','tag','aadDigest','keyVersion']),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE faq_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_mail_id UUID REFERENCES emails(id) ON DELETE SET NULL,
  source_candidate_id UUID UNIQUE REFERENCES faq_candidates(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_by_attendee_ref UUID NOT NULL REFERENCES users(attendee_ref) ON DELETE RESTRICT,
  pii_reviewed BOOLEAN NOT NULL CHECK (pii_reviewed),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE settings_revisions (
  revision BIGINT PRIMARY KEY CHECK (revision > 0),
  value JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
