/**
 * Plan schema contract — the shape of an issue-solving plan produced by the
 * planner agent, validated at every boundary with zod.
 *
 * PLAN_JSON_SCHEMA is a hand-written plain JSON Schema mirror of PlanZ for
 * Agent SDK structured-output compatibility (basic types/enum only — no
 * minLength etc.).
 *
 * Framework-agnostic: no next/react imports allowed here.
 */
import { z } from "zod";

export const PlanZ = z.object({
  summary: z.string(),
  root_cause_hypothesis: z.string(),
  approach: z.string(),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      target_files: z.array(z.string()),
    }),
  ),
  files_to_touch: z.array(z.string()),
  risks_unknowns: z.array(z.string()),
  questions_for_human: z.array(z.string()),
  complexity: z.enum(["S", "M", "L"]),
  test_strategy: z.string(),
});

export type Plan = z.infer<typeof PlanZ>;

/** Plain JSON Schema mirror of PlanZ for structured-output prompting. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "root_cause_hypothesis",
    "approach",
    "tasks",
    "files_to_touch",
    "risks_unknowns",
    "questions_for_human",
    "complexity",
    "test_strategy",
  ],
  properties: {
    summary: {
      type: "string",
      description: "One-paragraph summary of the issue and the proposed fix.",
    },
    root_cause_hypothesis: {
      type: "string",
      description: "Most likely root cause of the issue, based on the code read.",
    },
    approach: {
      type: "string",
      description: "High-level approach for solving the issue.",
    },
    tasks: {
      type: "array",
      description: "Ordered, concrete implementation tasks.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "target_files"],
        properties: {
          title: {
            type: "string",
            description: "Short imperative title of the task.",
          },
          description: {
            type: "string",
            description: "What to do and why, in enough detail to execute.",
          },
          target_files: {
            type: "array",
            description: "Repo-relative file paths this task touches.",
            items: { type: "string" },
          },
        },
      },
    },
    files_to_touch: {
      type: "array",
      description: "All repo-relative file paths expected to change overall.",
      items: { type: "string" },
    },
    risks_unknowns: {
      type: "array",
      description: "Risks, unknowns, and assumptions that could derail the plan.",
      items: { type: "string" },
    },
    questions_for_human: {
      type: "array",
      description:
        "Questions that need a human answer before or during execution. Empty when none.",
      items: { type: "string" },
    },
    complexity: {
      type: "string",
      enum: ["S", "M", "L"],
      description: "Estimated implementation complexity: S (small), M (medium), L (large).",
    },
    test_strategy: {
      type: "string",
      description: "How the change will be verified (tests to add/run, manual checks).",
    },
  },
} as const;

/**
 * Deterministic canonical markdown rendering of a Plan.
 * Stable across calls for the same input — used for plan_versions.content_md.
 */
export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`**Complexity:** ${plan.complexity}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(plan.summary);
  lines.push("");

  lines.push("## Root cause hypothesis");
  lines.push(plan.root_cause_hypothesis);
  lines.push("");

  lines.push("## Approach");
  lines.push(plan.approach);
  lines.push("");

  lines.push("## Tasks");
  plan.tasks.forEach((task, i) => {
    lines.push(`${i + 1}. **${task.title}** — ${task.description}`);
    if (task.target_files.length > 0) {
      lines.push("   - files:");
      for (const file of task.target_files) {
        lines.push(`     - \`${file}\``);
      }
    }
  });
  lines.push("");

  lines.push("## Files to touch");
  for (const file of plan.files_to_touch) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");

  lines.push("## Risks & unknowns");
  for (const risk of plan.risks_unknowns) {
    lines.push(`- ${risk}`);
  }
  lines.push("");

  if (plan.questions_for_human.length > 0) {
    lines.push("## Questions for you");
    for (const question of plan.questions_for_human) {
      lines.push(`- ${question}`);
    }
    lines.push("");
  }

  lines.push("## Test strategy");
  lines.push(plan.test_strategy);
  lines.push("");

  return lines.join("\n");
}
