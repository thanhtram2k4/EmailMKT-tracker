import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, keysFromEnv, parseKey, SecretKeyError } from "../../src/lib/crypto/secrets";

const k = () => randomBytes(32).toString("base64url");

describe("secret encryption (AES-256-GCM)", () => {
  it("round-trips and never contains the plaintext", () => {
    const key = parseKey(k());
    const sealed = encryptSecret("ntn_example_token_value", key, "ctx");
    expect(sealed).not.toContain("ntn_example_token_value");
    expect(sealed.startsWith("k1:")).toBe(true);
    expect(decryptSecret(sealed, [key], "ctx")).toBe("ntn_example_token_value");
  });
  it("uses a fresh IV each time", () => {
    const key = parseKey(k());
    expect(encryptSecret("same", key, "ctx")).not.toBe(encryptSecret("same", key, "ctx"));
  });
  it("rejects tampering, the wrong purpose and the wrong key", () => {
    const key = parseKey(k());
    const sealed = encryptSecret("secret", key, "ctx");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"), [key], "ctx")).toThrow(SecretKeyError);
    expect(() => decryptSecret(sealed, [key], "other-ctx")).toThrow(/failed authentication/);
    expect(() => decryptSecret(sealed, [parseKey(k())], "ctx")).toThrow(/failed authentication/);
  });
  it("supports rotation with a previous key", () => {
    const oldKey = k();
    const sealedOld = encryptSecret("v", parseKey(oldKey, "k0"), "ctx");
    const { all, current } = keysFromEnv({ APP_ENCRYPTION_KEY: k(), APP_ENCRYPTION_KEY_ID: "k1", APP_ENCRYPTION_KEY_PREVIOUS: oldKey, APP_ENCRYPTION_KEY_PREVIOUS_ID: "k0" });
    expect(current.id).toBe("k1");
    expect(decryptSecret(sealedOld, all, "ctx")).toBe("v");
  });
  it("validates key material", () => {
    expect(() => parseKey(undefined)).toThrow(/not configured/);
    expect(() => parseKey(Buffer.alloc(16).toString("base64url"))).toThrow(/32 bytes/);
  });
});
