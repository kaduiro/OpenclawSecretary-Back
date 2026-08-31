import fs from "node:fs";
import process from "node:process";
import YAML from "yaml";

const source = fs.readFileSync(new URL("../docs/api/openapi.yaml", import.meta.url), "utf8");
const document = YAML.parseDocument(source, { uniqueKeys: true, strict: true });
if (document.errors.length > 0) {
  for (const error of document.errors) console.error(error.message);
  process.exit(1);
}
const spec = document.toJS();
const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const operationIds = new Set();
const missingRefs = [];

function resolvePointer(ref) {
  if (!ref.startsWith("#/")) return true;
  let current = spec;
  for (const segment of ref.slice(2).split("/")) {
    current = current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current !== undefined;
}

function visit(value) {
  if (Array.isArray(value)) return value.forEach(visit);
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && !resolvePointer(value.$ref)) missingRefs.push(value.$ref);
  Object.values(value).forEach(visit);
}

for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    if (!operation.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
    if (operationIds.has(operation.operationId)) throw new Error(`Duplicate operationId: ${operation.operationId}`);
    operationIds.add(operation.operationId);
    if (!operation.responses || Object.keys(operation.responses).length === 0) {
      throw new Error(`${operation.operationId} has no responses`);
    }
  }
}
visit(spec);
if (missingRefs.length > 0) throw new Error(`Missing refs: ${[...new Set(missingRefs)].join(", ")}`);
for (const required of [
  "bindFirstLoginSubject",
  "listPendingMailTickets",
  "getMailSendOperation",
  "createBusinessUnit",
  "disableBusinessUnit",
  "dispatchOutbox",
  "replayOutboxEvent",
  "reconcileMailSendOperations",
  "compensateOAuthProvisioning",
  "runPiiRetentionMask",
]) {
  if (!operationIds.has(required)) throw new Error(`Required remediation operation is missing: ${required}`);
}
console.log(`OpenAPI ${spec.info.version}: ${Object.keys(spec.paths).length} paths, ${operationIds.size} operations, refs valid`);
