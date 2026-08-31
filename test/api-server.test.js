import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/api-server.js";

const pass = () => (_req, _res, next) => next();

test("API server composes with injected infrastructure", () => {
  const app = createApp({
    appConfig: { serviceAccounts: {}, cloudTasks: {} },
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => { throw new Error("not used during composition"); },
    },
    auth: { user: pass, workspaceIdentity: pass, service: pass },
    enqueuer: { enqueue: async () => {} },
  });
  assert.equal(typeof app.listen, "function");
});

function authenticated() {
  return {
    user: () => (req, _res, next) => {
      req.actor = { kind: "user", userId: "user-1", attendeeRef: "00000000-0000-4000-8000-000000000001", subjectHash: "subject" };
      next();
    },
    workspaceIdentity: pass,
    service: () => (req, _res, next) => {
      req.actor = { kind: "service", email: "service@example.test" };
      next();
    },
  };
}

test("health endpoint performs an authenticated database heartbeat", async () => {
  const app = createApp({
    appConfig: { serviceAccounts: {}, cloudTasks: {} },
    db: {
      query: async (sql) => sql.includes("provider_credentials")
        ? { rows: [{ credential_status: "active" }], rowCount: 1 }
        : { rows: [{ one: 1 }], rowCount: 1 },
      connect: async () => { throw new Error("not used"); },
    },
    auth: authenticated(),
    enqueuer: { enqueue: async () => {} },
    oauthProvider: {},
  });
  const response = await request(app).get("/v1/health").expect(200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.bootstrap.required, false);
  assert.match(response.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
});

test("request validation rejects malformed transfer commands before database access", async () => {
  const app = createApp({
    appConfig: { serviceAccounts: {}, cloudTasks: {} },
    db: {
      query: async () => { throw new Error("database must not be called"); },
      connect: async () => { throw new Error("database must not be called"); },
    },
    auth: authenticated(),
    enqueuer: { enqueue: async () => {} },
    oauthProvider: {},
  });
  const response = await request(app).post("/v1/mail/mail-1/transfer").send({ targetAttendeeRef: "not-a-uuid" }).expect(400);
  assert.equal(response.body.code, "invalid_request_body");
  assert.ok(response.body.correlationId);
});
