import { forbidden, notFound } from "../lib/errors.js";

export class ResourceAuthorizer {
  constructor(db) {
    this.db = db;
  }

  async mail(actor, mailId, { requireClaim = false } = {}, queryable = this.db) {
    const { rows } = await queryable.query(
      `SELECT e.*,
              (e.owner_attendee_ref = $2) AS is_owner,
              EXISTS (
                SELECT 1 FROM business_unit_memberships m
                JOIN business_units b ON b.id = m.business_unit_ref
                 WHERE m.business_unit_ref = e.business_unit_ref
                   AND m.attendee_ref = $2
                   AND b.disabled_at IS NULL
                   AND m.active_from <= now()
                   AND (m.active_until IS NULL OR m.active_until > now())
              ) AS is_member
         FROM emails e
        WHERE e.id = $1`,
      [mailId, actor.attendeeRef],
    );
    const mail = rows[0];
    if (!mail || (!mail.is_owner && !mail.is_member)) throw notFound();
    if (requireClaim && mail.owner_attendee_ref !== actor.attendeeRef && mail.claimer_attendee_ref !== actor.attendeeRef) {
      throw forbidden("Only the current claimant may perform this command");
    }
    return mail;
  }

  async faqReviewer(actor, queryable = this.db) {
    const { rowCount } = await queryable.query(
      `SELECT 1 FROM user_roles
        WHERE attendee_ref = $1 AND role = 'faq_reviewer'
          AND revoked_at IS NULL`,
      [actor.attendeeRef],
    );
    if (rowCount !== 1) throw forbidden("FAQ reviewer permission is required");
  }

  async activeMembership(businessUnitRef, attendeeRef, queryable = this.db) {
    const { rowCount } = await queryable.query(
      `SELECT 1
         FROM business_unit_memberships m
         JOIN business_units b ON b.id=m.business_unit_ref
         JOIN users u ON u.attendee_ref=m.attendee_ref
        WHERE m.business_unit_ref=$1 AND m.attendee_ref=$2
          AND b.disabled_at IS NULL
          AND u.provisioning_status='active'
          AND m.active_from<=now()
          AND (m.active_until IS NULL OR m.active_until>now())`,
      [businessUnitRef, attendeeRef],
    );
    if (rowCount !== 1) throw forbidden("Active business-unit membership is required");
  }
}
