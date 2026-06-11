import { describe, expect, it } from "vitest";

import { computeContentHash } from "./issues-sync";

const base = {
  title: "Crash on startup",
  body: "Steps to reproduce…",
  labels: ["bug", "p1"],
  commentIds: [101, 5, 42],
};

describe("computeContentHash", () => {
  it("is deterministic for identical input", () => {
    const a = computeContentHash({ ...base });
    const b = computeContentHash({ ...base });
    expect(a).toBe(b);
  });

  it("returns a 64-char lowercase hex sha256", () => {
    const hash = computeContentHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to label order", () => {
    const a = computeContentHash({ ...base, labels: ["bug", "p1"] });
    const b = computeContentHash({ ...base, labels: ["p1", "bug"] });
    expect(a).toBe(b);
  });

  it("is insensitive to commentId order (numeric sort, not lexicographic)", () => {
    const a = computeContentHash({ ...base, commentIds: [2, 10, 100] });
    const b = computeContentHash({ ...base, commentIds: [100, 2, 10] });
    expect(a).toBe(b);
  });

  it("treats body null as empty string", () => {
    const a = computeContentHash({ ...base, body: null });
    const b = computeContentHash({ ...base, body: "" });
    expect(a).toBe(b);
  });

  it("does not mutate the input arrays", () => {
    const labels = ["p1", "bug"];
    const commentIds = [100, 2, 10];
    computeContentHash({ ...base, labels, commentIds });
    expect(labels).toEqual(["p1", "bug"]);
    expect(commentIds).toEqual([100, 2, 10]);
  });

  it("changes when title changes", () => {
    const a = computeContentHash(base);
    const b = computeContentHash({ ...base, title: "Crash on shutdown" });
    expect(a).not.toBe(b);
  });

  it("changes when body changes", () => {
    const a = computeContentHash(base);
    const b = computeContentHash({ ...base, body: "Different body" });
    expect(a).not.toBe(b);
  });

  it("changes when labels change", () => {
    const a = computeContentHash(base);
    const b = computeContentHash({ ...base, labels: ["bug"] });
    expect(a).not.toBe(b);
  });

  it("changes when commentIds change", () => {
    const a = computeContentHash(base);
    const b = computeContentHash({ ...base, commentIds: [101, 5] });
    expect(a).not.toBe(b);
  });

  it("distinguishes empty labels from empty commentIds permutations", () => {
    const a = computeContentHash({ ...base, labels: [], commentIds: [1] });
    const b = computeContentHash({ ...base, labels: ["1"], commentIds: [] });
    expect(a).not.toBe(b);
  });

  it("changes when commentsCount changes even if commentIds are stable (30+ comments case)", () => {
    const a = computeContentHash({ ...base, commentsCount: 30 });
    const b = computeContentHash({ ...base, commentsCount: 31 });
    expect(a).not.toBe(b);
  });

  it("is stable for the same commentsCount", () => {
    const a = computeContentHash({ ...base, commentsCount: 30 });
    const b = computeContentHash({ ...base, commentsCount: 30 });
    expect(a).toBe(b);
  });

  it("omitting commentsCount preserves the legacy hash", () => {
    const a = computeContentHash({ ...base });
    const b = computeContentHash({ ...base, commentsCount: undefined });
    expect(a).toBe(b);
  });
});
