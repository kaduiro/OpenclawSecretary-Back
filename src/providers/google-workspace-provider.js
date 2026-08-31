import { randomUUID } from "node:crypto";
import { serviceUnavailable } from "../lib/errors.js";

function decodeBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts || []) {
    const value = decodeBody(part);
    if (value) return value;
  }
  return "";
}

function header(message, name) {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function senderName(from) {
  return from.replace(/<[^>]+>/g, "").replace(/^"|"$/g, "").trim() || "Unknown sender";
}

export class GoogleWorkspaceProvider {
  constructor(db, oauthProvider, crypto, fetchImpl = globalThis.fetch, mailAnalyzer) {
    this.db = db;
    this.oauthProvider = oauthProvider;
    this.crypto = crypto;
    this.fetch = fetchImpl;
    this.mailAnalyzer = mailAnalyzer;
  }

  async #credential(attendeeRef) {
    const { rows } = await this.db.query(
      `SELECT secret_resource_name FROM provider_credentials
        WHERE attendee_ref=$1 AND credential_status='active'`,
      [attendeeRef],
    );
    if (!rows[0]) throw serviceUnavailable("provider_credential_missing", "Google authorization is required");
    return this.oauthProvider.accessToken(rows[0].secret_resource_name);
  }

  async #mailActor(mailId) {
    const { rows } = await this.db.query(
      `SELECT COALESCE(owner_attendee_ref,claimer_attendee_ref) AS attendee_ref
         FROM emails WHERE id=$1`,
      [mailId],
    );
    if (!rows[0]?.attendee_ref) throw serviceUnavailable("mailbox_actor_missing", "The mail has no authorized provider identity");
    return rows[0].attendee_ref;
  }

  async #request(url, token, { method = "GET", body } = {}) {
    const response = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error("Google Workspace API request failed");
      error.code = response.status === 404 ? "provider_not_found" : response.status === 401 ? "provider_unauthorized" : "provider_request_failed";
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async sendReply({ mailId, draftId }) {
    if (!draftId) {
      const error = new Error("A persisted Gmail draft is required");
      error.code = "draft_missing";
      throw error;
    }
    const token = await this.#credential(await this.#mailActor(mailId));
    const result = await this.#request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", token, {
      method: "POST",
      body: { id: draftId },
    });
    return { messageId: result.id, threadId: result.threadId };
  }

  async prepareReply({ mailId, draftId, operationMarker }) {
    if (!draftId) {
      const error = new Error("A persisted Gmail draft is required");
      error.code = "draft_missing";
      throw error;
    }
    const token = await this.#credential(await this.#mailActor(mailId));
    const draftUrl = `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`;
    const draft = await this.#request(`${draftUrl}?format=raw`, token);
    const raw = Buffer.from(draft.message.raw, "base64url").toString("utf8");
    const separator = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    const markerHeader = `X-OpenClaw-Operation: ${operationMarker}`;
    const marked = raw.toLowerCase().includes("x-openclaw-operation:")
      ? raw
      : raw.replace(separator, `${separator === "\r\n\r\n" ? "\r\n" : "\n"}${markerHeader}${separator}`);
    const updated = await this.#request(draftUrl, token, {
      method: "PUT",
      body: { id: draftId, message: { raw: Buffer.from(marked, "utf8").toString("base64url") } },
    });
    return { threadId: updated.message?.threadId || draft.message?.threadId || null };
  }

  async deleteDraft({ draftId, mailId }) {
    if (!draftId) return;
    const token = await this.#credential(await this.#mailActor(mailId));
    await this.#request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, token, { method: "DELETE" });
  }

  async findSentReply({ mailId, messageId, threadId, operationMarker }) {
    if (messageId) return { messageId };
    const token = await this.#credential(await this.#mailActor(mailId));
    const query = encodeURIComponent(`in:sent "${operationMarker}"`);
    const result = await this.#request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=1`, token);
    if (result.messages?.[0]) return { messageId: result.messages[0].id };
    if (threadId) {
      const thread = await this.#request(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=X-OpenClaw-Operation`,
        token,
      );
      const sent = (thread.messages || []).find((message) =>
        message.labelIds?.includes("SENT") && header(message, "X-OpenClaw-Operation") === operationMarker);
      if (sent) return { messageId: sent.id };
    }
    return null;
  }

  async pollMailbox({ mailboxRef, historyId }) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "Gmail ingestion encryption is unavailable");
    const token = await this.#credential(mailboxRef);
    let messageIds = [];
    let nextHistoryId = historyId;
    if (historyId) {
      const result = await this.#request(
        `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=50`,
        token,
      );
      messageIds = [...new Set((result.history || []).flatMap((item) => item.messagesAdded || []).map((item) => item.message.id))];
      nextHistoryId = result.historyId || historyId;
    } else {
      const result = await this.#request("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=newer_than:1d", token);
      messageIds = (result.messages || []).map((item) => item.id);
    }
    let processed = 0;
    for (const gmailId of messageIds) {
      const message = await this.#request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=full`, token);
      nextHistoryId = message.historyId || nextHistoryId;
      if (await this.#ingest(mailboxRef, message)) processed += 1;
    }
    return { historyId: nextHistoryId, processed };
  }

  async watchMailbox({ mailboxRef, topicName }) {
    const token = await this.#credential(mailboxRef);
    return this.#request("https://gmail.googleapis.com/gmail/v1/users/me/watch", token, {
      method: "POST",
      body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
    });
  }

  async #ingest(attendeeRef, message) {
    const id = randomUUID();
    const from = header(message, "From");
    const subject = header(message, "Subject") || "(no subject)";
    const date = new Date(header(message, "Date"));
    const receivedAt = Number.isNaN(date.getTime()) ? new Date() : date;
    const bodyPreview = decodeBody(message.payload).slice(0, 500);
    const existing = await this.db.query(`SELECT 1 FROM emails WHERE mailbox_ref=$1 AND gmail_id=$2`, [attendeeRef, message.id]);
    if (existing.rowCount > 0) return false;
    let analysis = null;
    if (this.mailAnalyzer) {
      try {
        analysis = await this.mailAnalyzer.analyze({ subject, body: bodyPreview });
      } catch (error) {
        console.error(JSON.stringify({ event: "mail_ai_analysis_failed", code: error.code || "ai_analysis_failed" }));
      }
    }
    const senderEnvelope = await this.crypto.encrypt(from, `mail:${id}:sender-address`);
    const bodyEnvelope = await this.crypto.encrypt(bodyPreview, `mail:${id}:body-preview`);
    const replyDraftEnvelope = analysis?.replyDraft
      ? await this.crypto.encrypt(analysis.replyDraft, `mail:${id}:reply-draft`)
      : null;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO emails(id,mailbox_ref,gmail_id,owner_attendee_ref,status,analysis_status,card_type,
           subject,sender_display_name,sender_address_envelope,body_preview_envelope,summary,intent,actions,
           failure_reason_code,received_at,hud_display_ready)
         VALUES ($1,$2,$3,$2::uuid,'未対応','failed','manual_action_required',$4,$5,$6,$7,'','','[]','model_unavailable',$8,true)
         ON CONFLICT (mailbox_ref,gmail_id) DO NOTHING RETURNING id,card_version`,
        [id, attendeeRef, message.id, subject.slice(0, 1000), senderName(from).slice(0, 200), senderEnvelope, bodyEnvelope, receivedAt],
      );
      if (!inserted.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      if (analysis) {
        await client.query(
          `UPDATE emails SET analysis_status='succeeded',category=$2,urgency=$3,summary=$4,intent=$5,
               actions=$6,reply_draft_envelope=$7,failure_reason_code=NULL WHERE id=$1`,
          [id, analysis.category, analysis.urgency, analysis.summary, analysis.intent, JSON.stringify(analysis.actions), replyDraftEnvelope],
        );
      }
      await client.query(
        `INSERT INTO timeline_events(mail_id,event_type,detail)
         VALUES ($1,'received',jsonb_build_object('analysisStatus',$2::text))`,
        [id, analysis ? "succeeded" : "failed"],
      );
      if (analysis) {
        await client.query(`INSERT INTO timeline_events(mail_id,event_type) VALUES ($1,'analyzed')`, [id]);
      }
      const event = await client.query(
        `INSERT INTO event_inbox(mail_id,event_type,payload)
         VALUES ($1,'mail_manual_action_required',jsonb_build_object(
           'mailId',$1::text,'cardVersion',$2::int,'reasonCode',$3::text)) RETURNING id`,
        [id, inserted.rows[0].card_version, analysis ? "ai_review_required" : "analysis_failed"],
      );
      await client.query(
        `INSERT INTO event_inbox_recipients(event_id,target_attendee_ref) VALUES ($1,$2)`,
        [event.rows[0].id, attendeeRef],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertEvent({ operationId, attendeeRef, slot }) {
    const token = await this.#credential(attendeeRef);
    const marker = encodeURIComponent(`openclawOperationId=${operationId}`);
    const existing = await this.#request(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?privateExtendedProperty=${marker}&maxResults=1&singleEvents=true`,
      token,
    );
    if (existing.items?.[0]) return { eventId: existing.items[0].id };
    const created = await this.#request("https://www.googleapis.com/calendar/v3/calendars/primary/events", token, {
      method: "POST",
      body: {
        summary: "Scheduled meeting",
        start: { dateTime: slot.slotStart },
        end: { dateTime: slot.slotEnd },
        extendedProperties: { private: { openclawOperationId: operationId } },
      },
    });
    return { eventId: created.id };
  }
}
