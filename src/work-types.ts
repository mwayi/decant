export const WORK_TYPES = [
  "planning",
  "research",
  "design",
  "prototype",
  "feature",
  "debugging",
  "refactor",
  "testing",
  "evaluation",
  "optimisation",
  "data",
  "training",
  "review",
  "ops",
  "documentation",
] as const;

export type WorkType = (typeof WORK_TYPES)[number] | "mixed";

export function workTypeLabel(value: string): string {
  if (value === "(unclassified)") return "Unclassified";
  if (value === "ops") return "Operations";
  if (value === "debugging") return "Bug fixes";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
