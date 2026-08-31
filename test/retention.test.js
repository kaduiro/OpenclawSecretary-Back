import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/retention-service.js", import.meta.url), "utf8");

test("retention keeps unresolved dead letters and uses bounded locking", () => {
  assert.match(source, /status='dead_letter' AND resolved_at IS NOT NULL/);
  assert.match(source, /FOR UPDATE SKIP LOCKED LIMIT \$1/);
  assert.doesNotMatch(source, /status='dead_letter' AND created_at/);
});
