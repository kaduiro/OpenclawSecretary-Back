import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("production configuration fails closed", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /Missing required environment variables/);
});

test("service-account schemes remain separate", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    GATEWAY_SA_EMAIL: "gateway@example.test",
    BOOTSTRAP_SA_EMAIL: "bootstrap@example.test",
    SCHEDULER_SA_EMAIL: "scheduler@example.test",
    TASKS_SA_EMAIL: "tasks@example.test",
    ADMIN_SA_EMAIL: "admin@example.test",
    RUNTIME_SA_EMAIL: "runtime@example.test",
    PUBSUB_SA_EMAIL: "pubsub@example.test",
    GMAIL_PUBSUB_TOPIC: "projects/project/topics/gmail",
  });
  assert.notEqual(config.serviceAccounts.admin, config.serviceAccounts.scheduler);
  assert.equal(config.serviceAccounts.tasks, "tasks@example.test");
  assert.notEqual(config.serviceAccounts.gateway, config.serviceAccounts.bootstrap);
});

test("production forbids password DATABASE_URL fallback", () => {
  const production = {
    NODE_ENV: "production",
    INSTANCE_CONNECTION_NAME: "project:region:instance",
    DB_NAME: "openclaw",
    DB_USER: "runtime@project.iam",
    DATABASE_URL: "postgres://password@example/openclaw",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_OAUTH_REDIRECT_URI: "https://gateway.example/v1/auth/callback",
    GOOGLE_OAUTH_CLIENT_SECRET_RESOURCE: "projects/p/secrets/s",
    ALLOWED_DOMAIN: "example.test",
    CLOUD_RUN_AUDIENCE: "https://api.example",
    GATEWAY_SA_EMAIL: "gateway@example.test",
    BOOTSTRAP_SA_EMAIL: "bootstrap@example.test",
    SCHEDULER_SA_EMAIL: "scheduler@example.test",
    TASKS_SA_EMAIL: "tasks@example.test",
    ADMIN_SA_EMAIL: "admin@example.test",
    RUNTIME_SA_EMAIL: "runtime@example.test",
    PUBSUB_SA_EMAIL: "pubsub@example.test",
    GMAIL_PUBSUB_TOPIC: "projects/project/topics/gmail",
    KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    GOOGLE_CLOUD_PROJECT: "project",
  };
  assert.throws(() => loadConfig(production), /DATABASE_URL is not allowed/);
});
