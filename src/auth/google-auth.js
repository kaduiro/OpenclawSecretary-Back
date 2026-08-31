import { OAuth2Client } from "google-auth-library";
import { sha256Hex } from "../lib/hash.js";
import { forbidden, unauthorized } from "../lib/errors.js";

function bearerToken(req) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  return header.slice(7);
}

export function createGoogleAuth({ config, db, oauthClient = new OAuth2Client() }) {
  async function verify(token, audience) {
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
      return ticket.getPayload();
    } catch {
      throw unauthorized("Invalid Google identity token");
    }
  }

  function user() {
    return async (req, _res, next) => {
      try {
        const claims = await verify(bearerToken(req), config.googleClientId);
        if (!claims?.sub || claims.hd !== config.allowedDomain || claims.email_verified !== true) {
          throw forbidden("Workspace identity is not authorized");
        }
        const subjectHash = sha256Hex(claims.sub);
        const { rows } = await db.query(
          `SELECT id, attendee_ref, provisioning_status
             FROM users
            WHERE google_subject_hash = $1`,
          [subjectHash],
        );
        const record = rows[0];
        if (!record || record.provisioning_status !== "active") throw forbidden();
        req.actor = Object.freeze({
          kind: "user",
          userId: record.id,
          attendeeRef: record.attendee_ref,
          subjectHash,
        });
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  function workspaceIdentity() {
    return async (req, _res, next) => {
      try {
        const claims = await verify(bearerToken(req), config.googleClientId);
        if (!claims?.sub || !claims.email || claims.hd !== config.allowedDomain || claims.email_verified !== true) {
          throw forbidden("Workspace identity is not authorized");
        }
        req.identity = Object.freeze({ subject: claims.sub, email: claims.email.toLowerCase() });
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  function service(scheme) {
    return async (req, _res, next) => {
      try {
        const claims = await verify(bearerToken(req), config.cloudRunAudience);
        const expectedEmail = config.serviceAccounts[scheme];
        if (!expectedEmail || claims?.email !== expectedEmail || claims.email_verified !== true) {
          throw forbidden(`Token is not valid for ${scheme} endpoints`);
        }
        req.actor = Object.freeze({ kind: "service", scheme, email: claims.email });
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  return Object.freeze({ user, workspaceIdentity, service });
}
