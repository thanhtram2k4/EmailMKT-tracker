/**
 * Application-level encryption for secrets stored in the database (e.g. the Notion
 * integration token). AES-256-GCM with a random 96-bit IV per value, a 128-bit auth tag,
 * a key id for rotation, and associated data binding the ciphertext to its purpose
 * (so a token encrypted for one column cannot be replayed into another).
 *
 * Format: "<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>"
 * Key: APP_ENCRYPTION_KEY = 32 random bytes, base64url. Key id: APP_ENCRYPTION_KEY_ID (default "k1").
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

export type SecretKey = { id: string; key: Buffer };

export function parseKey(b64url: string | undefined, id = "k1"): SecretKey {
  if (!b64url) throw new SecretKeyError("APP_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(b64url, "base64url");
  if (key.length !== 32) throw new SecretKeyError("APP_ENCRYPTION_KEY must decode to exactly 32 bytes (base64url)");
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) throw new SecretKeyError("APP_ENCRYPTION_KEY_ID must be 1-16 url-safe characters");
  return { id, key };
}

export function encryptSecret(plaintext: string, key: SecretKey, associatedData: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [key.id, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(sealed: string, keys: SecretKey[], associatedData: string): string {
  const parts = sealed.split(":");
  if (parts.length !== 4) throw new SecretKeyError("malformed encrypted value");
  const [id, ivB, tagB, ctB] = parts;
  const key = keys.find((k) => k.id === id);
  if (!key) throw new SecretKeyError(`no encryption key with id "${id}" is configured`);
  const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(ivB, "base64url"));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError("encrypted value failed authentication (wrong key, wrong purpose or tampered)");
  }
}

/** Keys from the environment: current key plus optional previous key for rotation. */
export function keysFromEnv(env: Record<string, string | undefined> = process.env): { current: SecretKey; all: SecretKey[] } {
  const current = parseKey(env.APP_ENCRYPTION_KEY, env.APP_ENCRYPTION_KEY_ID ?? "k1");
  const all = [current];
  if (env.APP_ENCRYPTION_KEY_PREVIOUS) all.push(parseKey(env.APP_ENCRYPTION_KEY_PREVIOUS, env.APP_ENCRYPTION_KEY_PREVIOUS_ID ?? "k0"));
  return { current, all };
}
