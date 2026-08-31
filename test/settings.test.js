import assert from "node:assert/strict";
import test from "node:test";
import { settingsEtag, validateSettings } from "../src/services/settings-service.js";

const complete = {
  organizationDomain: "example.com",
  businessHours: {},
  schedulingPolicy: {},
  pollEnabled: true,
  faqCategories: [],
  dwdAllowlistEmails: [],
};

test("settings ETag is independent of object key order", () => {
  assert.equal(settingsEtag(3, { a: 1, b: 2 }), settingsEtag(3, { b: 2, a: 1 }));
});

test("authorization membership cannot be replaced through settings", () => {
  assert.throws(
    () => validateSettings({ ...complete, businessUnits: [] }, {}),
    { code: "business_units_read_only" },
  );
});

test("settings validates DWD allowlist shape", () => {
  assert.throws(() => validateSettings({ ...complete, dwdAllowlistEmails: "user@example.com" }, {}), { code: "invalid_dwd_allowlist" });
  assert.doesNotThrow(() => validateSettings({ ...complete, dwdAllowlistEmails: ["user@example.com"] }, {}));
});

test("settings rejects unknown keys and invalid domains", () => {
  assert.throws(() => validateSettings({ ...complete, unexpected: true }, {}), { code: "unknown_settings" });
  assert.throws(() => validateSettings({ ...complete, organizationDomain: "not a domain" }, {}), { code: "invalid_organization_domain" });
});
