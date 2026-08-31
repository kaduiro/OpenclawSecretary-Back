import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, forbidden, notFound, serviceUnavailable } from "../lib/errors.js";

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

function newToken() {
  return randomBytes(32).toString("base64url");
}

function sanitizeDetail(value) {
  if (!value) return null;
  return value
    .slice(0, 500)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(?:ya29\.|Bearer\s+)[A-Za-z0-9._~-]+/gi, "[redacted-token]");
}

export class CalendarService {
  constructor(db, authorizer, crypto, provider) {
    this.db = db;
    this.authorizer = authorizer;
    this.crypto = crypto;
    this.provider = provider;
  }

  async #load(proposalId, actor, queryable = this.db, lock = false) {
    const { rows } = await queryable.query(
      `SELECT p.*,e.owner_attendee_ref,e.business_unit_ref,e.claimer_attendee_ref,e.gmail_id,e.status AS mail_status
         FROM calendar_proposals p JOIN emails e ON e.id=p.mail_id
        WHERE p.id=$1 ${lock ? "FOR UPDATE OF p" : ""}`,
      [proposalId],
    );
    const proposal = rows[0];
    if (!proposal) throw notFound();
    await this.authorizer.mail(actor, proposal.mail_id, {}, queryable);
    return proposal;
  }

  async get(proposalId, actor) {
    const proposal = await this.#load(proposalId, actor);
    const { rows } = await this.db.query(
      `SELECT status,token_envelope,token_expires_at,card_version
         FROM proposal_approvals WHERE proposal_id=$1 AND attendee_ref=$2`,
      [proposalId, actor.attendeeRef],
    );
    const approval = rows[0];
    let approvalToken;
    if (proposal.status === "active" && approval?.status === "pending" && approval.token_envelope &&
        new Date(approval.token_expires_at) > new Date()) {
      if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Calendar approval token is unavailable");
      approvalToken = await this.crypto.decrypt(approval.token_envelope, `calendar:${proposalId}:${actor.attendeeRef}:${approval.card_version}`);
    }
    return {
      proposalId: proposal.id,
      parentProposalId: proposal.parent_proposal_id,
      revision: proposal.revision,
      ...(approvalToken ? { approvalToken } : {}),
      cardVersion: approval?.card_version || 1,
      tokenExpiresAt: approval?.token_expires_at || null,
      status: proposal.status,
      slots: proposal.slots || [],
      candidateCount: (proposal.slots || []).length,
      candidateLimitReason: (proposal.slots || []).length ? null : "no_common_free_slot",
      alternativeSuggestions: [],
      unavailableAttendees: [],
    };
  }

  async reissueToken(proposalId, actor) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Calendar approval token is unavailable");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const proposal = await this.#load(proposalId, actor, client, true);
      if (proposal.status !== "active") throw conflict("proposal_superseded", "Calendar proposal is no longer active");
      const expiredSlot = (proposal.slots || []).some((slot) => new Date(slot.slotStart) <= new Date());
      const approval = await client.query(
        `SELECT * FROM proposal_approvals WHERE proposal_id=$1 AND attendee_ref=$2 FOR UPDATE`,
        [proposalId, actor.attendeeRef],
      );
      if (!approval.rows[0] || approval.rows[0].status !== "pending") throw conflict("approval_already_decided", "Approval is already decided");
      if (expiredSlot) {
        await client.query("COMMIT");
        return {
          cardVersion: approval.rows[0].card_version,
          tokenExpiresAt: approval.rows[0].token_expires_at,
          slotExpired: true,
          candidateLimitReason: "SLOT_EXPIRED",
        };
      }
      const token = newToken();
      const version = Number(approval.rows[0].card_version) + 1;
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      const envelope = await this.crypto.encrypt(token, `calendar:${proposalId}:${actor.attendeeRef}:${version}`);
      await client.query(
        `UPDATE proposal_approvals SET token_hash=$3,token_envelope=$4,token_expires_at=$5,card_version=$6
          WHERE proposal_id=$1 AND attendee_ref=$2`,
        [proposalId, actor.attendeeRef, sha256(token), envelope, expiresAt, version],
      );
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type)
         VALUES ($1,$2,'token_reissued')`,
        [proposal.mail_id, actor.attendeeRef],
      );
      await client.query("COMMIT");
      return { approvalToken: token, cardVersion: version, tokenExpiresAt: expiresAt, slotExpired: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async approve(proposalId, input, actor) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Calendar execution planning is unavailable");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const proposal = await this.#load(proposalId, actor, client, true);
      if (proposal.status !== "active") throw conflict("proposal_superseded", "Calendar proposal is no longer active");
      if (!(proposal.slots || []).some((slot) => slot.slotId === input.selectedSlotId)) {
        throw conflict("calendar_slot_invalid", "Selected slot is not part of the current proposal");
      }
      const decided = await client.query(
        `UPDATE proposal_approvals SET status='approved',selected_slot_id=$5,decided_at=now(),token_envelope=NULL
          WHERE proposal_id=$1 AND attendee_ref=$2 AND status='pending' AND card_version=$3
            AND token_hash=$4 AND token_expires_at>now()
        RETURNING attendee_ref`,
        [proposalId, actor.attendeeRef, input.cardVersion, sha256(input.approvalToken), input.selectedSlotId],
      );
      if (decided.rowCount !== 1) throw conflict("approval_token_invalid", "Approval token is invalid, expired, or stale");
      const aggregate = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status='approved')::int AS approved,
                count(*) FILTER (WHERE status='rejected')::int AS rejected,
                count(DISTINCT selected_slot_id) FILTER (WHERE status='approved')::int AS selections,
                array_agg(attendee_ref) AS attendees
           FROM proposal_approvals WHERE proposal_id=$1`,
        [proposalId],
      );
      const state = aggregate.rows[0];
      if (state.rejected > 0) {
        await client.query("COMMIT");
        return { aggregateApprovalStatus: "any_rejected" };
      }
      if (state.selections > 1) {
        await client.query(`UPDATE calendar_proposals SET status='manual_review_required' WHERE id=$1`, [proposalId]);
        await client.query(
          `INSERT INTO timeline_events(mail_id,event_type) VALUES ($1,'cal_selection_conflict')`,
          [proposal.mail_id],
        );
        await client.query("COMMIT");
        return { aggregateApprovalStatus: "selection_conflict" };
      }
      if (state.approved !== state.total) {
        await client.query("COMMIT");
        return { aggregateApprovalStatus: "pending_all" };
      }
      const selectedSlot = proposal.slots.find((slot) => slot.slotId === input.selectedSlotId);
      const operationId = randomUUID();
      const plan = { proposalId, mailId: proposal.mail_id, selectedSlot, attendees: state.attendees };
      const serialized = JSON.stringify(plan);
      const envelope = await this.crypto.encrypt(serialized, `calendar-operation:${operationId}`);
      const inserted = await client.query(
        `INSERT INTO calendar_operations(id,proposal_id,status,execution_plan_envelope,plan_digest)
         VALUES ($1,$2,'pending',$3,$4)
         ON CONFLICT (proposal_id) DO UPDATE SET updated_at=now()
         RETURNING id`,
        [operationId, proposalId, envelope, sha256(serialized)],
      );
      const persistedOperationId = inserted.rows[0].id;
      await client.query(`UPDATE calendar_proposals SET status='execution_pending',selected_slot_id=$2 WHERE id=$1`, [proposalId, input.selectedSlotId]);
      await client.query(
        `INSERT INTO outbox_events(event_type,aggregate_id,payload)
         VALUES ('calendar_operation_execute',$1,jsonb_build_object('operationId',$1::text))
         ON CONFLICT (event_type,aggregate_id) WHERE event_type='calendar_operation_execute' DO NOTHING`,
        [persistedOperationId],
      );
      await client.query("COMMIT");
      return { aggregateApprovalStatus: "all_approved", operationId: persistedOperationId, status: "in_progress" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reject(proposalId, input, actor) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const proposal = await this.#load(proposalId, actor, client, true);
      if (proposal.status !== "active") throw conflict("proposal_superseded", "Calendar proposal is no longer active");
      const decided = await client.query(
        `UPDATE proposal_approvals SET status='rejected',rejection_reason_code=$5,
             rejection_reason_detail=$6,rejection_constraints=$7,decided_at=now(),token_envelope=NULL
          WHERE proposal_id=$1 AND attendee_ref=$2 AND status='pending' AND card_version=$3
            AND token_hash=$4 AND token_expires_at>now()`,
        [proposalId, actor.attendeeRef, input.cardVersion, sha256(input.approvalToken),
          input.rejectionReasonCode, sanitizeDetail(input.rejectionReasonDetail),
          { rejectedSlotIds: input.rejectedSlotIds || [], preferredWindows: input.preferredWindows || [] }],
      );
      if (decided.rowCount !== 1) throw conflict("approval_token_invalid", "Approval token is invalid, expired, or stale");
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type,detail)
         VALUES ($1,$2,'cal_participant_rejected',jsonb_build_object('reasonCode',$3::text))`,
        [proposal.mail_id, actor.attendeeRef, input.rejectionReasonCode],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const reasonMap = {
      no_common_slot: "expand_period",
      needs_more_options: "expand_period",
      poor_context: "avoid_high_priority_neighbors",
      outside_requested_period: "expand_period",
      missing_participant: "reduce_attendees",
    };
    try {
      await this.alternative(proposalId, {
        replanReasonCode: reasonMap[input.rejectionReasonCode] || "manual_review_requested",
      }, actor);
    } catch (error) {
      await this.db.query(
        `UPDATE calendar_proposals SET status='manual_review_required'
          WHERE id=$1 AND status='active'`,
        [proposalId],
      );
      console.error(JSON.stringify({ severity: "ERROR", event: "calendar_replan_failed", proposalId, code: error.code || "replan_failed" }));
    }
    return { success: true, proposalId };
  }

  async cancel(proposalId, actor) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const proposal = await this.#load(proposalId, actor, client, true);
      const mail = await this.authorizer.mail(actor, proposal.mail_id, { requireClaim: true }, client);
      if (!["active", "execution_pending", "manual_review_required"].includes(proposal.status)) {
        throw conflict("proposal_superseded", "Calendar proposal cannot be cancelled");
      }
      await client.query(`UPDATE calendar_proposals SET status='cancelled' WHERE id=$1`, [proposalId]);
      await client.query(`UPDATE proposal_approvals SET status='invalidated',token_envelope=NULL WHERE proposal_id=$1 AND status='pending'`, [proposalId]);
      await client.query(`UPDATE emails SET status='pending_reply_approval' WHERE id=$1`, [proposal.mail_id]);
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type) VALUES ($1,$2,'cal_cancelled')`,
        [proposal.mail_id, actor.attendeeRef],
      );
      await client.query("COMMIT");
      return { success: true, proposalId, mailStatus: "pending_reply_approval", gmailMessageId: mail.gmail_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async alternative(proposalId, input, actor) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Calendar proposal generation is unavailable");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const proposal = await this.#load(proposalId, actor, client, true);
      if (proposal.revision >= 3) throw conflict("max_revisions_reached", "Maximum calendar proposal revisions reached");
      if (!["active", "manual_review_required"].includes(proposal.status)) throw conflict("proposal_superseded", "Proposal is not eligible for replanning");
      const rejected = await client.query(
        `SELECT rejection_constraints FROM proposal_approvals WHERE proposal_id=$1 AND status='rejected'`,
        [proposalId],
      );
      const rejectedIds = new Set(rejected.rows.flatMap((row) => row.rejection_constraints?.rejectedSlotIds || []));
      let slots = (proposal.slots || []).filter((slot) => !rejectedIds.has(slot.slotId));
      if (this.provider?.generateAlternatives) {
        slots = await this.provider.generateAlternatives({ proposal, input, rejectedSlotIds: [...rejectedIds] });
      }
      const newId = randomUUID();
      const status = slots.length ? "active" : "manual_review_required";
      await client.query(
        `INSERT INTO calendar_proposals(id,mail_id,parent_proposal_id,revision,status,slots)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId, proposal.mail_id, proposalId, Number(proposal.revision) + 1, status, slots],
      );
      const participants = await client.query(`SELECT attendee_ref FROM proposal_approvals WHERE proposal_id=$1`, [proposalId]);
      for (const participant of participants.rows) {
        const token = newToken();
        const envelope = await this.crypto.encrypt(token, `calendar:${newId}:${participant.attendee_ref}:1`);
        await client.query(
          `INSERT INTO proposal_approvals(proposal_id,attendee_ref,token_hash,token_envelope,token_expires_at,card_version)
           VALUES ($1,$2,$3,$4,now()+interval '72 hours',1)`,
          [newId, participant.attendee_ref, sha256(token), envelope],
        );
      }
      await client.query(`UPDATE calendar_proposals SET status='superseded' WHERE id=$1`, [proposalId]);
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type,detail)
         VALUES ($1,$2,'cal_replanned',jsonb_build_object('proposalId',$3::text,'parentProposalId',$4::text))`,
        [proposal.mail_id, actor.attendeeRef, newId, proposalId],
      );
      const event = await client.query(
        `INSERT INTO event_inbox(mail_id,event_type,payload)
         VALUES ($1,'calendar_alternatives_ready',jsonb_build_object(
           'mailId',$1::text,'proposalId',$2::text,'parentProposalId',$3::text,
           'cardVersion',1,'tokenExpiresAt',now()+interval '72 hours')) RETURNING id`,
        [proposal.mail_id, newId, proposalId],
      );
      await client.query(
        `INSERT INTO event_inbox_recipients(event_id,target_attendee_ref)
         SELECT $1,attendee_ref FROM proposal_approvals WHERE proposal_id=$2`,
        [event.rows[0].id, newId],
      );
      await client.query("COMMIT");
      return this.get(newId, actor);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async operation(operationId, actor) {
    const { rows } = await this.db.query(
      `SELECT o.id,o.status,o.last_error_code,p.mail_id
         FROM calendar_operations o JOIN calendar_proposals p ON p.id=o.proposal_id WHERE o.id=$1`,
      [operationId],
    );
    if (!rows[0]) throw notFound();
    await this.authorizer.mail(actor, rows[0].mail_id);
    const resultRows = await this.db.query(
      `SELECT attendee_ref AS "attendeeRef",status,error_code AS "errorCode"
         FROM calendar_operation_results WHERE operation_id=$1`,
      [operationId],
    );
    const statusMap = { pending: "dispatch_pending", running: "in_progress" };
    return {
      operationId,
      status: statusMap[rows[0].status] || rows[0].status,
      correlationId: null,
      results: resultRows.rows,
      manualRemediationRequired: ["partial_failed", "failed", "result_unknown"].includes(rows[0].status),
    };
  }

  async execute(operationId) {
    if (!this.provider?.upsertEvent) throw serviceUnavailable("calendar_provider_unavailable", "Calendar execution is not configured");
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Calendar execution plan is unavailable");
    const leased = await this.db.query(
      `UPDATE calendar_operations SET status='running',lease_id=$2,lease_expires_at=now()+interval '5 minutes',attempts=attempts+1
        WHERE id=$1 AND status IN ('pending','running','result_unknown')
          AND (lease_expires_at IS NULL OR lease_expires_at<now()) RETURNING *`,
      [operationId, randomUUID()],
    );
    const operation = leased.rows[0];
    if (!operation) throw conflict("operation_not_executable", "Calendar operation is already running or complete");
    const plan = JSON.parse(await this.crypto.decrypt(operation.execution_plan_envelope, `calendar-operation:${operationId}`));
    let failed = 0;
    for (const attendeeRef of plan.attendees) {
      try {
        const result = await this.provider.upsertEvent({ operationId, attendeeRef, slot: plan.selectedSlot });
        await this.db.query(
          `INSERT INTO calendar_operation_results(operation_id,attendee_ref,status,provider_event_id)
           VALUES ($1,$2,'succeeded',$3)
           ON CONFLICT (operation_id,attendee_ref) DO UPDATE SET status='succeeded',provider_event_id=EXCLUDED.provider_event_id,error_code=NULL,updated_at=now()`,
          [operationId, attendeeRef, result.eventId],
        );
      } catch (error) {
        failed += 1;
        await this.db.query(
          `INSERT INTO calendar_operation_results(operation_id,attendee_ref,status,error_code)
           VALUES ($1,$2,'failed',$3)
           ON CONFLICT (operation_id,attendee_ref) DO UPDATE SET status='failed',error_code=EXCLUDED.error_code,updated_at=now()`,
          [operationId, attendeeRef, error.code || "calendar_write_failed"],
        );
      }
    }
    const status = failed === 0 ? "succeeded" : failed === plan.attendees.length ? "failed" : "partial_failed";
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE calendar_operations SET status=$2,lease_id=NULL,lease_expires_at=NULL,resolved_at=now() WHERE id=$1`,
        [operationId, status],
      );
      const proposal = await client.query(
        `UPDATE calendar_proposals SET status=CASE
             WHEN $2='succeeded' THEN 'executed'
             WHEN $2='partial_failed' THEN 'executed_with_failures'
             ELSE 'manual_review_required'
           END
          WHERE id=(SELECT proposal_id FROM calendar_operations WHERE id=$1) RETURNING id,mail_id`,
        [operationId, status],
      );
      const resultRows = await client.query(
        `SELECT status,error_code AS "errorCode" FROM calendar_operation_results WHERE operation_id=$1`,
        [operationId],
      );
      const succeededAttendees = resultRows.rows.filter((row) => row.status === "succeeded");
      const failedAttendees = resultRows.rows.filter((row) => row.status === "failed");
      const correlationId = randomUUID();
      const payload = status === "succeeded"
        ? { operationId, succeededAttendees }
        : { operationId, succeededAttendees, failedAttendees, correlationId, manualRemediationRequired: true };
      const event = await client.query(
        `INSERT INTO event_inbox(mail_id,event_type,payload)
         VALUES ($1,$2,$3) RETURNING id`,
        [proposal.rows[0].mail_id, status === "succeeded" ? "calendar_operation_succeeded" : "calendar_operation_failed", payload],
      );
      await client.query(
        `INSERT INTO event_inbox_recipients(event_id,target_attendee_ref)
         SELECT $1,attendee_ref FROM proposal_approvals WHERE proposal_id=$2`,
        [event.rows[0].id, proposal.rows[0].id],
      );
      await client.query(
        `INSERT INTO timeline_events(mail_id,event_type,detail)
         VALUES ($1,$2,jsonb_build_object('operationId',$3::text))`,
        [proposal.rows[0].mail_id, status === "succeeded" ? "cal_succeeded" : "cal_partial_failed", operationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { accepted: true, status, operationId };
  }
}
