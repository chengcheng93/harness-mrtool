import type { DiffEvidenceItem } from "../bundle/detect-profile.ts";

export type DiffTypeLabel = "feature" | "bug" | "doc" | "test" | "refactor" |
  "performance" | "build" | "ci" | "chore";
export type DiffContentItem = DiffEvidenceItem & { readonly before?: string; readonly after?: string };

type Surface = "doc" | "test" | "build" | "ci" | "chore" | "source" | "unknown";

function surface(path: string): Surface {
  if (/^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml)$/u.test(path)) return "ci";
  if (/\.(?:md|mdx|rst|adoc)$/iu.test(path)) return "doc";
  if (/\.(?:[cm]?[jt]sx?|py|rs|go|java)$/u.test(path) &&
      (/(?:^|\/)(?:test|tests|__tests__)\//u.test(path) || /\.(?:test|spec)\.[^.]+$/u.test(path))) return "test";
  if (/(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(?:toml|lock)|Dockerfile|Makefile|\.npmrc|\.nvmrc)$/u.test(path)) return "build";
  if (/(?:^|\/)(?:\.gitignore|\.editorconfig|\.gitattributes|LICENSE(?:\.[^/]+)?|NOTICE)$/u.test(path)) return "chore";
  if (/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|cs|swift|rb)$/u.test(path)) return "source";
  return "unknown";
}

// These are bounded, explainable heuristics, not a claim to infer arbitrary program
// intent. Unknown source changes require an explicit diff-bound confirmation.
function sourceType(item: DiffContentItem): DiffTypeLabel | null {
  const { before, after } = item;
  if (item.status === "renamed" && before !== undefined && before.length > 0 && before === after) return "refactor";
  if (after === undefined || after.trim() === "") return null;
  const addedCode = item.status === "added" ? after
    : before !== undefined && before.length > 0 && after.startsWith(before) ? after.slice(before.length) : "";
  const declaration = /^export\s+(?:async\s+)?(?:function\s+[A-Za-z_$][\w$]*\s*\(|class\s+[A-Za-z_$][\w$]*\s*[{])/mu.exec(addedCode);
  if (declaration !== null) {
    // Without parsing, comments/strings before a candidate declaration leave its
    // lexical context uncertain. Include the old prefix for append-only changes;
    // quotes inside a genuine function/class body need not prevent classification.
    const prefix = after.slice(0, after.length - addedCode.length + declaration.index);
    if (!/["'`]|\/\*|\/\//u.test(prefix)) return "feature";
  }
  if (item.status !== "modified" || before === undefined || before === after) return null;
  // Recognize a single if-condition comparison correction only when all remaining
  // bytes are unchanged. Exclude strings/comments so examples cannot classify code.
  const condition = /\bif\s*\(\s*[A-Za-z_$][\w$.]*\s*(===|!==|==|!=|>=|<=|>|<)\s*(?:[A-Za-z_$][\w$.]*|\d+)\s*\)/u;
  if (!/["'`]|\/\*|\/\//u.test(before + after)) {
    const oldCondition = condition.exec(before);
    const newCondition = condition.exec(after);
    if (oldCondition !== null && newCondition !== null && oldCondition[1] !== newCondition[1] &&
        before.replace(condition, (value) => value.replace(oldCondition[1]!, "<comparison>")) ===
        after.replace(condition, (value) => value.replace(newCondition[1]!, "<comparison>"))) return "bug";
  }
  // Exact membership-scan -> one precomputed Set rewrite; a file named cache/perf
  // alone is never evidence. Extra behavior changes make this rule inapplicable.
  const compactBefore = before.replace(/\s+/gu, " ").trim();
  const scan = /^export function (\w+)\((\w+), (\w+)\) \{ return \2\.filter\((\w+) => \3\.includes\(\4\.(\w+)\)\); \}$/u.exec(compactBefore);
  const compactAfter = after.replace(/\s+/gu, " ").trim();
  if (scan !== null) {
    const [, fn, items, ids, itemName, field] = scan;
    const lookup = /\bconst (\w+) = new Set\(/u.exec(compactAfter)?.[1];
    if (lookup !== undefined && ![fn, items, ids, itemName].includes(lookup) && compactAfter ===
      `export function ${fn}(${items}, ${ids}) { const ${lookup} = new Set(${ids}); return ${items}.filter(${itemName} => ${lookup}.has(${itemName}.${field})); }`) return "performance";
  }
  return null;
}

function itemType(item: DiffContentItem): DiffTypeLabel | null {
  if (item === null || typeof item !== "object" || item.binary !== false || item.submodule !== false || item.unsupported === true ||
      !["added", "modified", "deleted", "renamed"].includes(item.status)) return null;
  const path = item.status === "deleted" ? item.oldPath : item.newPath;
  if (typeof path !== "string" || path === "" || /[\r\n\u0000]/u.test(path)) return null;
  const kind = surface(path);
  if (item.status === "renamed" && (typeof item.oldPath !== "string" || surface(item.oldPath) !== kind)) return null;
  if (kind === "unknown") return null;
  return kind === "source" ? sourceType(item) : kind;
}

/** Support docs/tests do not outweigh the unique main change; unknowns never become chore. */
export function typeLabelFromDiff(items: readonly DiffContentItem[]): `type::${DiffTypeLabel}` | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const types = items.map(itemType);
  if (types.some((type) => type === null)) return null;
  const primary = new Set(types.filter((type) => type !== "doc" && type !== "test"));
  if (primary.size > 1) return null;
  const selected = primary.size === 1 ? [...primary][0] : types.includes("test") ? "test" : "doc";
  return selected === null || selected === undefined ? null : `type::${selected}`;
}
