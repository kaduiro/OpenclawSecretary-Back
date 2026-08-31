import express from "express";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { GeminiMailAnalyzer } from "./ai/gemini-analyzer.js";
import { pool } from "./db.js";
import { createGoogleAuth } from "./auth/google-auth.js";
import { ResourceAuthorizer } from "./auth/resource-authorizer.js";
import { EnvelopeCrypto } from "./crypto/envelope.js";
import { KmsKeyEncryptionKey } from "./crypto/kms-key-encryption-key.js";
import { AppError } from "./lib/errors.js";
import { validateRequest, schemas } from "./middleware/validate-request.js";
import { GoogleOAuthProvider } from "./providers/google-oauth-provider.js";
import { GoogleWorkspaceProvider } from "./providers/google-workspace-provider.js";
import { AdminUserService } from "./services/admin-user-service.js";
import { CloudTasksEnqueuer } from "./services/cloud-tasks-enqueuer.js";
import { ClaimService } from "./services/claim-service.js";
import { CalendarService } from "./services/calendar-service.js";
import { ErrorService } from "./services/error-service.js";
import { EventService } from "./services/event-service.js";
import { FaqService } from "./services/faq-service.js";
import { GmailPollService } from "./services/gmail-poll-service.js";
import { MailWorkflowService } from "./services/mail-workflow-service.js";
import { MailSendOperationService } from "./services/mail-send-operation-service.js";
import { OAuthSessionService } from "./services/oauth-session-service.js";
import { OutboxService } from "./services/outbox-service.js";
import { RetentionService } from "./services/retention-service.js";
import { SettingsService } from "./services/settings-service.js";

export function createApp({
  db = pool,
  appConfig = config,
  auth: suppliedAuth,
  enqueuer,
  gmailProvider,
  calendarProvider,
  oauthProvider: suppliedOAuthProvider,
  mailAnalyzer: suppliedMailAnalyzer,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    req.correlationId = /^[A-Za-z0-9._-]{8,128}$/.test(req.get("x-correlation-id") || "")
      ? req.get("x-correlation-id")
      : randomUUID();
    res.set("X-Correlation-Id", req.correlationId);
    next();
  });
  app.use(express.json({ limit: "64kb", strict: true }));
  const auth = suppliedAuth || createGoogleAuth({ config: appConfig, db });
  const adminUsers = new AdminUserService(db);
  const settings = new SettingsService(db);
  const outbox = new OutboxService(db, enqueuer || new CloudTasksEnqueuer(appConfig));
  const authorizer = new ResourceAuthorizer(db);
  const envelopeCrypto = appConfig.kmsKeyName
    ? new EnvelopeCrypto(new KmsKeyEncryptionKey(appConfig.kmsKeyName))
    : undefined;
  const oauthProvider = suppliedOAuthProvider || new GoogleOAuthProvider(appConfig);
  const mailAnalyzer = suppliedMailAnalyzer || (appConfig.ai?.enabled
    ? new GeminiMailAnalyzer({ db, config: appConfig })
    : undefined);
  const workspaceProvider = new GoogleWorkspaceProvider(db, oauthProvider, envelopeCrypto, globalThis.fetch, mailAnalyzer);
  const effectiveGmailProvider = gmailProvider || workspaceProvider;
  const effectiveCalendarProvider = calendarProvider || workspaceProvider;
  const mailOperations = new MailSendOperationService(db, effectiveGmailProvider);
  const claims = new ClaimService(db, envelopeCrypto);
  const faqs = new FaqService(db, authorizer, envelopeCrypto);
  const events = new EventService(db);
  const mailWorkflow = new MailWorkflowService(db, authorizer, envelopeCrypto, effectiveGmailProvider);
  const oauth = new OAuthSessionService(db, envelopeCrypto, oauthProvider);
  const calendar = new CalendarService(db, authorizer, envelopeCrypto, effectiveCalendarProvider);
  const gmailPoll = new GmailPollService(db, effectiveGmailProvider);
  const errors = new ErrorService(db);
  const retention = new RetentionService(db);

  app.get("/livez", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", auth.service("runtime"), async (_req, res, next) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ready" });
    } catch (error) {
      next(new AppError(503, "database_unavailable", "Database is unavailable"));
    }
  });

  app.get("/v1/health", auth.user(), async (req, res, next) => {
    const startedAt = Date.now();
    try {
      await db.query("SELECT 1");
      const credentials = await db.query(
        `SELECT credential_status FROM provider_credentials WHERE attendee_ref=$1`,
        [req.actor.attendeeRef],
      );
      const credentialStatus = credentials.rows[0]?.credential_status;
      res.set("Cache-Control", "no-store").json({
        status: "ok",
        timestamp: new Date().toISOString(),
        revision: process.env.K_REVISION || "local",
        db: { status: "ok", latencyMs: Date.now() - startedAt },
        heartbeat: { status: "ok", checkedAt: new Date().toISOString() },
        bootstrap: {
          required: credentialStatus !== "active",
          reason: credentialStatus === "invalid" ? "invalid" : credentialStatus === "active" ? null : "missing",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/events", auth.user(), validateRequest({ query: schemas.limitQuery }), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await events.list(req.actor.attendeeRef, req.query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/events/:eventId/ack", auth.user(), async (req, res, next) => {
    try {
      res.json(await events.acknowledge(req.params.eventId, req.actor.attendeeRef));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/auth/id-token/refresh", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await oauth.refresh(req.actor.attendeeRef));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/auth/bind-subject", auth.workspaceIdentity(), async (req, res, next) => {
    try {
      const bound = await adminUsers.bindFirstLogin(req.identity);
      res.status(201).set("Cache-Control", "no-store").json({
        success: true,
        userId: bound.id,
        attendeeRef: bound.attendee_ref,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/auth/gmail-self-registration", auth.user(), async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT attendee_ref,workspace_access_type FROM users WHERE id=$1 AND provisioning_status='active'`,
        [req.actor.userId],
      );
      if (!rows[0] || rows[0].workspace_access_type !== "personal_oauth") {
        throw new AppError(409, "not_personal_oauth", "The authenticated user is not a personal Gmail registration");
      }
      res.status(201).json({ success: true, attendeeRef: rows[0].attendee_ref, workspaceAccessType: "personal_oauth" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/auth/oauth-sessions", auth.service("gateway"), validateRequest({ body: schemas.oauthSession }), async (req, res, next) => {
    try {
      const session = await oauth.create(req.body);
      res.set("Cache-Control", "no-store").json({
        authorizationUrl: session.authorizationUrl,
        state: session.state,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/auth/oauth-exchange", auth.service("gateway"), validateRequest({ body: schemas.oauthExchange }), async (req, res, next) => {
    try {
      const result = await oauth.exchange(req.body);
      res.set("Cache-Control", "no-store").json({ handoffCode: result.handoffCode, expiresAt: result.expiresAt, returnUri: result.returnUri });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/auth/handoff/redeem", auth.service("bootstrap"), validateRequest({ body: schemas.handoffRedeem }), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await oauth.redeem(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/mail/pending", auth.user(), async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT e.id AS "mailId", e.status, e.claimer_attendee_ref AS "claimerAttendeeRef",
                e.claimed_at AS "claimedAt", e.subject, e.urgency, e.category,
                e.received_at AS "receivedAt", e.card_version AS "cardVersion"
           FROM emails e
          WHERE e.hud_display_ready=true AND (
            e.owner_attendee_ref=$1 OR EXISTS (
              SELECT 1 FROM business_unit_memberships m
              JOIN business_units b ON b.id=m.business_unit_ref
               WHERE m.business_unit_ref=e.business_unit_ref AND m.attendee_ref=$1
                 AND b.disabled_at IS NULL
                 AND m.active_from <= now() AND (m.active_until IS NULL OR m.active_until > now())
            )
          ) ORDER BY e.received_at DESC LIMIT 100`,
        [req.actor.attendeeRef],
      );
      res.set("Cache-Control", "no-store").json({ tickets: rows, nextCursor: null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/mail/:mailId/approve", auth.user(), validateRequest({ body: schemas.approval }), async (req, res, next) => {
    try {
      const result = await mailWorkflow.approve(req.params.mailId, req.body, req.actor);
      if (result.status === "result_unknown") res.set("Retry-After", "30");
      res.status(result.status === "result_unknown" ? 202 : 200).set("Cache-Control", "no-store").json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/mail/:mailId/reject", auth.user(), validateRequest({ body: schemas.approval }), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await mailWorkflow.reject(req.params.mailId, req.body, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/mail/:mailId/reissue-token", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await mailWorkflow.reissueToken(req.params.mailId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/mail/tickets", auth.user(), async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 100);
      res.set("Cache-Control", "no-store").json(await mailWorkflow.listTickets(req.actor, limit));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/mail-send-operations/:operationId", auth.user(), async (req, res, next) => {
    try {
      const operation = await mailOperations.getForActor(req.params.operationId, req.actor.attendeeRef);
      res.set("Cache-Control", "no-store").json(operation);
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/mail/:mailId/claim", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await claims.claim(req.params.mailId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/v1/mail/:mailId/claim", auth.user(), async (req, res, next) => {
    try {
      res.json(await claims.release(req.params.mailId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/mail/:mailId/transfer-targets", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await claims.transferTargets(req.params.mailId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/mail/:mailId/transfer", auth.user(), validateRequest({ body: schemas.transfer }), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(
        await claims.transfer(req.params.mailId, req.body?.targetAttendeeRef, req.actor),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/mail/:mailId/detail", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await mailWorkflow.detail(req.params.mailId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/calendar/proposals/:proposalId", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await calendar.get(req.params.proposalId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/calendar/proposals/:proposalId/reissue-token", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await calendar.reissueToken(req.params.proposalId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/calendar/proposals/:proposalId/approve", auth.user(), validateRequest({ body: schemas.calendarApproval }), async (req, res, next) => {
    try {
      res.status(202).set("Cache-Control", "no-store").json(await calendar.approve(req.params.proposalId, req.body, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/calendar/proposals/:proposalId/reject-all", auth.user(), validateRequest({ body: schemas.calendarRejection }), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await calendar.reject(req.params.proposalId, req.body, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/calendar/proposals/:proposalId/cancel", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await calendar.cancel(req.params.proposalId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/calendar/proposals/:proposalId/alternatives", auth.user(), validateRequest({ body: schemas.calendarAlternative }), async (req, res, next) => {
    try {
      res.status(201).set("Cache-Control", "no-store").json(await calendar.alternative(req.params.proposalId, req.body, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/operations/:operationId", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await calendar.operation(req.params.operationId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/faq-candidates/:faqCandidateId", auth.user(), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await faqs.getCandidate(req.params.faqCandidateId, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/faqs", auth.user(), validateRequest({ body: schemas.faq }), async (req, res, next) => {
    try {
      res.status(201).json(await faqs.accept(req.body, req.actor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/errors/:correlationId/ack", auth.user(), async (req, res, next) => {
    try {
      res.json(await errors.acknowledge(req.params.correlationId, req.actor.attendeeRef));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/settings", auth.service("admin"), async (_req, res, next) => {
    try {
      const current = await settings.get();
      res.set("ETag", current.etag).set("Cache-Control", "no-store").json({ revision: current.revision, settings: current.value });
    } catch (error) {
      next(error);
    }
  });

  app.put("/v1/settings", auth.service("admin"), async (req, res, next) => {
    try {
      const result = await settings.update(req.body, req.get("if-match"), req.actor.email);
      res.set("ETag", result.etag).json({ success: true, revision: result.revision });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/admin/users", auth.service("admin"), validateRequest({ body: schemas.adminUser }), async (req, res, next) => {
    try {
      const result = await adminUsers.preRegister(req.body, req.actor.email);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/admin/business-units", auth.service("admin"), validateRequest({ body: schemas.businessUnit }), async (req, res, next) => {
    try {
      res.status(201).json(await adminUsers.createBusinessUnit(req.body, req.actor.email));
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/admin/business-units/:businessUnitRef/disable", auth.service("admin"), async (req, res, next) => {
    try {
      res.json(await adminUsers.disableBusinessUnit(req.params.businessUnitRef));
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/outbox/dispatch", auth.service("scheduler"), validateRequest({ body: schemas.limitBody }), async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.body?.limit || 50), 100);
      const results = await outbox.dispatch(limit);
      res.status(202).json({ accepted: true, status: "accepted", processed: results.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/outbox/:eventId/replay", auth.service("admin"), async (req, res, next) => {
    try {
      res.json(await outbox.replay(req.params.eventId, req.actor.email));
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/mail-send/reconcile", auth.service("scheduler"), validateRequest({ body: schemas.limitBody }), async (req, res, next) => {
    try {
      const operations = await mailOperations.reconcileDue(Math.min(Number(req.body?.limit || 50), 100));
      res.status(202).json({ accepted: true, status: "accepted", processed: operations.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/auth/compensate", auth.service("scheduler"), async (_req, res, next) => {
    try {
      const counts = await oauth.compensate();
      res.status(202).json({ accepted: true, status: "accepted", processed: counts.expired + counts.disabled + counts.removed, counts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/poll-gmail", auth.service("scheduler"), validateRequest({ body: schemas.limitBody }), async (req, res, next) => {
    try {
      const results = await gmailPoll.run(Math.min(Number(req.body?.limit || 20), 100));
      res.status(202).json({ accepted: true, status: "accepted", processed: results.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/gmail/notifications", auth.service("pubsub"), async (req, res, next) => {
    try {
      const notification = decodeGmailNotification(req.body);
      const result = notification
        ? await gmailPoll.runNotification(notification)
        : { status: "ignored", processed: 0 };
      res.status(202).json({ accepted: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/gmail/watch/renew", auth.service("scheduler"), validateRequest({ body: schemas.limitBody }), async (req, res, next) => {
    try {
      const results = await gmailPoll.renewWatches(
        appConfig.gmailPubsubTopic,
        Math.min(Number(req.body?.limit || 100), 100),
      );
      res.status(202).json({ accepted: true, status: "accepted", processed: results.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/calendar/operations/:operationId/execute", auth.service("tasks"), async (req, res, next) => {
    try {
      res.status(202).json(await calendar.execute(req.params.operationId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/retention/pii-mask", auth.service("scheduler"), async (_req, res, next) => {
    try {
      const counts = await retention.run();
      res.status(202).json({ accepted: true, status: "accepted", counts });
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, _res, next) => next(new AppError(404, "not_found", "Route not found")));
  app.use((error, req, res, _next) => {
    const normalized = error instanceof AppError
      ? error
      : error?.type === "entity.parse.failed"
        ? new AppError(400, "invalid_json", "Request body must be valid JSON")
        : new AppError(500, "internal_error", "Internal server error");
    if (normalized.status >= 500) console.error(JSON.stringify({ code: normalized.code, path: req.path, error: error.name }));
    res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
      correlationId: req.correlationId,
      ...(normalized.details ? { details: normalized.details } : {}),
    });
  });
  return app;
}

export function decodeGmailNotification(body) {
  if (!body?.message?.data || typeof body.message.data !== "string") return null;
  try {
    const decoded = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"));
    if (typeof decoded.emailAddress !== "string" || !/^\d+$/.test(String(decoded.historyId || ""))) return null;
    return { emailAddress: decoded.emailAddress, historyId: String(decoded.historyId) };
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  createApp().listen(config.port, () => console.log(`openclaw-api listening on ${config.port}`));
}
