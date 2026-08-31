import { createHash, timingSafeEqual } from "node:crypto";

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function sha256Hex(value) {
  return sha256(value).toString("hex");
}

export function constantTimeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
