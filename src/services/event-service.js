import { badRequest, forbidden } from "../lib/errors.js";

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== "string")) throw new Error();
    return parsed;
  } catch {
    throw badRequest("invalid_cursor", "Event cursor is invalid");
  }
}

export class EventService {
  constructor(db) {
    this.db = db;
  }

  async list(attendeeRef, { cursor, limit = 50 } = {}) {
    const decoded = decodeCursor(cursor);
    const { rows } = await this.db.query(
      `SELECT e.id,e.event_type,e.mail_id,e.payload,e.created_at
         FROM event_inbox e
         JOIN event_inbox_recipients r ON r.event_id=e.id
        WHERE r.target_attendee_ref=$1 AND r.acked_at IS NULL
          AND ($2::timestamptz IS NULL OR (e.created_at,e.id)>($2::timestamptz,$3::uuid))
        ORDER BY e.created_at,e.id LIMIT $4`,
      [attendeeRef, decoded?.[0] || null, decoded?.[1] || null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      events: page.map((row) => ({
        eventId: row.id,
        type: row.event_type,
        createdAt: row.created_at,
        mailId: row.mail_id,
        operationId: row.payload?.operationId || null,
        payload: row.payload,
      })),
      nextCursor: hasMore ? encodeCursor(page.at(-1)) : null,
    };
  }

  async acknowledge(eventId, attendeeRef) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE event_inbox_recipients
            SET acked_at=COALESCE(acked_at,now())
          WHERE event_id=$1 AND target_attendee_ref=$2
        RETURNING acked_at`,
        [eventId, attendeeRef],
      );
      if (!rows[0]) throw forbidden("The event is not addressed to this user");
      const remaining = await client.query(
        `SELECT 1 FROM event_inbox_recipients WHERE event_id=$1 AND acked_at IS NULL LIMIT 1`,
        [eventId],
      );
      await client.query("COMMIT");
      return {
        success: true,
        eventId,
        acknowledgedAt: rows[0].acked_at,
        fullyAcknowledged: remaining.rowCount === 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
