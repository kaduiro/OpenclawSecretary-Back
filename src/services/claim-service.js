import { randomBytes } from "node:crypto";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, forbidden, notFound, serviceUnavailable } from "../lib/errors.js";

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

function newToken() {
  return randomBytes(32).toString("base64url");
}

export class ClaimService {
  constructor(db, crypto) {
    this.db = db;
    this.crypto = crypto;
  }

  async claim(mailId, actor) {
    const token = newToken();
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE emails e
            SET claimer_attendee_ref=$2, claimed_at=now(), approval_subject_hash=$3,
                approval_token_hash=$4, token_expires_at=$5,
                approval_token_consumed_at=NULL, card_version=card_version+1
          WHERE e.id=$1 AND e.business_unit_ref IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM business_unit_memberships m
              JOIN business_units b ON b.id=m.business_unit_ref
               WHERE m.business_unit_ref=e.business_unit_ref AND m.attendee_ref=$2
                 AND b.disabled_at IS NULL
                 AND m.active_from <= now() AND (m.active_until IS NULL OR m.active_until > now())
            )
            AND (
              e.claimer_attendee_ref IS NULL OR
              (e.status <> 'pending_calendar' AND e.claimed_at < now()-interval '2 hours')
            )
        RETURNING e.id, e.claimed_at, e.card_version`,
        [mailId, actor.attendeeRef, actor.subjectHash, sha256(token), new Date(Date.now() + TOKEN_TTL_MS)],
      );
      if (!rows[0]) {
        const visible = await client.query(
          `SELECT 1 FROM emails e WHERE e.id=$1 AND EXISTS (
             SELECT 1 FROM business_unit_memberships m
             JOIN business_units b ON b.id=m.business_unit_ref
              WHERE m.business_unit_ref=e.business_unit_ref AND m.attendee_ref=$2
                AND b.disabled_at IS NULL
                AND m.active_from<=now() AND (m.active_until IS NULL OR m.active_until>now()))`,
          [mailId, actor.attendeeRef],
        );
        if (visible.rowCount === 0) throw notFound();
        throw conflict("already_claimed", "Mail is already claimed by another active member");
      }
      if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Approval token issuance is unavailable");
      const tokenEnvelope = await this.crypto.encrypt(token, `mail:${mailId}:approval-token:${rows[0].card_version}`);
      await client.query(`UPDATE emails SET approval_token_envelope=$2 WHERE id=$1`, [mailId, tokenEnvelope]);
      await this.#auditAndNotify(client, mailId, actor.attendeeRef, "mail_claimed");
      await client.query("COMMIT");
      return {
        success: true,
        mailId,
        claimedAt: rows[0].claimed_at,
        cardVersion: rows[0].card_version,
        detailAvailable: true,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async release(mailId, actor) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE emails SET claimer_attendee_ref=NULL, claimed_at=NULL,
             approval_subject_hash=NULL, approval_token_hash=NULL,
             approval_token_envelope=NULL, token_expires_at=NULL, approval_token_consumed_at=NULL,
             card_version=card_version+1
          WHERE id=$1 AND claimer_attendee_ref=$2
            AND EXISTS (
              SELECT 1 FROM business_unit_memberships m
              JOIN business_units b ON b.id=m.business_unit_ref
               WHERE m.business_unit_ref=emails.business_unit_ref
                 AND m.attendee_ref=$2 AND b.disabled_at IS NULL
                 AND m.active_from<=now() AND (m.active_until IS NULL OR m.active_until>now())
            )`,
        [mailId, actor.attendeeRef],
      );
      if (result.rowCount !== 1) throw forbidden("Only the current claimant may release a claim");
      await this.#auditAndNotify(client, mailId, actor.attendeeRef, "mail_unclaimed");
      await client.query("COMMIT");
      return { success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transferTargets(mailId, actor) {
    const { rows } = await this.db.query(
      `SELECT target.attendee_ref AS "attendeeRef",
              COALESCE(NULLIF(target.title_pattern,''), target.role) AS label
         FROM emails e
         JOIN business_units b ON b.id=e.business_unit_ref AND b.disabled_at IS NULL
         JOIN business_unit_memberships caller ON caller.business_unit_ref=e.business_unit_ref
          AND caller.attendee_ref=$2 AND caller.active_from<=now()
          AND (caller.active_until IS NULL OR caller.active_until>now())
         JOIN business_unit_memberships target ON target.business_unit_ref=e.business_unit_ref
          AND target.attendee_ref<>$2 AND target.active_from<=now()
          AND (target.active_until IS NULL OR target.active_until>now())
         JOIN users u ON u.attendee_ref=target.attendee_ref AND u.provisioning_status='active'
        WHERE e.id=$1
        ORDER BY label,target.attendee_ref`,
      [mailId, actor.attendeeRef],
    );
    if (rows.length === 0) {
      const { rowCount } = await this.db.query(
        `SELECT 1 FROM emails e
          WHERE e.id=$1 AND (e.owner_attendee_ref=$2 OR EXISTS (
            SELECT 1 FROM business_unit_memberships m
             WHERE m.business_unit_ref=e.business_unit_ref AND m.attendee_ref=$2
               AND m.active_from<=now() AND (m.active_until IS NULL OR m.active_until>now())))`,
        [mailId, actor.attendeeRef],
      );
      if (rowCount === 0) throw notFound();
    }
    return { targets: rows };
  }

  async transfer(mailId, targetAttendeeRef, actor) {
    const token = newToken();
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT e.*,
                e.claimed_at IS NOT NULL AND e.claimed_at<=now()-interval '24 hours' AS force_eligible
           FROM emails e
           JOIN business_units b ON b.id=e.business_unit_ref AND b.disabled_at IS NULL
          WHERE e.id=$1 FOR UPDATE OF e`,
        [mailId],
      );
      const mail = locked.rows[0];
      if (!mail) throw notFound();
      const target = await client.query(
        `SELECT u.google_subject_hash FROM business_unit_memberships m
          JOIN users u ON u.attendee_ref=m.attendee_ref
          JOIN business_units b ON b.id=m.business_unit_ref
         WHERE m.business_unit_ref=$1 AND m.attendee_ref=$2
           AND b.disabled_at IS NULL
           AND m.active_from<=now() AND (m.active_until IS NULL OR m.active_until>now())
           AND u.provisioning_status='active'`,
        [mail.business_unit_ref, targetAttendeeRef],
      );
      if (target.rowCount !== 1) throw badRequest("cross_business_unit_transfer", "Target must be an active member of the same BU");
      const caller = await client.query(
        `SELECT 1 FROM business_unit_memberships m
          JOIN users u ON u.attendee_ref=m.attendee_ref
          JOIN business_units b ON b.id=m.business_unit_ref
         WHERE m.business_unit_ref=$1 AND m.attendee_ref=$2
           AND b.disabled_at IS NULL AND u.provisioning_status='active'
           AND m.active_from<=now() AND (m.active_until IS NULL OR m.active_until>now())`,
        [mail.business_unit_ref, actor.attendeeRef],
      );
      if (caller.rowCount !== 1) throw forbidden("Active business-unit membership is required");
      const force = mail.claimer_attendee_ref !== actor.attendeeRef;
      if (force) {
        if (targetAttendeeRef !== actor.attendeeRef || !mail.force_eligible) {
          throw forbidden("Only the claimant may transfer before the 24-hour force-claim threshold");
        }
      }
      const updated = await client.query(
        `UPDATE emails SET claimer_attendee_ref=$2, claimed_at=now(),
             approval_subject_hash=$3, approval_token_hash=$4,
             token_expires_at=$5, approval_token_consumed_at=NULL,
             card_version=card_version+1 WHERE id=$1 RETURNING card_version`,
        [mailId, targetAttendeeRef, target.rows[0].google_subject_hash, sha256(token), new Date(Date.now() + TOKEN_TTL_MS)],
      );
      if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Approval token issuance is unavailable");
      const tokenEnvelope = await this.crypto.encrypt(token, `mail:${mailId}:approval-token:${updated.rows[0].card_version}`);
      await client.query(`UPDATE emails SET approval_token_envelope=$2 WHERE id=$1`, [mailId, tokenEnvelope]);
      await this.#auditAndNotify(client, mailId, actor.attendeeRef, force ? "mail_force_claimed" : "mail_transferred");
      await client.query("COMMIT");
      return {
        success: true,
        mailId,
        cardVersion: updated.rows[0].card_version,
        detailAvailable: targetAttendeeRef === actor.attendeeRef,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #auditAndNotify(client, mailId, actorAttendeeRef, eventType) {
    await client.query(
      `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type) VALUES ($1,$2,$3)`,
      [mailId, actorAttendeeRef, eventType],
    );
    const notificationType = eventType === "mail_force_claimed" ? "mail_claimed" : eventType;
    const event = await client.query(
      `INSERT INTO event_inbox(mail_id,event_type,payload)
       SELECT id,$2,jsonb_build_object(
         'mailId',id::text,
         'claimerAttendeeRef',claimer_attendee_ref::text,
         'claimedAt',claimed_at
       ) FROM emails WHERE id=$1 RETURNING id`,
      [mailId, notificationType],
    );
    await client.query(
      `INSERT INTO event_inbox_recipients(event_id,target_attendee_ref)
       SELECT $1,m.attendee_ref FROM emails e JOIN business_unit_memberships m ON m.business_unit_ref=e.business_unit_ref
        JOIN business_units b ON b.id=m.business_unit_ref
        WHERE e.id=$2 AND b.disabled_at IS NULL
          AND m.active_from<=now() AND (m.active_until IS NULL OR m.active_until>now())`,
      [event.rows[0].id, mailId],
    );
  }
}
