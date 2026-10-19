import crypto from "crypto";
import { scryptSync, timingSafeEqual } from "crypto";

export interface EncryptedPayloadV1 {
  iv: string;
  tag: string;
  data: string;
  keyId: string;
}

export interface EncryptedPayloadV2 {
  version: 2;
  algorithm: "aes-256-gcm";
  kdf: {
    name: "scrypt" | "argon2id";
    cost?: number;
    blockSize?: number;
    parallelization?: number;
    memoryCost?: number;
    timeCost?: number;
    parallelism?: number;
  };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  keyId: string;
  createdAt: string;
}

export type EncryptedPayload = EncryptedPayloadV2;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 32;
const DEFAULT_KEY_ID = "v1";

export function generateNonce(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

function deriveKey(keyMaterial: string, salt: Buffer): Buffer {
  return scryptSync(keyMaterial, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
}

export async function encrypt(
  plaintext: string,
  keyMaterial: string,
  keyId: string = DEFAULT_KEY_ID
): Promise<EncryptedPayload> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(keyMaterial, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 2,
    algorithm: "aes-256-gcm",
    kdf: {
      name: "scrypt",
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
    },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    keyId,
    createdAt: new Date().toISOString(),
  };
}

export async function decrypt(payload: EncryptedPayloadV2, keyMaterial: string): Promise<string> {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = deriveKey(keyMaterial, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function isLegacyPayload(payload: EncryptedPayload, keyMaterial: string): boolean {
  return payload.kdf?.name === "argon2id" || payload.keyId === keyMaterial;
}

export async function reencryptWithNewKey(
  oldPayload: EncryptedPayload,
  oldKeyMaterial: string,
  newKeyMaterial: string,
  newKeyId: string = DEFAULT_KEY_ID
): Promise<EncryptedPayload> {
  const plaintext = await decrypt(oldPayload, oldKeyMaterial);
  return encrypt(plaintext, newKeyMaterial, newKeyId);
}

export function hashForCache(input: object): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
  return `scrypt:${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELIZATION}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export async function comparePassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const cost = parseInt(parts[1] ?? "0", 10);
  const blockSize = parseInt(parts[2] ?? "0", 10);
  const parallelization = parseInt(parts[3] ?? "0", 10);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expectedHash = Buffer.from(parts[5] ?? "", "base64");

  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, { cost, blockSize, parallelization });
  return timingSafeEqual(hash, expectedHash);
}

export interface JWTClaims {
  sub: string;
  email: string;
  name: string;
  role: string;
  namespace_access: string[];
  iat: number;
  exp: number;
}

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let s = buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  while (s.endsWith("=")) s = s.slice(0, -1);
  return s;
}

function base64urlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64");
}

export function signJWT(claims: Omit<JWTClaims, "iat" | "exp">, secret: string, expiresInSec: number = 86400): string {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(JSON.stringify({ ...claims, iat: now, exp: now + expiresInSec }));
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64urlEncode(signature)}`;
}

export function verifyJWT(token: string, primarySecret: string, oldSecret?: string): JWTClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = parts[0] ?? "";
  const payload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const data = `${header}.${payload}`;

  const verifyWith = (secret: string): JWTClaims | null => {
    const expectedSig = crypto.createHmac("sha256", secret).update(data).digest();
    const actualSig = base64urlDecode(signature);
    if (expectedSig.length !== actualSig.length) return null;
    if (!timingSafeEqual(expectedSig, actualSig)) return null;

    const claims = JSON.parse(base64urlDecode(payload).toString("utf8")) as JWTClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) return null;
    return claims;
  };

  const result = verifyWith(primarySecret);
  if (result) return result;

  if (oldSecret) {
    return verifyWith(oldSecret);
  }

  return null;
}
