import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constantTimeEqual, sha256 } from "../lib/hash.js";

const ALGORITHM = "AES-256-GCM";
const ENVELOPE_VERSION = 1;

function encode(value) {
  return Buffer.from(value).toString("base64");
}

function decode(value) {
  return Buffer.from(value, "base64");
}

export class EnvelopeCrypto {
  constructor(keyEncryptionKey) {
    this.keyEncryptionKey = keyEncryptionKey;
  }

  async encrypt(plaintext, aad) {
    const dek = randomBytes(32);
    const nonce = randomBytes(12);
    const aadBuffer = Buffer.from(aad, "utf8");
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(aadBuffer);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrapped = await this.keyEncryptionKey.wrap(dek);
    dek.fill(0);
    return Object.freeze({
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      ciphertext: encode(ciphertext),
      encryptedDek: encode(wrapped.ciphertext),
      nonce: encode(nonce),
      tag: encode(tag),
      aadDigest: encode(sha256(aad)),
      keyVersion: wrapped.keyVersion,
    });
  }

  async decrypt(envelope, aad) {
    if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
      throw new Error("Unsupported encryption envelope");
    }
    if (!constantTimeEqual(decode(envelope.aadDigest), sha256(aad))) {
      throw new Error("Encryption context mismatch");
    }
    const dek = await this.keyEncryptionKey.unwrap(decode(envelope.encryptedDek), envelope.keyVersion);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dek, decode(envelope.nonce));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(decode(envelope.tag));
      return Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString("utf8");
    } finally {
      dek.fill(0);
    }
  }
}
