import { randomUUID } from "node:crypto";
import { sha256Hex } from "../lib/hash.js";
import { badRequest, conflict } from "../lib/errors.js";

function normalizeEmail(email) {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw badRequest("invalid_email", "A valid Workspace email is required");
  }
  return normalized;
}

export class AdminUserService {
  constructor(db) {
    this.db = db;
  }

  async preRegister({ email, businessUnitRef, role = "member" }, actorEmail) {
    const normalizedEmail = normalizeEmail(email);
    if (!new Set(["member", "manager", "faq_reviewer"]).has(role)) {
      throw badRequest("invalid_membership_role", "Unsupported business-unit membership role");
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const unit = await client.query(`SELECT id FROM business_units WHERE id=$1 AND disabled_at IS NULL FOR SHARE`, [businessUnitRef]);
      if (unit.rowCount !== 1) throw badRequest("business_unit_not_found", "Active business unit not found");
      const emailHash = sha256Hex(normalizedEmail);
      const existing = await client.query(
        `SELECT id,attendee_ref,provisioning_status FROM users WHERE email_hash=$1 FOR UPDATE`,
        [emailHash],
      );
      const userId = existing.rows[0]?.id || randomUUID();
      const attendeeRef = existing.rows[0]?.attendee_ref || randomUUID();
      const provisioningStatus = existing.rows[0]?.provisioning_status || "pending_subject_bind";
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO users(id, attendee_ref, email_hash, pending_email_hash, workspace_access_type, provisioning_status)
           VALUES ($1,$2,$3,$3,'business_unit_dwd','pending_subject_bind')`,
          [userId, attendeeRef, emailHash],
        );
      } else if (provisioningStatus === "disabled") {
        throw conflict("user_disabled", "A disabled user cannot receive a new membership");
      }
      const membershipRole = role === "faq_reviewer" ? "member" : role;
      await client.query(
        `INSERT INTO business_unit_memberships(business_unit_ref, attendee_ref, role, created_by)
         VALUES ($1,$2,$3,$4)`,
        [businessUnitRef, attendeeRef, membershipRole, actorEmail],
      );
      if (role === "faq_reviewer") {
        await client.query(
          `INSERT INTO user_roles(attendee_ref,role,granted_by) VALUES ($1,'faq_reviewer',$2)
           ON CONFLICT (attendee_ref,role) WHERE revoked_at IS NULL DO NOTHING`,
          [attendeeRef, actorEmail],
        );
      }
      await client.query(
        `INSERT INTO user_invitations(email_hash,business_unit_ref,role,created_by,consumed_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [emailHash, businessUnitRef, role, actorEmail, provisioningStatus === "active" ? new Date() : null],
      );
      await client.query("COMMIT");
      return { success: true, userId, attendeeRef, provisioningStatus };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") throw conflict("user_already_registered", "The user or membership is already registered");
      throw error;
    } finally {
      client.release();
    }
  }

  async createBusinessUnit({ name, calendarAccount }, actorEmail) {
    const normalizedAccount = normalizeEmail(calendarAccount);
    if (!name?.trim()) throw badRequest("invalid_business_unit_name", "Business unit name is required");
    try {
      const { rows } = await this.db.query(
        `INSERT INTO business_units(name, calendar_account) VALUES ($1,$2)
         RETURNING id AS "businessUnitRef", name, calendar_account AS "calendarAccount"`,
        [name.trim(), normalizedAccount],
      );
      return { ...rows[0], disabled: false, members: [] };
    } catch (error) {
      if (error.code === "23505") throw conflict("business_unit_exists", "An active business unit already uses this calendar account");
      throw error;
    }
  }

  async disableBusinessUnit(businessUnitRef) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE business_units SET disabled_at=COALESCE(disabled_at,now()) WHERE id=$1
         RETURNING id AS "businessUnitRef", disabled_at AS "disabledAt"`,
        [businessUnitRef],
      );
      if (!rows[0]) throw badRequest("business_unit_not_found", "Business unit not found");
      await client.query(
        `UPDATE emails SET claimer_attendee_ref=NULL,claimed_at=NULL,
             approval_subject_hash=NULL,approval_token_hash=NULL,approval_token_envelope=NULL,
             token_expires_at=NULL,approval_token_consumed_at=NULL,card_version=card_version+1
          WHERE business_unit_ref=$1 AND claimer_attendee_ref IS NOT NULL`,
        [businessUnitRef],
      );
      await client.query(
        `UPDATE business_unit_memberships SET active_until=LEAST(COALESCE(active_until,now()),now())
          WHERE business_unit_ref=$1 AND active_from<now()
            AND (active_until IS NULL OR active_until>now())`,
        [businessUnitRef],
      );
      await client.query("COMMIT");
      return rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async bindFirstLogin({ email, subject }) {
    const pendingEmailHash = sha256Hex(normalizeEmail(email));
    const subjectHash = sha256Hex(subject);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE users
            SET google_subject_hash=$1, pending_email_hash=NULL,
                provisioning_status='active', subject_bound_at=now(), updated_at=now()
          WHERE pending_email_hash=$2 AND google_subject_hash IS NULL
            AND provisioning_status='pending_subject_bind'
        RETURNING id,attendee_ref`,
        [subjectHash, pendingEmailHash],
      );
      if (!rows[0]) throw conflict("subject_bind_failed", "No matching pending registration or subject already bound");
      await client.query(
        `UPDATE user_invitations SET consumed_at=COALESCE(consumed_at,now())
          WHERE email_hash=$1 AND consumed_at IS NULL`,
        [pendingEmailHash],
      );
      await client.query(
        `INSERT INTO timeline_events(actor_attendee_ref,event_type) VALUES ($1,'user_bound')`,
        [rows[0].attendee_ref],
      );
      await client.query("COMMIT");
      return rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
