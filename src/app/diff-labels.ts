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
// intent. Unknown results use the mandatory-label selector's automatic fallback.

interface CommentFingerprint { readonly code: string; readonly comments: number }

/** Compare code bytes while discarding only lexically established comments.
 * Strings and templates are opaque; uncertain slash/raw-literal contexts decline
 * the doc classification and are handled by the deterministic fallback instead. */
function commentFingerprint(text: string, path: string): CommentFingerprint | null {
  const hashComments = /\.(?:py|rb)$/u.test(path);
  if (/\b(?:u8|u|U|L)?R"|\br#+"|\$@?"|@\$"/u.test(text) ||
      (hashComments && /\b(?:[fF][rR]?|[rR][fF])["']/u.test(text))) return null;
  const quotedEnd = (start: number): number | null => {
    const quote = text[start]!;
    const delimiter = hashComments && text.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
    let index = start + delimiter.length;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text.startsWith(delimiter, index)) return index + delimiter.length;
      index += 1;
    }
    return null;
  };
  const blockEnd = (start: number): number | null => {
    let index = start + 2;
    let depth = 1;
    while (index < text.length) {
      if (path.endsWith(".rs") && text.startsWith("/*", index)) { depth += 1; index += 2; }
      else if (text.startsWith("*/", index)) {
        depth -= 1; index += 2;
        if (depth === 0) return index;
      } else index += 1;
    }
    return null;
  };
  const lineEnd = (start: number): number => {
    let index = start;
    while (index < text.length && !/[\n\r\u2028\u2029]/u.test(text[index]!)) index += 1;
    return index;
  };
  const templateEnd = (start: number, nesting = 0): number | null => {
    if (nesting > 64) return null;
    let index = start + 1;
    if (path.endsWith(".go")) {
      const end = text.indexOf(String.fromCharCode(96), index);
      return end < 0 ? null : end + 1;
    }
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text.charCodeAt(index) === 96) return index + 1;
      if (!text.startsWith("\${", index)) { index += 1; continue; }
      index += 2;
      let depth = 1;
      while (index < text.length && depth > 0) {
        const character = text[index]!;
        if (character === "'" || character === '"') {
          const end = quotedEnd(index); if (end === null) return null; index = end;
        } else if (text.charCodeAt(index) === 96) {
          const end = templateEnd(index, nesting + 1); if (end === null) return null; index = end;
        } else if (text.startsWith("//", index)) index = lineEnd(index + 2);
        else if (text.startsWith("/*", index)) {
          const end = blockEnd(index); if (end === null) return null; index = end;
        } else if (character === "/") return null;
        else {
          if (character === "{") depth += 1;
          if (character === "}") depth -= 1;
          index += 1;
        }
      }
      if (depth !== 0) return null;
    }
    return null;
  };
  let index = 0;
  let code = "";
  let comments = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "'" || character === '"') {
      // C# verbatim literals use doubled quotes, which this lexer deliberately
      // does not interpret as ordinary JavaScript/C escaped strings.
      if (!hashComments && (text[index - 1] === "@" || text.startsWith(character.repeat(3), index))) return null;
      const end = quotedEnd(index); if (end === null) return null;
      code += text.slice(index, end); index = end;
    } else if (text.charCodeAt(index) === 96) {
      const end = templateEnd(index); if (end === null) return null;
      code += text.slice(index, end); index = end;
    } else if ((hashComments && character === "#") || (!hashComments && text.startsWith("//", index))) {
      const end = lineEnd(index);
      const comment = text.slice(index, end);
      // Compiler/build directives are not merely prose.
      code += /^(?:#!|#\s*(?:coding|type\s*:|frozen_string_literal)|\/\/\s*(?:@|#|<reference|<amd|go:|line\b|swift-tools-version:))/u.test(comment) || /\\$|\?\?\/$|coding\s*[:=]/u.test(comment) ? comment : "";
      comments += 1; index = end;
    } else if (!hashComments && text.startsWith("/*", index)) {
      const end = blockEnd(index); if (end === null) return null;
      const comment = text.slice(index, end);
      code += /^\/\*[!@#]|@ts-|__PURE__/u.test(comment) ? comment : " " + (comment.match(/\r\n|[\r\n\u2028\u2029]/gu) ?? []).join("");
      comments += 1; index = end;
    } else if (!hashComments && character === "/") {
      // Without a full language parser, regex literals and division have
      // ambiguous lexical contexts. Never remove apparent comments inside them.
      return null;
    } else { code += character; index += 1; }
  }
  return { code, comments };
}

function commentOnlyChange(item: DiffContentItem): boolean {
  if (item.status !== "modified" || typeof item.before !== "string" || typeof item.after !== "string" || item.before === item.after) return false;
  const before = commentFingerprint(item.before, item.newPath);
  const after = commentFingerprint(item.after, item.newPath);
  return before !== null && after !== null && before.comments + after.comments > 0 && before.code === after.code;
}

function sourceType(item: DiffContentItem): DiffTypeLabel | null {
  if (commentOnlyChange(item)) return "doc";
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

/** Report conclusive evidence; mandatory label selection handles unknowns automatically. */
export function typeLabelFromDiff(items: readonly DiffContentItem[]): `type::${DiffTypeLabel}` | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const types = items.map(itemType);
  if (types.some((type) => type === null)) return null;
  const primary = new Set(types.filter((type) => type !== "doc" && type !== "test"));
  if (primary.size > 1) return null;
  const selected = primary.size === 1 ? [...primary][0] : types.includes("test") ? "test" : "doc";
  return selected === null || selected === undefined ? null : `type::${selected}`;
}
