/**
 * Secrets crypto contract — AES-256-GCM with a base64 key from
 * SECRETS_ENCRYPTION_KEY (must decode to exactly 32 bytes).
 *
 * Payload format: `v1:<iv_b64>:<ciphertext_b64>:<authTag_b64>`
 * (12-byte random IV per encryption).
 *
 * Framework-agnostic: no next/react imports allowed here.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

function getKey(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must be base64 of exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    authTag.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed secret payload: expected 4 colon-separated parts");
  }
  const [version, ivB64, ciphertextB64, authTagB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unknown secret payload version: ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("Malformed secret payload: bad IV length");
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Malformed secret payload: bad auth tag length");
  }

  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // GCM auth-tag verification failure throws here.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

export function maskSecret(plaintext: string): { set: true; last4: string } {
  return { set: true, last4: plaintext.slice(-4) };
}
