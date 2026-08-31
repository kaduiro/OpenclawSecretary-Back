import { notFound, serviceUnavailable } from "../lib/errors.js";

export class MailSendOperationService {
  constructor(db, provider, { maxAttempts = 12 } = {}) {
    this.db = db;
    this.provider = provider;
    this.maxAttempts = maxAttempts;
  }

  async getForActor(operationId, attendeeRef) {
    const { rows } = await this.db.query(
      `SELECT o.id AS "operationId", o.mail_id AS "mailId", o.status,
              o.provider_message_id AS "messageId", o.last_error_code AS "lastErrorCode",
              o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              o.next_attempt_at AS "nextAttemptAt"
         FROM mail_send_operations o
         JOIN emails e ON e.id=o.mail_id
        WHERE o.id=$1 AND (
          e.owner_attendee_ref=$2 OR EXISTS (
            SELECT 1 FROM business_unit_memberships m
            JOIN business_units b ON b.id=m.business_unit_ref
             WHERE m.business_unit_ref=e.business_unit_ref AND m.attendee_ref=$2
               AND b.disabled_at IS NULL
               AND m.active_from <= now()
               AND (m.active_until IS NULL OR m.active_until > now())
          )
        )`,
      [operationId, attendeeRef],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  async dueForReconciliation(limit = 50) {
    const { rows } = await this.db.query(
      `UPDATE mail_send_operations
          SET status='reconciling',reconcile_lease_until=now()+interval '60 seconds',
              reconcile_attempts=reconcile_attempts+1
        WHERE id IN (
          SELECT id FROM mail_send_operations
           WHERE status IN ('sending','result_unknown','reconciling')
             AND next_attempt_at <= now()
             AND (reconcile_lease_until IS NULL OR reconcile_lease_until < now())
           ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $1
        )
      RETURNING id,mail_id,draft_id,provider_message_id,provider_thread_id,operation_marker,status,reconcile_attempts`,
      [limit],
    );
    return rows;
  }

  async reconcileDue(limit = 50) {
    if (!this.provider?.findSentReply) {
      throw serviceUnavailable("gmail_provider_unavailable", "Gmail reconciliation is not configured");
    }
    const operations = await this.dueForReconciliation(limit);
    const results = [];
    for (const operation of operations) {
      try {
        const match = await this.provider.findSentReply({
          mailId: operation.mail_id,
          draftId: operation.draft_id,
          messageId: operation.provider_message_id,
          threadId: operation.provider_thread_id,
          operationMarker: operation.operation_marker,
        });
        if (match?.messageId) {
          const client = await this.db.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              `UPDATE mail_send_operations SET status='succeeded',provider_message_id=$2,
                   reconcile_lease_until=NULL,last_error_code=NULL,resolved_at=now() WHERE id=$1`,
              [operation.id, match.messageId],
            );
            await client.query(
              `UPDATE emails SET status='回答済み',approval_token_consumed_at=COALESCE(approval_token_consumed_at,now()),
                   approval_token_hash=NULL,approval_token_envelope=NULL,token_expires_at=NULL WHERE id=$1`,
              [operation.mail_id],
            );
            await client.query(
              `INSERT INTO timeline_events(mail_id,event_type,detail)
               VALUES ($1,'sent',jsonb_build_object('operationId',$2::text))`,
              [operation.mail_id, operation.id],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          results.push({ operationId: operation.id, status: "succeeded" });
          continue;
        }
        const terminal = operation.reconcile_attempts >= this.maxAttempts;
        const delaySeconds = Math.min(3600, 2 ** Math.min(operation.reconcile_attempts, 10));
        await this.db.query(
          `UPDATE mail_send_operations SET status=$2,last_error_code=$3,reconcile_lease_until=NULL,
               next_attempt_at=now()+($4*interval '1 second'),resolved_at=CASE WHEN $2='failed_terminal' THEN now() ELSE NULL END
            WHERE id=$1`,
          [operation.id, terminal ? "failed_terminal" : "result_unknown", "sent_message_not_found", delaySeconds],
        );
        results.push({ operationId: operation.id, status: terminal ? "failed_terminal" : "result_unknown" });
      } catch (error) {
        const terminal = operation.reconcile_attempts >= this.maxAttempts;
        await this.db.query(
          `UPDATE mail_send_operations SET status=$2,last_error_code=$3,reconcile_lease_until=NULL,
               next_attempt_at=now()+interval '5 minutes',resolved_at=CASE WHEN $2='failed_terminal' THEN now() ELSE NULL END
            WHERE id=$1`,
          [operation.id, terminal ? "failed_terminal" : "result_unknown", error.code || "reconcile_provider_error"],
        );
        results.push({ operationId: operation.id, status: terminal ? "failed_terminal" : "result_unknown" });
      }
    }
    return results;
  }
}
