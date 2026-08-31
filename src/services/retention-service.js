export class RetentionService {
  constructor(db, { batchSize = 500 } = {}) {
    this.db = db;
    this.batchSize = batchSize;
  }

  async run() {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const inbox = await client.query(
        `DELETE FROM event_inbox WHERE id IN (
           SELECT e.id FROM event_inbox e
            WHERE e.hard_expires_at<now() OR (
              NOT EXISTS (SELECT 1 FROM event_inbox_recipients r WHERE r.event_id=e.id AND r.acked_at IS NULL)
              AND (SELECT max(r.acked_at) FROM event_inbox_recipients r WHERE r.event_id=e.id)<now()-interval '7 days'
            )
            ORDER BY e.created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )`,
        [this.batchSize],
      );
      const candidates = await client.query(
        `DELETE FROM faq_candidates WHERE id IN (
           SELECT id FROM faq_candidates
            WHERE (status='pending' AND expires_at<now()) OR
                  (status IN ('accepted','expired') AND created_at<now()-interval '90 days')
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )`,
        [this.batchSize],
      );
      const approvals = await client.query(
        `UPDATE proposal_approvals SET rejection_reason_detail=NULL
          WHERE (proposal_id,attendee_ref) IN (
            SELECT proposal_id,attendee_ref FROM proposal_approvals
             WHERE rejection_reason_detail IS NOT NULL AND created_at<now()-interval '90 days'
             ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
          )`,
        [this.batchSize],
      );
      const masked = await client.query(
        `UPDATE emails SET subject='[retained record]',sender_display_name='',sender_address_envelope=NULL,
             body_preview_envelope=NULL,summary='',intent='',actions='[]'::jsonb,
             reply_draft_envelope=NULL,approval_token_envelope=NULL,approval_token_hash=NULL,
             approval_subject_hash=NULL,draft_id=NULL,pii_masked_at=now()
          WHERE id IN (
            SELECT id FROM emails WHERE status IN ('回答済み','解決済み','保留')
              AND updated_at<now()-interval '90 days' AND pii_masked_at IS NULL
            ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $1
          ) RETURNING id`,
        [this.batchSize],
      );
      if (masked.rows.length) {
        await client.query(`DELETE FROM sent_reply_embeddings WHERE mail_id=ANY($1::uuid[])`, [masked.rows.map((row) => row.id)]);
      }
      const oauth = await client.query(
        `DELETE FROM oauth_sessions WHERE id IN (
           SELECT id FROM oauth_sessions
            WHERE consumed_at<now()-interval '1 day' OR expired_at<now()-interval '1 day'
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )`,
        [this.batchSize],
      );
      const outbox = await client.query(
        `DELETE FROM outbox_events WHERE id IN (
           SELECT id FROM outbox_events WHERE
             (status='dispatched' AND dispatched_at<now()-interval '30 days') OR
             (status='dead_letter' AND resolved_at IS NOT NULL AND resolved_at<now()-interval '180 days')
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )`,
        [this.batchSize],
      );
      await client.query("COMMIT");
      return {
        eventInboxDeleted: inbox.rowCount,
        faqCandidatesDeleted: candidates.rowCount,
        rejectionDetailsCleared: approvals.rowCount,
        emailsMasked: masked.rowCount,
        oauthSessionsDeleted: oauth.rowCount,
        outboxDeleted: outbox.rowCount,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
