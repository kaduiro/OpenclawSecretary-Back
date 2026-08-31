import { createHash } from "node:crypto";
import { badRequest, conflict } from "../lib/errors.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function settingsEtag(revision, value) {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("base64url");
  return `\"${revision}-${digest}\"`;
}

export function validateSettings(next, current) {
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    throw badRequest("invalid_settings", "Settings must be a JSON object");
  }
  const required = ["organizationDomain", "businessHours", "schedulingPolicy", "pollEnabled", "faqCategories", "dwdAllowlistEmails"];
  const missing = required.filter((key) => !Object.hasOwn(next, key));
  if (missing.length > 0) {
    throw badRequest("settings_incomplete", `Full settings replacement is required: ${missing.join(", ")}`);
  }
  if (Object.hasOwn(next, "businessUnits")) {
    throw badRequest("business_units_read_only", "Manage business units through the admin business-unit API");
  }
  if (next.dwdAllowlistEmails && !Array.isArray(next.dwdAllowlistEmails)) {
    throw badRequest("invalid_dwd_allowlist", "dwdAllowlistEmails must be an array");
  }
  const allowed = new Set([...required, "holidayCalendarRef"]);
  const unknown = Object.keys(next).filter((key) => !allowed.has(key));
  if (unknown.length) throw badRequest("unknown_settings", `Unsupported settings: ${unknown.join(", ")}`);
  if (typeof next.organizationDomain !== "string" ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(next.organizationDomain)) {
    throw badRequest("invalid_organization_domain", "organizationDomain must be a DNS domain");
  }
  if (typeof next.pollEnabled !== "boolean") throw badRequest("invalid_poll_enabled", "pollEnabled must be boolean");
  if (!next.businessHours || typeof next.businessHours !== "object" || Array.isArray(next.businessHours)) {
    throw badRequest("invalid_business_hours", "businessHours must be an object");
  }
  if (!next.schedulingPolicy || typeof next.schedulingPolicy !== "object" || Array.isArray(next.schedulingPolicy)) {
    throw badRequest("invalid_scheduling_policy", "schedulingPolicy must be an object");
  }
  if (!Array.isArray(next.faqCategories) || next.faqCategories.some((value) => typeof value !== "string" || !value.trim())) {
    throw badRequest("invalid_faq_categories", "faqCategories must contain non-empty strings");
  }
  const emails = next.dwdAllowlistEmails || [];
  if (emails.some((value) => typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw badRequest("invalid_dwd_allowlist", "dwdAllowlistEmails must contain valid email addresses");
  }
  if (new Set(emails.map((value) => value.toLowerCase())).size !== emails.length) {
    throw badRequest("duplicate_dwd_email", "dwdAllowlistEmails must not contain duplicates");
  }
}

export class SettingsService {
  constructor(db) {
    this.db = db;
  }

  async get() {
    const { rows } = await this.db.query(
      `SELECT revision, value FROM settings_revisions ORDER BY revision DESC LIMIT 1`,
    );
    const record = rows[0] || { revision: 0, value: {} };
    const units = await this.db.query(
      `SELECT b.id AS "businessUnitRef", b.name, b.calendar_account AS "calendarAccount",
              b.disabled_at IS NOT NULL AS disabled,
              COALESCE(jsonb_agg(jsonb_build_object(
                'attendeeRef', m.attendee_ref,
                'titlePattern', m.title_pattern,
                'role', m.role
              )) FILTER (WHERE m.attendee_ref IS NOT NULL), '[]'::jsonb) AS members
         FROM business_units b
         LEFT JOIN business_unit_memberships m ON m.business_unit_ref=b.id
          AND m.active_from <= now() AND (m.active_until IS NULL OR m.active_until > now())
        GROUP BY b.id ORDER BY b.name`,
    );
    const value = { ...record.value, businessUnits: units.rows };
    return { revision: record.revision, value, etag: settingsEtag(record.revision, record.value) };
  }

  async update(value, expectedEtag, actorEmail) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('openclaw.settings_revisions'))`);
      const { rows } = await client.query(
        `SELECT revision, value FROM settings_revisions ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      );
      const current = rows[0] || { revision: 0, value: {} };
      if (!expectedEtag || expectedEtag !== settingsEtag(current.revision, current.value)) {
        throw conflict("settings_version_conflict", "Settings changed; refetch and retry with If-Match");
      }
      validateSettings(value, current.value);
      const revision = Number(current.revision) + 1;
      await client.query(
        `INSERT INTO settings_revisions(revision, value, created_by) VALUES ($1,$2,$3)`,
        [revision, value, actorEmail],
      );
      await client.query("COMMIT");
      return { revision, etag: settingsEtag(revision, value) };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw conflict("settings_version_conflict", "Settings changed; refetch and retry with If-Match");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
