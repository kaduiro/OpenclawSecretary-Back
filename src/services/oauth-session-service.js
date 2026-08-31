import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sha256, sha256Hex } from "../lib/hash.js";
import { badRequest, conflict, notFound, serviceUnavailable } from "../lib/errors.js";

const SESSION_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 60 * 1000;

function randomValue() {
  return randomBytes(32).toString("base64url");
}

function s256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function validateLoopbackReturnUri(value) {
  let uri;
  try {
    uri = new URL(value);
  } catch {
    throw badRequest("invalid_return_uri", "returnUri must be a loopback callback URI");
  }
  const port = Number(uri.port);
  const hostAllowed = uri.hostname === "127.0.0.1" || uri.hostname === "[::1]";
  const callbackPath = /^\/callback(?:\/[A-Za-z0-9_-]{43})?$/.test(uri.pathname);
  if (uri.protocol !== "http:" || !hostAllowed || port < 1024 || port > 65535 ||
      !callbackPath || uri.username || uri.password || uri.search || uri.hash) {
    throw badRequest("invalid_return_uri", "returnUri must use a numeric loopback host, an allowed port, and a bound callback path");
  }
  return uri.href;
}

export class OAuthSessionService {
  constructor(db, crypto, provider) {
    this.db = db;
    this.crypto = crypto;
    this.provider = provider;
  }

  async create({ returnUri, handoffChallenge }) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "OAuth session encryption is unavailable");
    if (!this.provider) throw serviceUnavailable("oauth_not_configured", "Google OAuth is not configured");
    const id = randomUUID();
    const sessionSecret = randomValue();
    const state = randomValue();
    const nonce = randomValue();
    const verifier = randomValue();
    const pkceChallenge = s256(verifier);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const normalizedReturnUri = validateLoopbackReturnUri(returnUri);
    const verifierEnvelope = await this.crypto.encrypt(JSON.stringify({ verifier, nonce }), `oauth-pkce:${id}`);
    await this.db.query(
      `INSERT INTO oauth_sessions
        (id,session_secret_hash,state_hash,nonce_hash,pkce_challenge,pkce_verifier_envelope,
         return_uri,handoff_challenge,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, sha256(sessionSecret), sha256(state), sha256(nonce), pkceChallenge, verifierEnvelope,
        normalizedReturnUri, handoffChallenge, expiresAt],
    );
    const authorizationUrl = await this.provider.authorizationUrl({ state, nonce, pkceChallenge });
    return { sessionId: id, authorizationUrl, state, expiresAt };
  }

  async exchange({ code, state }) {
    if (!this.crypto || !this.provider) throw serviceUnavailable("oauth_not_configured", "Google OAuth is not configured");
    const { rows } = await this.db.query(
      `UPDATE oauth_sessions SET exchange_started_at=COALESCE(exchange_started_at,now())
        WHERE state_hash=$1 AND consumed_at IS NULL AND expired_at IS NULL AND expires_at>now()
          AND exchange_started_at IS NULL AND exchange_completed_at IS NULL
      RETURNING *`,
      [sha256(state)],
    );
    const session = rows[0];
    if (!session) throw conflict("oauth_session_invalid", "OAuth session is expired, consumed, or already exchanged");
    try {
      const secrets = JSON.parse(await this.crypto.decrypt(session.pkce_verifier_envelope, `oauth-pkce:${session.id}`));
      const exchanged = await this.provider.exchangeCode({ code, codeVerifier: secrets.verifier, nonce: secrets.nonce });
      const identity = await this.#provisionIdentity(exchanged.claims, exchanged.refreshToken);
      const expiresAt = new Date(Number(exchanged.claims.exp) * 1000);
      const handoff = await this.#issueHandoff(session, {
        idToken: exchanged.idToken,
        expiresAt,
        claims: {
          sub: exchanged.claims.sub,
          email: exchanged.claims.email,
          hd: exchanged.claims.hd,
          aud: exchanged.claims.aud,
          exp: exchanged.claims.exp,
        },
        bootstrap: { completed: true, bindingHash: sha256Hex(`${exchanged.claims.sub}:${identity.attendeeRef}`), reason: "completed" },
      });
      await this.db.query(
        `UPDATE oauth_sessions SET exchange_completed_at=now(),last_error_code=NULL WHERE id=$1`,
        [session.id],
      );
      return { ...handoff, returnUri: session.return_uri };
    } catch (error) {
      await this.db.query(
        `UPDATE oauth_sessions SET last_error_code=$2 WHERE id=$1`,
        [session.id, error.code || "oauth_exchange_failed"],
      );
      throw error;
    }
  }

  async #provisionIdentity(claims, refreshToken) {
    const subjectHash = sha256Hex(claims.sub);
    const emailHash = sha256Hex(claims.email.trim().toLowerCase());
    const client = await this.db.connect();
    let user;
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT id,attendee_ref,provisioning_status FROM users
          WHERE google_subject_hash=$1 OR email_hash=$2 FOR UPDATE`,
        [subjectHash, emailHash],
      );
      if (existing.rowCount > 1) throw conflict("identity_conflict", "Subject and email resolve to different users");
      if (existing.rows[0]?.provisioning_status === "disabled") throw conflict("user_disabled", "User is disabled");
      if (existing.rows[0]) {
        const { rows } = await client.query(
          `UPDATE users SET google_subject_hash=$2,email_hash=$3,pending_email_hash=NULL,
               provisioning_status='oauth_provisioning',provisioning_started_at=now(),subject_bound_at=COALESCE(subject_bound_at,now())
            WHERE id=$1 RETURNING id,attendee_ref`,
          [existing.rows[0].id, subjectHash, emailHash],
        );
        user = rows[0];
      } else {
        const { rows } = await client.query(
          `INSERT INTO users(id,attendee_ref,google_subject_hash,email_hash,workspace_access_type,provisioning_status,provisioning_started_at,subject_bound_at)
           VALUES ($1,$2,$3,$4,'personal_oauth','oauth_provisioning',now(),now()) RETURNING id,attendee_ref`,
          [randomUUID(), randomUUID(), subjectHash, emailHash],
        );
        user = rows[0];
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    try {
      const secretResource = await this.provider.storeRefreshToken(user.attendee_ref, refreshToken);
      await this.db.query(
        `INSERT INTO provider_credentials(attendee_ref,secret_resource_name) VALUES ($1,$2)
         ON CONFLICT (attendee_ref) DO UPDATE SET secret_resource_name=EXCLUDED.secret_resource_name,
           credential_status='active',updated_at=now()`,
        [user.attendee_ref, secretResource],
      );
      await this.db.query(
        `INSERT INTO mailbox_poll_state(mailbox_ref) VALUES ($1)
         ON CONFLICT (mailbox_ref) DO NOTHING`,
        [user.attendee_ref],
      );
      await this.db.query(`UPDATE users SET provisioning_status='active' WHERE id=$1`, [user.id]);
      return { attendeeRef: user.attendee_ref };
    } catch (error) {
      await this.db.query(`UPDATE users SET provisioning_status='disabled' WHERE id=$1`, [user.id]);
      throw error;
    }
  }

  async #issueHandoff(session, payload) {
    const handoffCode = randomValue();
    const envelope = await this.crypto.encrypt(JSON.stringify(payload), `oauth-handoff:${session.id}`);
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    const { rowCount } = await this.db.query(
      `UPDATE oauth_sessions SET handoff_code_hash=$1,handoff_expires_at=$2,handoff_envelope=$3
        WHERE id=$4 AND consumed_at IS NULL AND expires_at>now() AND handoff_code_hash IS NULL`,
      [sha256(handoffCode), expiresAt, envelope, session.id],
    );
    if (rowCount !== 1) throw conflict("oauth_session_invalid", "OAuth session is expired or already exchanged");
    return { handoffCode, expiresAt };
  }

  async redeem({ handoffCode, handoffVerifier }) {
    if (!this.crypto) throw serviceUnavailable("kms_unavailable", "OAuth handoff is unavailable");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE oauth_sessions SET consumed_at=now(),redeem_attempts=redeem_attempts+1
          WHERE handoff_code_hash=$1 AND handoff_challenge=$2
            AND consumed_at IS NULL AND handoff_expires_at>now()
        RETURNING id,handoff_envelope`,
        [sha256(handoffCode), s256(handoffVerifier)],
      );
      if (!rows[0]) throw notFound();
      const plaintext = await this.crypto.decrypt(rows[0].handoff_envelope, `oauth-handoff:${rows[0].id}`);
      await client.query("COMMIT");
      return JSON.parse(plaintext);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refresh(attendeeRef) {
    if (!this.provider) throw serviceUnavailable("oauth_not_configured", "Google OAuth is not configured");
    const { rows } = await this.db.query(
      `SELECT secret_resource_name FROM provider_credentials
        WHERE attendee_ref=$1 AND credential_status='active'`,
      [attendeeRef],
    );
    if (!rows[0]) throw serviceUnavailable("refresh_token_missing", "A new OAuth login is required");
    const refreshed = await this.provider.refreshIdToken(rows[0].secret_resource_name);
    return {
      idToken: refreshed.idToken,
      expiresAt: new Date(Number(refreshed.claims.exp) * 1000),
      claims: {
        sub: refreshed.claims.sub,
        email: refreshed.claims.email,
        hd: refreshed.claims.hd,
        aud: refreshed.claims.aud,
        exp: refreshed.claims.exp,
      },
    };
  }

  async compensate(limit = 100) {
    const expired = await this.db.query(
      `UPDATE oauth_sessions SET expired_at=COALESCE(expired_at,now())
        WHERE consumed_at IS NULL AND expired_at IS NULL AND expires_at<now()
      RETURNING id`,
    );
    const disabled = await this.db.query(
      `UPDATE users SET provisioning_status='disabled'
        WHERE provisioning_status='oauth_provisioning' AND provisioning_started_at<now()-interval '15 minutes'
      RETURNING id`,
    );
    const removed = await this.db.query(
      `DELETE FROM oauth_sessions WHERE id IN (
        SELECT id FROM oauth_sessions
         WHERE (consumed_at<now()-interval '1 day' OR expired_at<now()-interval '1 day')
         ORDER BY created_at LIMIT $1
      ) RETURNING id`,
      [limit],
    );
    return { expired: expired.rowCount, disabled: disabled.rowCount, removed: removed.rowCount };
  }
}
