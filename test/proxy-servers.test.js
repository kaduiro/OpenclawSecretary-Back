import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createAuthBootstrapApp } from "../src/auth-bootstrap-server.js";
import { createGatewayApp } from "../src/gateway-server.js";

const config = {
  backendUrl: "https://api.example.test",
  backendAudience: "https://api.example.test",
  bootstrapUrl: "https://bootstrap.example.test",
  iapAudience: "/projects/123/global/backendServices/456",
};

function identity() {
  return {
    verifyIap: async (assertion) => {
      if (assertion !== "valid-iap") throw Object.assign(new Error("IAP assertion is invalid"), { status: 401 });
      return { sub: "iap-user", email: "user@example.test" };
    },
    backendAuthorization: async () => "Bearer service-token",
  };
}

test("gateway starts OAuth only after IAP verification", async () => {
  let captured;
  const app = createGatewayApp({
    config,
    identity: identity(),
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return Response.json({ authorizationUrl: "https://accounts.example.test/auth" });
    },
  });
  await request(app)
    .get("/v1/auth/start?return_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback&handoff_challenge=challenge")
    .set("x-goog-iap-jwt-assertion", "valid-iap")
    .expect(302)
    .expect("location", "https://accounts.example.test/auth");
  assert.equal(captured.url, "https://api.example.test/internal/auth/oauth-sessions");
  assert.equal(captured.options.headers.Authorization, "Bearer service-token");
});

test("gateway callback sends only opaque handoff material and bootstrap URL to loopback", async () => {
  const app = createGatewayApp({
    config,
    identity: identity(),
    fetchImpl: async () => Response.json({
      handoffCode: "opaque-code",
      expiresAt: "2026-07-20T00:00:00Z",
      returnUri: "http://127.0.0.1:49152/callback",
    }),
  });
  const response = await request(app)
    .get("/v1/auth/callback?code=google-code&state=state")
    .set("x-goog-iap-jwt-assertion", "valid-iap")
    .expect(200);
  assert.match(response.text, /opaque-code/);
  assert.match(response.text, /bootstrap\.example\.test/);
  assert.doesNotMatch(response.text, /idToken/);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("gateway rejects requests without a valid IAP assertion", async () => {
  const app = createGatewayApp({ config, identity: identity(), fetchImpl: async () => { throw new Error("not called"); } });
  await request(app).get("/v1/mail/tickets").expect(401);
});

test("auth bootstrap rejects browser origins and forwards Electron main requests with service identity", async () => {
  let captured;
  const app = createAuthBootstrapApp({
    config,
    identity: identity(),
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return Response.json({ idToken: "secret", expiresAt: "2026-07-20T00:00:00Z", claims: {}, bootstrap: { completed: true } });
    },
  });
  await request(app).post("/v1/auth/handoff/redeem").set("origin", "https://evil.example").send({}).expect(403);
  await request(app).post("/v1/auth/handoff/redeem").send({ handoffCode: "code", handoffVerifier: "verifier" }).expect(200);
  assert.equal(captured.url, "https://api.example.test/internal/auth/handoff/redeem");
  assert.equal(captured.options.headers.Authorization, "Bearer service-token");
});
