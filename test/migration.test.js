import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
const remediationSql = fs.readFileSync(new URL("../migrations/002_remediation.sql", import.meta.url), "utf8");
const loopbackCallbackSql = fs.readFileSync(
  new URL("../migrations/003_loopback_callback_path.sql", import.meta.url),
  "utf8",
);
const pilotSql = fs.readFileSync(new URL("../migrations/004_cost_optimized_pilot.sql", import.meta.url), "utf8");

test("initial migration contains normalized authorization and recovery tables", () => {
  for (const table of [
    "business_units",
    "business_unit_memberships",
    "oauth_sessions",
    "mail_send_operations",
    "outbox_events",
    "settings_revisions",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  }
});

test("remediation migration adds polling, PII, embeddings, and dead-letter resolution", () => {
  for (const expected of [
    "CREATE TABLE mailbox_poll_state",
    "CREATE TABLE sent_reply_embeddings",
    "CREATE TABLE user_invitations",
    "CREATE TABLE operational_alerts",
    "ADD COLUMN resolved_at",
    "CREATE EXTENSION IF NOT EXISTS vector",
  ]) {
    assert.match(remediationSql, new RegExp(expected));
  }
});

test("sensitive envelopes require authenticated-encryption metadata", () => {
  for (const field of ["encryptedDek", "nonce", "tag", "aadDigest", "keyVersion"]) {
    assert.match(sql, new RegExp(field));
  }
});

test("event inbox has a hard retention deadline", () => {
  assert.match(sql, /hard_expires_at TIMESTAMPTZ NOT NULL DEFAULT now\(\) \+ interval '30 days'/);
});

test("loopback callback migration permits only the fixed or random callback path", () => {
  assert.match(loopbackCallbackSql, /DROP CONSTRAINT IF EXISTS oauth_sessions_return_uri_check/);
  assert.match(loopbackCallbackSql, /127\[\.\]0\[\.\]0\[\.\]1/);
  assert.match(loopbackCallbackSql, /\\\[::1\\\]/);
  assert.match(loopbackCallbackSql, /\/callback\(\/\[A-Za-z0-9_-\]\{43\}\)\?/);
});

test("pilot migration tracks Gmail watches and bounded AI usage", () => {
  assert.match(pilotSql, /ADD COLUMN watch_expiration TIMESTAMPTZ/);
  assert.match(pilotSql, /CREATE TABLE ai_usage_daily/);
  assert.doesNotMatch(pilotSql, /WHERE watch_expiration.*now\(\)/s);
});
