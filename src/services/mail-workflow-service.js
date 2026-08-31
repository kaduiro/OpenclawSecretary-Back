import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "../lib/hash.js";
import { conflict, serviceUnavailable } from "../lib/errors.js";

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

function newToken() {
  return randomBytes(32).toString("base64url");
}

export class MailWorkflowService {
  constructor(db, authorizer, crypto, provider) {
    this.db = db;
    this.authorizer = authorizer;
    this.crypto = crypto;
    this.provider = provider;
  }

  async listTickets(actor, limit = 100) {
    const { rows } = await this.db.query(
      `SELECT e.id AS "mailId",e.status,e.claimer_attendee_ref AS "claimerAttendeeRef",
              e.claimed_at AS "claimedAt",e.subject,e.urgency,e.category,
              e.received_at AS "receivedAt",e.card_version AS "cardVersion",
              CASE WHEN e.claimer_attendee_ref IS NULL THEN 'unclaimed'
                   WHEN e.claimer_attendee_ref=$1 THEN 'mine'
                   ELSE 'other' END AS "claimState"
         FROM emails e
        WHERE e.owner_attendee_ref=$1 OR EXISTS (
          SELECT 1 FROM business_unit_memberships m
          JOIN business_units b ON b.id=m.business_unit_ref
           WHERE m.business_unit_ref=e.business_unit_ref AND m.attendee_ref=$1
             AND b.disabled_at IS NULL AND m.active_from<=now()
             AND (m.active_until IS NULL OR m.active_until>now())
        )
        ORDER BY e.received_at DESC LIMIT $2`,
      [actor.attendeeRef, limit],
    );
    return { tickets: rows, nextCursor: null };
  }

  async detail(mailId, actor) {
    const mail = await this.authorizer.mail(actor, mailId);
    const mayReadSensitive = mail.owner_attendee_ref === actor.attendeeRef || mail.claimer_attendee_ref === actor.attendeeRef;
    const decrypt = async (envelope, aad) => {
      if (!mayReadSensitive || !envelope) return null;
      if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Sensitive mail content is temporarily unavailable");
      return this.crypto.decrypt(envelope, aad);
    };
    const usableToken = mayReadSensitive && mail.approval_token_envelope &&
      !mail.approval_token_consumed_at && new Date(mail.token_expires_at) > new Date();
    return {
      mailId: mail.id,
      cardVersion: mail.card_version,
      approvalToken: usableToken ? await decrypt(mail.approval_token_envelope, `mail:${mailId}:approval-token:${mail.card_version}`) : null,
      tokenExpiresAt: mail.token_expires_at,
      cardType: mail.card_type,
      canApprove: Boolean(usableToken && mail.reply_draft_envelope && mail.analysis_status === "succeeded"),
      claimRequired: Boolean(mail.business_unit_ref && !mail.claimer_attendee_ref),
      analysisStatus: mail.analysis_status,
      failureReasonCode: mail.failure_reason_code,
      subject: mail.subject,
      senderDisplayName: mail.sender_display_name || "",
      urgency: mail.urgency,
      category: mail.category,
      bodyPreview: await decrypt(mail.body_preview_envelope, `mail:${mailId}:body-preview`),
      summary: mail.summary || "",
      intent: mail.intent || "",
      actions: mail.actions || [],
      replyDraft: await decrypt(mail.reply_draft_envelope, `mail:${mailId}:reply-draft`),
      calendarProposals: [],
      claimerAttendeeRef: mail.claimer_attendee_ref,
      claimedAt: mail.claimed_at,
    };
  }

  async reissueToken(mailId, actor) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Approval token issuance is unavailable");
    const token = newToken();
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const mail = await this.authorizer.mail(actor, mailId, { requireClaim: true }, client);
      if (!["pending_reply_approval", "draft_missing", "未対応", "対応中"].includes(mail.status)) {
        throw conflict("mail_not_pending", "The mail can no longer issue an approval token");
      }
      const version = Number(mail.card_version) + 1;
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      const envelope = await this.crypto.encrypt(token, `mail:${mailId}:approval-token:${version}`);
      await client.query(
        `UPDATE emails SET card_version=$2,approval_token_hash=$3,approval_token_envelope=$4,
             approval_subject_hash=$5,token_expires_at=$6,approval_token_consumed_at=NULL WHERE id=$1`,
        [mailId, version, sha256(token), envelope, actor.subjectHash, expiresAt],
      );
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type) VALUES ($1,$2,'token_reissued')`,
        [mailId, actor.attendeeRef],
      );
      await client.query("COMMIT");
      return { approvalToken: token, cardVersion: version, tokenExpiresAt: expiresAt };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reject(mailId, input, actor) {
    const client = await this.db.connect();
    let draftId;
    let gmailId;
    try {
      await client.query("BEGIN");
      const mail = await this.authorizer.mail(actor, mailId, { requireClaim: true }, client);
      const valid = await client.query(
        `SELECT 1 FROM emails WHERE id=$1 AND card_version=$2 AND approval_token_hash=$3
          AND approval_subject_hash=$4 AND approval_token_consumed_at IS NULL AND token_expires_at>now() FOR UPDATE`,
        [mailId, input.cardVersion, sha256(input.approvalToken), actor.subjectHash],
      );
      if (valid.rowCount !== 1) throw conflict("approval_token_invalid", "Approval token is invalid, expired, or stale");
      draftId = mail.draft_id;
      gmailId = mail.gmail_id;
      await client.query(
        `UPDATE emails SET status='保留',reply_draft_envelope=NULL,draft_id=NULL,
             approval_token_hash=NULL,approval_token_envelope=NULL,approval_token_consumed_at=now(),token_expires_at=NULL
          WHERE id=$1`,
        [mailId],
      );
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type) VALUES ($1,$2,'draft_deleted')`,
        [mailId, actor.attendeeRef],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    try {
      if (draftId && this.provider?.deleteDraft) await this.provider.deleteDraft({ draftId, mailId });
      return { success: true, gmailMessageId: gmailId, warning: null, correlationId: null, manualAction: null };
    } catch {
      return { success: true, gmailMessageId: gmailId, warning: "draft_delete_failed", correlationId: randomUUID(), manualAction: "delete_draft_manually" };
    }
  }

  async approve(mailId, input, actor) {
    if (!this.provider?.sendReply) throw serviceUnavailable("gmail_provider_unavailable", "Gmail sending is not configured");
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Reply draft is unavailable");
    const client = await this.db.connect();
    let operation;
    try {
      await client.query("BEGIN");
      const mail = await this.authorizer.mail(actor, mailId, { requireClaim: true }, client);
      const existing = await client.query(
        `SELECT * FROM mail_send_operations WHERE mail_id=$1 AND card_version=$2 FOR UPDATE`,
        [mailId, input.cardVersion],
      );
      if (existing.rows[0]) {
        operation = { ...existing.rows[0], gmailId: mail.gmail_id };
        if (operation.status === "prepared" && mail.reply_draft_envelope) {
          operation.replyDraft = await this.crypto.decrypt(mail.reply_draft_envelope, `mail:${mailId}:reply-draft`);
        }
      } else {
        const valid = await client.query(
          `SELECT 1 FROM emails WHERE id=$1 AND card_version=$2 AND approval_token_hash=$3
            AND approval_subject_hash=$4 AND approval_token_consumed_at IS NULL AND token_expires_at>now() FOR UPDATE`,
          [mailId, input.cardVersion, sha256(input.approvalToken), actor.subjectHash],
        );
        if (valid.rowCount !== 1 || !mail.reply_draft_envelope) {
          throw conflict("approval_token_invalid", "Approval token is invalid, expired, or stale");
        }
        const operationId = randomUUID();
        const marker = `openclaw-${mailId}-${input.cardVersion}`;
        const inserted = await client.query(
          `INSERT INTO mail_send_operations(id,mail_id,card_version,status,draft_id,operation_marker)
           VALUES ($1,$2,$3,'prepared',$4,$5) RETURNING *`,
          [operationId, mailId, input.cardVersion, mail.draft_id, marker],
        );
        operation = {
          ...inserted.rows[0],
          gmailId: mail.gmail_id,
          replyDraft: await this.crypto.decrypt(mail.reply_draft_envelope, `mail:${mailId}:reply-draft`),
        };
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (operation.status === "succeeded") {
      return {
        success: true,
        mailId,
        operationId: operation.id,
        status: "succeeded",
        messageId: operation.provider_message_id,
      };
    }
    if (["sending", "reconciling", "result_unknown"].includes(operation.status)) {
      return { success: false, mailId, operationId: operation.id, status: "result_unknown", messageId: null };
    }
    if (operation.status === "failed_terminal") {
      throw conflict("mail_send_failed_terminal", "The previous send attempt requires manual review");
    }

    try {
      const prepared = this.provider.prepareReply
        ? await this.provider.prepareReply({
          mailId,
          draftId: operation.draft_id,
          operationMarker: operation.operation_marker,
        })
        : {};
      operation.provider_thread_id = prepared.threadId || operation.provider_thread_id;
      await this.db.query(
        `UPDATE mail_send_operations SET status='sending',provider_thread_id=$2 WHERE id=$1`,
        [operation.id, operation.provider_thread_id || null],
      );
    } catch (error) {
      await this.db.query(
        `UPDATE mail_send_operations SET status='failed_terminal',last_error_code=$2,resolved_at=now() WHERE id=$1`,
        [operation.id, error.code || "draft_prepare_failed"],
      );
      throw serviceUnavailable("gmail_draft_prepare_failed", "Gmail draft could not be prepared for idempotent sending");
    }

    try {
      const sent = await this.provider.sendReply({
        mailId,
        gmailMessageId: operation.gmailId,
        draftId: operation.draft_id,
        replyDraft: operation.replyDraft,
        operationMarker: operation.operation_marker,
      });
      await this.db.query(
        `UPDATE mail_send_operations SET status='succeeded',provider_message_id=$2,provider_thread_id=COALESCE($3,provider_thread_id),
             reconcile_lease_until=NULL,resolved_at=now() WHERE id=$1`,
        [operation.id, sent.messageId, sent.threadId || null],
      );
      await this.db.query(
        `UPDATE emails SET status='回答済み',approval_token_consumed_at=now(),approval_token_hash=NULL,
             approval_token_envelope=NULL,token_expires_at=NULL WHERE id=$1`,
        [mailId],
      );
      return { success: true, mailId, operationId: operation.id, status: "succeeded", messageId: sent.messageId };
    } catch (error) {
      await this.db.query(
        `UPDATE mail_send_operations SET status='result_unknown',last_error_code=$2,
             next_attempt_at=now()+interval '30 seconds',reconcile_lease_until=NULL WHERE id=$1`,
        [operation.id, error.code || "gmail_send_result_unknown"],
      );
      return { success: false, mailId, operationId: operation.id, status: "result_unknown", messageId: null };
    }
  }
}
