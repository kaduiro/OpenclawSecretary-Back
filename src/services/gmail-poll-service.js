import { randomUUID } from "node:crypto";
import { serviceUnavailable } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

export class GmailPollService {
  constructor(db, provider) {
    this.db = db;
    this.provider = provider;
  }

  async run(limit = 20) {
    if (!this.provider?.pollMailbox) throw serviceUnavailable("gmail_provider_unavailable", "Gmail polling is not configured");
    const leaseId = randomUUID();
    const { rows } = await this.db.query(
      `WITH due AS (
         SELECT mailbox_ref FROM mailbox_poll_state
          WHERE next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now())
          ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE mailbox_poll_state s SET lease_id=$2,lease_until=now()+interval '5 minutes'
        FROM due WHERE s.mailbox_ref=due.mailbox_ref RETURNING s.*`,
      [limit, leaseId],
    );
    return Promise.all(rows.map((state) => this.#process(state, leaseId)));
  }

  async runNotification({ emailAddress }) {
    if (!this.provider?.pollMailbox) throw serviceUnavailable("gmail_provider_unavailable", "Gmail polling is not configured");
    const normalized = emailAddress?.trim().toLowerCase();
    if (!normalized || normalized.length > 320) return { status: "ignored", processed: 0 };
    const leaseId = randomUUID();
    const { rows } = await this.db.query(
      `UPDATE mailbox_poll_state s SET lease_id=$2,lease_until=now()+interval '5 minutes'
        FROM users u
       WHERE u.attendee_ref::text=s.mailbox_ref AND u.email_hash=$1
         AND u.provisioning_status='active'
         AND (s.lease_until IS NULL OR s.lease_until<now())
       RETURNING s.*`,
      [sha256Hex(normalized), leaseId],
    );
    if (!rows[0]) return { status: "ignored", processed: 0 };
    return this.#process(rows[0], leaseId);
  }

  async renewWatches(topicName, limit = 100) {
    if (!topicName) throw serviceUnavailable("gmail_pubsub_topic_missing", "Gmail push topic is not configured");
    if (!this.provider?.watchMailbox) throw serviceUnavailable("gmail_provider_unavailable", "Gmail watch is not configured");
    const { rows } = await this.db.query(
      `SELECT s.mailbox_ref,s.history_id
         FROM mailbox_poll_state s
         JOIN users u ON u.attendee_ref::text=s.mailbox_ref
         JOIN provider_credentials c ON c.attendee_ref=u.attendee_ref AND c.credential_status='active'
        WHERE u.provisioning_status='active'
          AND (s.watch_expiration IS NULL OR s.watch_expiration<now()+interval '1 day')
        ORDER BY s.watch_expiration NULLS FIRST LIMIT $1`,
      [limit],
    );
    const results = [];
    for (const state of rows) {
      try {
        const watch = await this.provider.watchMailbox({ mailboxRef: state.mailbox_ref, topicName });
        await this.db.query(
          `UPDATE mailbox_poll_state
              SET history_id=COALESCE(history_id,$2),watch_expiration=to_timestamp($3::double precision/1000),
                  watch_last_renewed_at=now(),next_poll_at=now()+interval '1 hour',last_error_code=NULL,updated_at=now()
            WHERE mailbox_ref=$1`,
          [state.mailbox_ref, watch.historyId || null, Number(watch.expiration)],
        );
        results.push({ mailboxRef: state.mailbox_ref, status: "succeeded" });
      } catch (error) {
        await this.db.query(
          `UPDATE mailbox_poll_state SET last_error_code=$2,next_poll_at=now()+interval '5 minutes',updated_at=now()
            WHERE mailbox_ref=$1`,
          [state.mailbox_ref, error.code || "gmail_watch_failed"],
        );
        results.push({ mailboxRef: state.mailbox_ref, status: "retry" });
      }
    }
    return results;
  }

  async #process(state, leaseId) {
    try {
      const result = await this.provider.pollMailbox({ mailboxRef: state.mailbox_ref, historyId: state.history_id });
      await this.db.query(
        `UPDATE mailbox_poll_state SET history_id=$2,next_poll_at=now()+interval '1 hour',
             lease_id=NULL,lease_until=NULL,consecutive_failures=0,last_error_code=NULL,last_succeeded_at=now(),updated_at=now()
          WHERE mailbox_ref=$1 AND lease_id=$3`,
        [state.mailbox_ref, result.historyId || state.history_id, leaseId],
      );
      return { mailboxRef: state.mailbox_ref, status: "succeeded", processed: result.processed || 0 };
    } catch (error) {
      await this.db.query(
        `UPDATE mailbox_poll_state SET next_poll_at=now()+interval '5 minutes',lease_id=NULL,lease_until=NULL,
             consecutive_failures=consecutive_failures+1,last_error_code=$2,updated_at=now()
          WHERE mailbox_ref=$1 AND lease_id=$3`,
        [state.mailbox_ref, error.code || "gmail_poll_failed", leaseId],
      );
      return { mailboxRef: state.mailbox_ref, status: "retry", processed: 0 };
    }
  }
}
