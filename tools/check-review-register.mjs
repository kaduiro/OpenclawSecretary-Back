import fs from "node:fs";
import path from "node:path";

const registerPath = path.resolve("docs/reviews/review-register.md");
const text = fs.readFileSync(registerPath, "utf8");
const allowedStatuses = new Set(["OPEN", "VERIFY_REQUIRED", "BLOCKED_DECISION", "RESOLVED", "ACCEPTED_RISK"]);
const requiredIds = [
  "CR-AUTH-001",
  "CR-GW-001",
  "CR-CAL-001",
  "CR-CAL-002",
  "CR-DWD-001",
  "CR-AI-001",
  "CR-RAG-001",
  "CR-API-001",
  "CR-API-002",
  "CR-DB-001",
  "CR-IMG-001",
  "CR-GCP-001",
  "CR-TASK-001",
  "CR-INF-001",
  "CR-E2E-001",
  "CR-DOC-001",
  "CR-INF-002",
  "CR-INF-DB-001",
  "CR-FRONT-SEC-001",
  "CR-FRONT-AUTH-001",
  "CR-FRONT-NET-001",
  "CR-FRONT-CONTRACT-001",
  "CR-FRONT-BOOT-001",
  "CR-FRONT-SESSION-001",
  "CR-FRONT-CLAIM-001",
  "CR-FRONT-OPS-001",
  "CR-FRONT-DIST-001",
  "CR-INF-ALERT-001",
  "CR-INF-STATE-001",
  "CR-INF-IAP-001",
  "CR-INF-HA-001",
  "CR-INF-OBS-001",
  "CR-INF-SUPPLY-001",
  "CR-CI-001",
  "CR-BE-BASE-001",
  "CR-FRONT-BASE-001",
  "CR-INF-BASE-001",
];

const rows = [...text.matchAll(/^\| (CR-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}) \| (P[0-3]) \| ([A-Z_]+) \| ([A-Z_]+) \|/gm)];
const ids = rows.map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
const missing = requiredIds.filter((id) => !ids.includes(id));
const invalidStatuses = rows.filter((match) => !allowedStatuses.has(match[4])).map((match) => `${match[1]}=${match[4]}`);

const errors = [];
if (duplicates.length) errors.push(`duplicate IDs: ${[...new Set(duplicates)].join(", ")}`);
if (missing.length) errors.push(`baseline IDs removed: ${missing.join(", ")}`);
if (invalidStatuses.length) errors.push(`invalid statuses: ${invalidStatuses.join(", ")}`);
if (!text.includes("新規") || !text.includes("状態変更") || !text.includes("継続") || !text.includes("解消")) {
  errors.push("review output template is incomplete");
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Review register: ${rows.length} stable IDs, ${allowedStatuses.size} allowed statuses`);
