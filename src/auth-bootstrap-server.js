import { fileURLToPath } from "node:url";
import express from "express";
import { GoogleProxyIdentity } from "./proxy/google-identity.js";
import { relayResponse, upstreamJson } from "./proxy/upstream.js";

export function loadBootstrapConfig(env = process.env) {
  const config = { port: Number(env.PORT || 8080), backendUrl: env.BACKEND_URL, backendAudience: env.BACKEND_AUDIENCE };
  if (!config.backendUrl || !config.backendAudience) throw new Error("BACKEND_URL and BACKEND_AUDIENCE are required");
  return Object.freeze(config);
}

function rateLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const current = clients.get(key);
    const record = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    record.count += 1;
    clients.set(key, record);
    if (record.count > limit) {
      res.set("Retry-After", String(Math.ceil((record.resetAt - now) / 1000)));
      return res.status(429).json({ code: "rate_limited", message: "Too many handoff attempts" });
    }
    next();
  };
}

export function createAuthBootstrapApp({ config, identity = new GoogleProxyIdentity(config), fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "8kb", strict: true }));
  app.get("/livez", (_req, res) => res.json({ status: "ok" }));
  app.post("/v1/auth/handoff/redeem", rateLimiter(), async (req, res, next) => {
    try {
      if (req.get("origin")) return res.status(403).json({ code: "browser_request_forbidden", message: "Browser requests are not allowed" });
      const upstream = await upstreamJson({
        fetchImpl, identity, backendUrl: config.backendUrl, path: "/internal/auth/handoff/redeem", method: "POST", body: req.body,
      });
      await relayResponse(upstream, res);
    } catch (error) {
      next(error);
    }
  });
  app.use((_req, res) => res.status(404).set("Cache-Control", "no-store").json({ code: "not_found", message: "Not found" }));
  app.use((error, _req, res, _next) => res.status(error?.status || 502).set("Cache-Control", "no-store").json({ code: "bootstrap_error", message: error?.message || "Bootstrap request failed" }));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadBootstrapConfig();
  createAuthBootstrapApp({ config }).listen(config.port);
}
