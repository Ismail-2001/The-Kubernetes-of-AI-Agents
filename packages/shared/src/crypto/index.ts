import crypto from "crypto";

export interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
  keyId: string;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export function generateNonce(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

export async function encrypt(plaintext: string, keyId: string): Promise<EncryptedPayload> {
  const key = deriveKeyFromId(keyId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
    keyId,
  };
}

export async function decrypt(payload: EncryptedPayload, keyId: string): Promise<string> {
  const key = deriveKeyFromId(keyId);
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const encrypted = Buffer.from(payload.data, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function hashForCache(input: object): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function deriveKeyFromId(keyId: string): Buffer {
  return crypto.createHash("sha256").update(keyId).digest();
}
