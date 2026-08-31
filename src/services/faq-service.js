import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound, serviceUnavailable } from "../lib/errors.js";

export class FaqService {
  constructor(db, authorizer, crypto) {
    this.db = db;
    this.authorizer = authorizer;
    this.crypto = crypto;
  }

  async getCandidate(candidateId, actor) {
    await this.authorizer.faqReviewer(actor);
    const { rows } = await this.db.query(
      `SELECT id,source_mail_id,content_envelope,expires_at FROM faq_candidates
        WHERE id=$1 AND status='pending' AND expires_at>now()`,
      [candidateId],
    );
    const candidate = rows[0];
    if (!candidate) throw notFound();
    await this.authorizer.mail(actor, candidate.source_mail_id);
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "FAQ candidate content is unavailable");
    const content = JSON.parse(await this.crypto.decrypt(candidate.content_envelope, `faq-candidate:${candidate.id}`));
    return {
      faqCandidateId: candidate.id,
      sourceMailId: candidate.source_mail_id,
      question: content.question,
      answer: content.answer,
      expiresAt: candidate.expires_at,
    };
  }

  async accept(input, actor) {
    if (input.piiReviewed !== true || !input.question?.trim() || !input.answer?.trim()) {
      throw badRequest("faq_review_required", "question, answer, and piiReviewed=true are required");
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await this.authorizer.faqReviewer(actor, client);
      if (!input.faqCandidateId) {
        if (input.sourceMailId) await this.authorizer.mail(actor, input.sourceMailId, {}, client);
        const faqId = randomUUID();
        await client.query(
          `INSERT INTO faq_entries(id,source_mail_id,question,answer,created_by_attendee_ref,pii_reviewed)
           VALUES ($1,$2,$3,$4,$5,true)`,
          [faqId, input.sourceMailId || null, input.question.trim(), input.answer.trim(), actor.attendeeRef],
        );
        if (input.sourceMailId) {
          await client.query(
            `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type,detail)
             VALUES ($1,$2,'faq_registered',jsonb_build_object('faqId',$3::text))`,
            [input.sourceMailId, actor.attendeeRef, faqId],
          );
        }
        await client.query("COMMIT");
        return { faqId, success: true };
      }
      const locked = await client.query(
        `SELECT id,source_mail_id,status,expires_at FROM faq_candidates WHERE id=$1 FOR UPDATE`,
        [input.faqCandidateId],
      );
      const candidate = locked.rows[0];
      if (!candidate || candidate.status !== "pending" || new Date(candidate.expires_at) <= new Date()) throw notFound();
      await this.authorizer.mail(actor, candidate.source_mail_id, {}, client);
      if (input.sourceMailId && input.sourceMailId !== candidate.source_mail_id) {
        throw badRequest("faq_source_mismatch", "sourceMailId does not match the candidate");
      }
      const faqId = randomUUID();
      await client.query(
        `INSERT INTO faq_entries(id,source_mail_id,source_candidate_id,question,answer,created_by_attendee_ref,pii_reviewed)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [faqId, candidate.source_mail_id, candidate.id, input.question.trim(), input.answer.trim(), actor.attendeeRef],
      );
      const consumed = await client.query(
        `UPDATE faq_candidates SET status='accepted',consumed_at=now() WHERE id=$1 AND status='pending'`,
        [candidate.id],
      );
      if (consumed.rowCount !== 1) throw conflict("faq_candidate_consumed", "FAQ candidate was already consumed");
      await client.query(
        `INSERT INTO timeline_events(mail_id,actor_attendee_ref,event_type,detail)
         VALUES ($1,$2,'faq_registered',jsonb_build_object('faqId',$3::text))`,
        [candidate.source_mail_id, actor.attendeeRef, faqId],
      );
      await client.query("COMMIT");
      return { faqId, success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
