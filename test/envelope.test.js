import assert from "node:assert/strict";
import test from "node:test";
import { EnvelopeCrypto } from "../src/crypto/envelope.js";

class TestKeyEncryptionKey {
  async wrap(dek) {
    return { ciphertext: Buffer.from(dek), keyVersion: "test-key/versions/1" };
  }
  async unwrap(ciphertext) {
    return Buffer.from(ciphertext);
  }
}

test("envelope encryption round-trips with bound AAD", async () => {
  const crypto = new EnvelopeCrypto(new TestKeyEncryptionKey());
  const envelope = await crypto.encrypt("sensitive draft", "mail:123:reply-draft");
  assert.equal(envelope.algorithm, "AES-256-GCM");
  assert.equal(await crypto.decrypt(envelope, "mail:123:reply-draft"), "sensitive draft");
});

test("envelope rejects a different resource context", async () => {
  const crypto = new EnvelopeCrypto(new TestKeyEncryptionKey());
  const envelope = await crypto.encrypt("sensitive draft", "mail:123:reply-draft");
  await assert.rejects(() => crypto.decrypt(envelope, "mail:456:reply-draft"), /context mismatch/);
});

test("envelope rejects ciphertext tampering", async () => {
  const crypto = new EnvelopeCrypto(new TestKeyEncryptionKey());
  const envelope = await crypto.encrypt("sensitive draft", "mail:123:reply-draft");
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 1;
  await assert.rejects(() => crypto.decrypt({ ...envelope, ciphertext: bytes.toString("base64") }, "mail:123:reply-draft"));
});
