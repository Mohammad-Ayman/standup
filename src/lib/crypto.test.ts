import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

// Fixed 32-byte test key (base64 of "0123456789abcdef0123456789abcdef").
const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
);

describe("crypto", () => {
  beforeEach(() => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", TEST_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a secret", () => {
    const payload = encryptSecret("ghp_supersecrettoken1234");
    expect(payload.startsWith("v1:")).toBe(true);
    expect(decryptSecret(payload)).toBe("ghp_supersecrettoken1234");
  });

  it("produces a different payload each time (random IV)", () => {
    const a = encryptSecret("same-plaintext");
    const b = encryptSecret("same-plaintext");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-plaintext");
    expect(decryptSecret(b)).toBe("same-plaintext");
  });

  it("throws when the ciphertext is tampered with", () => {
    const payload = encryptSecret("tamper-me");
    const parts = payload.split(":");
    const ciphertext = Buffer.from(parts[2], "base64");
    ciphertext[0] = ciphertext[0] ^ 0xff; // flip first byte
    parts[2] = ciphertext.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("throws on an unknown version prefix", () => {
    const payload = encryptSecret("hello");
    const tampered = payload.replace(/^v1:/, "v9:");
    expect(() => decryptSecret(tampered)).toThrow(/Unknown secret payload version/);
  });

  it("throws on a malformed payload", () => {
    expect(() => decryptSecret("not-a-valid-payload")).toThrow(/Malformed/);
  });

  it("throws a clear error when the key has the wrong length", () => {
    vi.stubEnv(
      "SECRETS_ENCRYPTION_KEY",
      Buffer.from("too-short").toString("base64"),
    );
    expect(() => encryptSecret("x")).toThrow(/exactly 32 bytes/);
  });

  it("throws a clear error when the key is missing", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/SECRETS_ENCRYPTION_KEY is not set/);
  });

  it("masks a secret without leaking it", () => {
    expect(maskSecret("ghp_supersecrettoken1234")).toEqual({
      set: true,
      last4: "1234",
    });
  });
});
