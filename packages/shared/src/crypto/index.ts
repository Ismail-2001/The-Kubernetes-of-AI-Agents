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

// ── Password Hashing (scrypt) ──────────────────────────────────────────────

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
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

  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    cost,
    blockSize,
    parallelization,
  });

  return crypto.timingSafeEqual(hash, expectedHash);
}

// ── JWT (HS256) ─────────────────────────────────────────────────────────────

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
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64");
}

export function signJWT(
  claims: Omit<JWTClaims, "iat" | "exp">,
  secret: string,
  expiresInSec: number = 86400
): string {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(JSON.stringify({ ...claims, iat: now, exp: now + expiresInSec }));
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64urlEncode(signature)}`;
}

export function verifyJWT(token: string, secret: string): JWTClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = parts[0] ?? "";
  const payload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const data = `${header}.${payload}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(data).digest();
  const actualSig = base64urlDecode(signature);

  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

  const claims = JSON.parse(base64urlDecode(payload).toString("utf8")) as JWTClaims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) return null;

  return claims;
}
