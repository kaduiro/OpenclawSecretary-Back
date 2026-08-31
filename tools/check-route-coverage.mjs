import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = YAML.parse(fs.readFileSync(path.join(root, "docs/api/openapi.yaml"), "utf8"));
const methods = new Set(["get", "post", "put", "patch", "delete"]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : entry.name.endsWith(".js") ? [target] : [];
  });
}

const registered = new Set();
for (const filename of sourceFiles(path.join(root, "src"))) {
  const source = fs.readFileSync(filename, "utf8");
  for (const match of source.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)) {
    const normalized = match[2].replace(/:([^/]+)/g, "{$1}");
    registered.add(`${match[1].toUpperCase()} ${normalized}`);
  }
}

const expected = [];
for (const [routePath, item] of Object.entries(spec.paths)) {
  for (const method of Object.keys(item)) {
    if (methods.has(method)) expected.push(`${method.toUpperCase()} ${routePath}`);
  }
}

const missing = expected.filter((route) => !registered.has(route));
const undocumented = [...registered].filter((route) => !expected.includes(route));
if (missing.length || undocumented.length) {
  if (missing.length) console.error(`Missing handlers:\n${missing.join("\n")}`);
  if (undocumented.length) console.error(`Undocumented handlers:\n${undocumented.join("\n")}`);
  process.exit(1);
}
console.log(`Route coverage: ${expected.length}/${expected.length} OpenAPI operations registered`);
