import { conflict, forbidden } from "../lib/errors.js";

export const NORMAL_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const FORCE_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export function claimState(mail, now = new Date()) {
  if (!mail.claimerAttendeeRef || !mail.claimedAt) return "unclaimed";
  const age = now.getTime() - new Date(mail.claimedAt).getTime();
  if (mail.status === "pending_calendar") {
    return age >= FORCE_CLAIM_TTL_MS ? "force_claimable" : "active";
  }
  return age >= NORMAL_CLAIM_TTL_MS ? "expired" : "active";
}

export function assertClaimCommandAllowed(mail, actorAttendeeRef, now = new Date()) {
  const state = claimState(mail, now);
  if (state === "expired" || state === "unclaimed") throw conflict("claim_required", "The mail must be claimed again");
  if (mail.claimerAttendeeRef !== actorAttendeeRef) throw forbidden("Only the current claimant may perform this command");
}

export function assertForceClaimAllowed(mail, actorAttendeeRef, sameBusinessUnit, now = new Date()) {
  if (!sameBusinessUnit) throw forbidden("Force-claim is limited to active members of the same BU");
  if (mail.claimerAttendeeRef === actorAttendeeRef) throw conflict("already_claimed", "The caller already owns this claim");
  if (claimState(mail, now) !== "force_claimable") {
    throw conflict("claim_not_stale", "A pending calendar claim can be force-claimed only after 24 hours");
  }
}
