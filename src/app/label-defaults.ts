import type { GitLabLabel } from "../gitlab/types.ts";

export const DEFAULT_LABEL_POOL = Object.freeze([
  "type::feature", "type::bug", "type::doc", "type::test", "type::refactor",
  "type::performance", "type::build", "type::ci", "type::chore",
  "priority::p0", "priority::p1", "priority::p2",
  "status::doing", "status::review",
] as const);

/** Fixed-pool defaults for a new MR. Week/milestone labels are deliberately excluded. */
export function defaultLabelNames(
  labels: readonly (Pick<GitLabLabel, "name"> & { readonly category?: string })[],
): ReadonlySet<string> {
  const available = new Set(labels.map((label) => label.name));
  return new Set(available.has("priority::p2") ? ["priority::p2"] : []);
}
