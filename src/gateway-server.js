import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { GoogleProxyIdentity } from "./proxy/google-identity.js";
import { relayResponse, upstreamJson } from "./proxy/upstream.js";

export function loadGatewayConfig(env = process.env) {
  const config = {
    port: Number(env.PORT || 8080),
    backendUrl: env.BACKEND_URL,
    backendAudience: env.BACKEND_AUDIENCE,
    bootstrapUrl: env.AUTH_BOOTSTRAP_URL,
    iapAudience: env.IAP_AUDIENCE,
  };
  const missing = Object.entries(config).filter(([key, value]) => key !== "port" && !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing gateway configuration: ${missing.join(", ")}`);
  return Object.freeze(config);
}

function publicError(error) {
  return { status: error?.status || 502, code: error?.status === 401 ? "iap_unauthorized" : "gateway_error", message: error?.message || "Gateway request failed" };
}

export function createGatewayApp({ config, identity = new GoogleProxyIdentity(config), fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb", strict: true }));
  app.get("/livez", (_req, res) => res.json({ status: "ok" }));

  const requireIap = async (req, _res, next) => {
    try {
      req.iapIdentity = await identity.verifyIap(req.get("x-goog-iap-jwt-assertion"));
      next();
    } catch (error) {
      next(error);
    }
  };

  app.get("/v1/auth/start", requireIap, async (req, res, next) => {
    try {
      const upstream = await upstreamJson({
        fetchImpl, identity, backendUrl: config.backendUrl, path: "/internal/auth/oauth-sessions", method: "POST",
        body: { returnUri: req.query.return_uri, handoffChallenge: req.query.handoff_challenge },
      });
      if (!upstream.ok) return relayResponse(upstream, res);
      const result = await upstream.json();
      res.set("Cache-Control", "no-store").redirect(302, result.authorizationUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/auth/callback", requireIap, async (req, res, next) => {
    try {
      const upstream = await upstreamJson({
        fetchImpl, identity, backendUrl: config.backendUrl, path: "/internal/auth/oauth-exchange", method: "POST",
        body: { code: req.query.code, state: req.query.state },
      });
      if (!upstream.ok) return relayResponse(upstream, res);
      const result = await upstream.json();
      const nonce = randomBytes(16).toString("base64url");
      const inputs = { handoffCode: result.handoffCode, redeemUrl: new URL("/v1/auth/handoff/redeem", config.bootstrapUrl).toString() };
      res
        .set("Cache-Control", "no-store")
        .set("Referrer-Policy", "no-referrer")
        .set("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${result.returnUri}`)
        .type("html")
        .send(`<!doctype html><meta charset="utf-8"><form id="handoff" method="post"></form><script nonce="${nonce}">const f=document.getElementById("handoff");f.action=${JSON.stringify(result.returnUri)};const values=${JSON.stringify(inputs)};for(const [name,value] of Object.entries(values)){const i=document.createElement("input");i.type="hidden";i.name=name;i.value=value;f.appendChild(i)}f.submit();</script>`);
    } catch (error) {
      next(error);
    }
  });

  app.use("/v1", requireIap, async (req, res, next) => {
    try {
      if (req.path === "/auth/handoff/redeem") return res.status(404).json({ code: "not_found", message: "Not found" });
      const userAuthorization = req.get("authorization");
      if (!userAuthorization?.startsWith("Bearer ")) return res.status(401).json({ code: "auth_required", message: "User authentication is required" });
      const upstream = await upstreamJson({
        fetchImpl,
        identity,
        backendUrl: config.backendUrl,
        path: `/v1${req.url}`,
        method: req.method,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        userAuthorization,
      });
      await relayResponse(upstream, res);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const payload = publicError(error);
    res.status(payload.status).set("Cache-Control", "no-store").json(payload);
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadGatewayConfig();
  createGatewayApp({ config }).listen(config.port);
}
