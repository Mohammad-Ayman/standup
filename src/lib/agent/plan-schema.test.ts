import { describe, expect, it } from "vitest";

import { PLAN_JSON_SCHEMA, PlanZ, renderPlanMarkdown, type Plan } from "./plan-schema";

const fixture: Plan = {
  summary: "Fix the off-by-one error in the pagination helper.",
  root_cause_hypothesis:
    "The page offset is computed with `page * size` instead of `(page - 1) * size`.",
  approach: "Correct the offset math and add a regression test.",
  tasks: [
    {
      title: "Fix offset computation",
      description: "Change the offset formula in the pagination helper.",
      target_files: ["src/lib/pagination.ts"],
    },
    {
      title: "Add regression test",
      description: "Cover page 1 and page 2 boundaries.",
      target_files: ["src/lib/pagination.test.ts"],
    },
  ],
  files_to_touch: ["src/lib/pagination.ts", "src/lib/pagination.test.ts"],
  risks_unknowns: ["Callers may already compensate for the off-by-one."],
  questions_for_human: ["Should page numbers stay 1-based in the public API?"],
  complexity: "M",
  test_strategy: "Unit tests for both boundaries; run the full vitest suite.",
};

describe("PlanZ", () => {
  it("accepts a full valid plan", () => {
    const parsed = PlanZ.parse(fixture);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.complexity).toBe("M");
  });

  it("rejects a bad complexity value", () => {
    const result = PlanZ.safeParse({ ...fixture, complexity: "XL" });
    expect(result.success).toBe(false);
  });

  it("rejects a plan missing required fields", () => {
    const withoutSummary: Record<string, unknown> = { ...fixture };
    delete withoutSummary.summary;
    const result = PlanZ.safeParse(withoutSummary);
    expect(result.success).toBe(false);
  });
});

describe("PLAN_JSON_SCHEMA", () => {
  it("mirrors PlanZ: object, closed, all fields required", () => {
    expect(PLAN_JSON_SCHEMA.type).toBe("object");
    expect(PLAN_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...PLAN_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(PLAN_JSON_SCHEMA.properties).sort(),
    );
    expect(PLAN_JSON_SCHEMA.properties.complexity.enum).toEqual(["S", "M", "L"]);
  });
});

describe("renderPlanMarkdown", () => {
  it("renders the expected headings and badge", () => {
    const md = renderPlanMarkdown(fixture);
    expect(md).toContain("**Complexity:** M");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Root cause hypothesis");
    expect(md).toContain("## Approach");
    expect(md).toContain("## Tasks");
    expect(md).toContain("1. **Fix offset computation**");
    expect(md).toContain("   - files:");
    expect(md).toContain("     - `src/lib/pagination.ts`");
    expect(md).toContain("## Files to touch");
    expect(md).toContain("## Risks & unknowns");
    expect(md).toContain("## Questions for you");
    expect(md).toContain("## Test strategy");
  });

  it("omits the questions section when empty", () => {
    const md = renderPlanMarkdown({ ...fixture, questions_for_human: [] });
    expect(md).not.toContain("## Questions for you");
  });

  it("is deterministic (stable output for the same input)", () => {
    expect(renderPlanMarkdown(fixture)).toBe(renderPlanMarkdown(fixture));
  });
});
