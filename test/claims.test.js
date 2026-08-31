import assert from "node:assert/strict";
import test from "node:test";
import { assertClaimCommandAllowed, assertForceClaimAllowed, claimState } from "../src/domain/claims.js";

const now = new Date("2026-07-15T12:00:00Z");

test("normal claims expire after two hours", () => {
  const mail = { status: "未対応", claimerAttendeeRef: "a", claimedAt: "2026-07-15T09:59:59Z" };
  assert.equal(claimState(mail, now), "expired");
  assert.throws(() => assertClaimCommandAllowed(mail, "a", now), { code: "claim_required" });
});

test("pending calendar claim remains active before 24 hours", () => {
  const mail = { status: "pending_calendar", claimerAttendeeRef: "a", claimedAt: "2026-07-14T13:00:00Z" };
  assert.equal(claimState(mail, now), "active");
  assert.doesNotThrow(() => assertClaimCommandAllowed(mail, "a", now));
});

test("pending calendar claim is force-claimable after 24 hours", () => {
  const mail = { status: "pending_calendar", claimerAttendeeRef: "a", claimedAt: "2026-07-14T11:59:59Z" };
  assert.equal(claimState(mail, now), "force_claimable");
  assert.doesNotThrow(() => assertForceClaimAllowed(mail, "b", true, now));
  assert.throws(() => assertForceClaimAllowed(mail, "b", false, now), { code: "forbidden" });
});

test("a non-claimant cannot execute a claim command", () => {
  const mail = { status: "pending_calendar", claimerAttendeeRef: "a", claimedAt: "2026-07-15T11:00:00Z" };
  assert.throws(() => assertClaimCommandAllowed(mail, "b", now), { code: "forbidden" });
});
