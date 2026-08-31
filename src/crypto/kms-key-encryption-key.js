import { KeyManagementServiceClient } from "@google-cloud/kms";

export class KmsKeyEncryptionKey {
  constructor(keyName, client = new KeyManagementServiceClient()) {
    if (!keyName) throw new Error("KMS_KEY_NAME is required");
    this.keyName = keyName;
    this.client = client;
  }

  async wrap(dek) {
    const [response] = await this.client.encrypt({ name: this.keyName, plaintext: dek });
    return {
      ciphertext: Buffer.from(response.ciphertext),
      keyVersion: response.name || this.keyName,
    };
  }

  async unwrap(ciphertext) {
    const [response] = await this.client.decrypt({ name: this.keyName, ciphertext });
    return Buffer.from(response.plaintext);
  }
}
