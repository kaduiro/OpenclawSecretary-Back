import { randomUUID } from "node:crypto";
import { notFound } from "../lib/errors.js";

export class OutboxService {
  constructor(db, enqueuer, { leaseSeconds = 60, maxAttempts = 12 } = {}) {
    this.db = db;
    this.enqueuer = enqueuer;
    this.leaseSeconds = leaseSeconds;
    this.maxAttempts = maxAttempts;
  }

  async leaseBatch(limit = 50) {
    const leaseId = randomUUID();
    const { rows } = await this.db.query(
      `WITH candidates AS (
         SELECT id FROM outbox_events
          WHERE (
            (status IN ('pending','retry') AND next_attempt_at<=now()) OR
            (status='leased' AND lease_expires_at<now())
          )
            AND (lease_expires_at IS NULL OR lease_expires_at<now())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE outbox_events o
          SET status='leased', lease_id=$2,
              lease_expires_at=now()+($3 * interval '1 second'), attempts=attempts+1
         FROM candidates c WHERE o.id=c.id
       RETURNING o.*`,
      [limit, leaseId, this.leaseSeconds],
    );
    return rows;
  }

  async dispatch(limit = 50) {
    const events = await this.leaseBatch(limit);
    const results = [];
    for (const event of events) {
      try {
        await this.enqueuer.enqueue(event);
        await this.db.query(
          `UPDATE outbox_events SET status='dispatched', dispatched_at=now(), lease_id=NULL, lease_expires_at=NULL WHERE id=$1 AND lease_id=$2`,
          [event.id, event.lease_id],
        );
        results.push({ id: event.id, status: "dispatched" });
      } catch (error) {
        const terminal = ["unknown_outbox_event_type", "invalid_outbox_payload"].includes(error.code) ||
          event.attempts >= this.maxAttempts;
        const delaySeconds = Math.min(3600, 2 ** Math.min(event.attempts, 10)) + Math.floor(Math.random() * 10);
        await this.db.query(
          `UPDATE outbox_events
              SET status=$3, next_attempt_at=now()+($4 * interval '1 second'),
                  last_error_code=$5, lease_id=NULL, lease_expires_at=NULL,
                  dead_lettered_at=CASE WHEN $3='dead_letter' THEN now() ELSE dead_lettered_at END
            WHERE id=$1 AND lease_id=$2`,
          [event.id, event.lease_id, terminal ? "dead_letter" : "retry", delaySeconds, error.code || "enqueue_failed"],
        );
        if (terminal) {
          const reasonCode = error.code || "enqueue_failed";
          await this.db.query(
            `INSERT INTO operational_alerts(severity,alert_type,resource_type,resource_id,reason_code)
             VALUES ('critical','outbox_dead_letter','outbox_event',$1,$2)`,
            [event.id, reasonCode],
          );
          console.error(JSON.stringify({
            severity: "CRITICAL",
            event: "outbox_dead_letter",
            outboxEventId: event.id,
            reasonCode,
          }));
        }
        results.push({ id: event.id, status: terminal ? "dead_letter" : "retry" });
      }
    }
    return results;
  }

  async replay(eventId, actorEmail) {
    const { rows } = await this.db.query(
      `UPDATE outbox_events SET status='pending',attempts=0,next_attempt_at=now(),
           lease_id=NULL,lease_expires_at=NULL,resolved_at=now(),resolved_by=$2,
           resolution_note='operator_replay'
        WHERE id=$1 AND status='dead_letter'
      RETURNING id,event_type AS "eventType",status`,
      [eventId, actorEmail],
    );
    if (!rows[0]) {
      throw notFound();
    }
    return { success: true, ...rows[0] };
  }
}
