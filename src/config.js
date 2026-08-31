const requiredInProduction = [
  "INSTANCE_CONNECTION_NAME",
  "DB_NAME",
  "DB_USER",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_CLIENT_SECRET_RESOURCE",
  "ALLOWED_DOMAIN",
  "CLOUD_RUN_AUDIENCE",
  "GATEWAY_SA_EMAIL",
  "BOOTSTRAP_SA_EMAIL",
  "SCHEDULER_SA_EMAIL",
  "TASKS_SA_EMAIL",
  "ADMIN_SA_EMAIL",
  "RUNTIME_SA_EMAIL",
  "PUBSUB_SA_EMAIL",
  "GMAIL_PUBSUB_TOPIC",
  "KMS_KEY_NAME",
  "GOOGLE_CLOUD_PROJECT",
];

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  if (nodeEnv === "production") {
    const missing = requiredInProduction.filter((name) => !env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
    if (env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is not allowed in production; use Cloud SQL Connector IAM authentication");
    }
  }

  return Object.freeze({
    nodeEnv,
    port: Number(env.PORT || 8080),
    databaseUrl: env.DATABASE_URL,
    database: Object.freeze({
      instanceConnectionName: readOptionalFrom(env, "INSTANCE_CONNECTION_NAME"),
      name: readOptionalFrom(env, "DB_NAME"),
      user: readOptionalFrom(env, "DB_USER"),
      ipType: readOptionalFrom(env, "DB_IP_TYPE") || "PRIVATE",
    }),
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleOAuthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    googleOAuthClientSecretResource: env.GOOGLE_OAUTH_CLIENT_SECRET_RESOURCE,
    allowedDomain: env.ALLOWED_DOMAIN,
    cloudRunAudience: env.CLOUD_RUN_AUDIENCE,
    serviceAccounts: Object.freeze({
      gateway: env.GATEWAY_SA_EMAIL,
      bootstrap: env.BOOTSTRAP_SA_EMAIL,
      scheduler: env.SCHEDULER_SA_EMAIL,
      tasks: env.TASKS_SA_EMAIL,
      admin: env.ADMIN_SA_EMAIL,
      runtime: env.RUNTIME_SA_EMAIL,
      pubsub: env.PUBSUB_SA_EMAIL,
    }),
    kmsKeyName: env.KMS_KEY_NAME,
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
    cloudTasks: Object.freeze({
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.CLOUD_TASKS_LOCATION,
      queue: env.CLOUD_TASKS_QUEUE,
      targetUrl: env.CLOUD_TASKS_TARGET_URL,
    }),
    gmailPubsubTopic: readOptionalFrom(env, "GMAIL_PUBSUB_TOPIC"),
    ai: Object.freeze({
      enabled: readBooleanFrom(env, "AI_ANALYSIS_ENABLED", false),
      flashLiteModel: readOptionalFrom(env, "GEMINI_FLASH_LITE_MODEL") || "gemini-2.5-flash-lite",
      flashModel: readOptionalFrom(env, "GEMINI_FLASH_MODEL") || "gemini-2.5-flash",
      dailyRequestLimit: readPositiveIntegerFrom(env, "GEMINI_DAILY_REQUEST_LIMIT", 100),
      maxOutputTokens: readPositiveIntegerFrom(env, "GEMINI_MAX_OUTPUT_TOKENS", 800),
    }),
  });
}

function readOptionalFrom(env, name) {
  const value = env[name]?.trim();
  return value || undefined;
}

function readBooleanFrom(env, name, fallback) {
  const value = readOptionalFrom(env, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readPositiveIntegerFrom(env, name, fallback) {
  const value = readOptionalFrom(env, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export const config = loadConfig();
