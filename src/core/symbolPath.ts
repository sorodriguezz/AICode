// Where the cursor is inside a structured file, for the breadcrumbs (VS Code's
// "overrides > dompurify@<3.4.17"). Light scanners per language, no language server needed.

export type SymbolKind = "object" | "array" | "value" | "heading";
export interface SymbolCrumb {
  name: string;
  kind: SymbolKind;
  /** 1-based line where the symbol starts, so clicking the crumb can jump there. */
  line: number;
}

const MAX_TEXT = 2_000_000;

export function symbolPath(languageId: string, text: string, line: number, column: number): SymbolCrumb[] {
  if (text.length > MAX_TEXT) return [];
  switch (languageId) {
    case "yaml":
      return yamlPath(text.split(/\r?\n/), line, column);
    case "json":
    case "jsonc":
      return jsonPath(text, offsetOf(text, line, column));
    case "markdown":
      return markdownPath(text.split(/\r?\n/), line);
    default:
      return [];
  }
}

function offsetOf(text: string, line: number, column: number) {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  return Math.min(off + column - 1, text.length);
}

// ---------- YAML: keys with less indentation, walking up from the cursor ----------

const YAML_KEY = /^(\s*)(?:-\s+)?(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"][^#]*?))\s*:(?:\s+(.*))?$/;

function yamlPath(lines: string[], line: number, column: number): SymbolCrumb[] {
  const out: SymbolCrumb[] = [];
  const isItemLine = (t: string) => /^-(\s|$)/.test(t);
  const itemIndex = (i: number, indent: number) => {
    let index = 0;
    for (let j = i - 1; j >= 0; j--) {
      const r = lines[j];
      const t = r.trim();
      if (!t || t.startsWith("#")) continue;
      const ind = r.length - r.trimStart().length;
      if (ind < indent || (ind === indent && !isItemLine(t))) break;
      if (ind === indent) index++;
    }
    return index;
  };
  // On a blank line the cursor's column says how deep it is: keys at that indent or deeper are siblings.
  let limit = (lines[line - 1] ?? "").trim() ? Infinity : column - 1;
  // After a list item, its parent key may sit at the same indent ("key:\n- a"); its siblings may not.
  let itemIndent = -1;
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === "---" || trimmed === "...") break;
    const indent = raw.length - raw.trimStart().length;
    const isItem = isItemLine(trimmed);
    if (indent > limit || (indent === limit && (itemIndent !== indent || isItem))) continue;
    const m = YAML_KEY.exec(raw);
    if (m) {
      const name = m[2] ?? m[3]?.replace(/''/g, "'") ?? m[4] ?? "";
      const value = (m[5] ?? "").replace(/\s+#.*$/, "").trim();
      const kind: SymbolKind = !value ? "object" : value.startsWith("[") ? "array" : value.startsWith("{") ? "object" : "value";
      // "- name: x" is the key itself only on the cursor's line; above it, the item just holds the cursor.
      if (!isItem || i === line - 1) out.unshift({ name, kind, line: i + 1 });
    }
    if (isItem) {
      out.unshift({ name: String(itemIndex(i, indent)), kind: "object", line: i + 1 });
      itemIndent = indent;
    } else itemIndent = -1;
    limit = indent;
    if (indent === 0 && !isItem) break;
  }
  return out;
}

// ---------- JSON / JSONC: a stack of objects and arrays up to the cursor ----------

interface Frame {
  type: "obj" | "arr";
  key: string | null;
  keyOffset: number;
  index: number;
  start: number;
  valueKind: SymbolKind;
}

function jsonPath(text: string, offset: number): SymbolCrumb[] {
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      let s = "";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          s += text[i + 1];
          i += 2;
        } else s += text[i++];
      }
      i++;
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      const top = stack[stack.length - 1];
      if (text[j] === ":" && top?.type === "obj") {
        top.key = s;
        top.keyOffset = start;
        top.valueKind = valueKindAt(text, j + 1);
        i = j + 1;
      }
      if (start >= offset) break;
      continue;
    }
    if (i >= offset) break;
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push({ type: ch === "{" ? "obj" : "arr", key: null, keyOffset: i, index: 0, start: i, valueKind: "value" });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.type === "arr") top.index++;
      else if (top) top.key = null;
    }
    i++;
  }
  const out: SymbolCrumb[] = [];
  const lineAt = (off: number) => {
    let l = 1;
    for (let k = text.indexOf("\n"); k >= 0 && k < off; k = text.indexOf("\n", k + 1)) l++;
    return l;
  };
  for (const f of stack) {
    if (f.type === "obj" && f.key !== null) out.push({ name: f.key, kind: f.valueKind, line: lineAt(f.keyOffset) });
    else if (f.type === "arr") out.push({ name: String(f.index), kind: "value", line: lineAt(f.start) });
  }
  // An array element is itself an object or array when the next frame opens it.
  for (let k = 0; k < out.length - 1; k++) if (stack[k].type === "arr") out[k].kind = stack[k + 1].type === "obj" ? "object" : "array";
  return out;
}

function valueKindAt(text: string, from: number): SymbolKind {
  let j = from;
  while (j < text.length && /\s/.test(text[j])) j++;
  return text[j] === "{" ? "object" : text[j] === "[" ? "array" : "value";
}

// ---------- Markdown: the headings above the cursor ----------

function markdownPath(lines: string[], line: number): SymbolCrumb[] {
  const stack: { level: number; crumb: SymbolCrumb }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const t = lines[i];
    const f = /^\s*(```|~~~)/.exec(t);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
    if (!m) continue;
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, crumb: { name: m[2], kind: "heading", line: i + 1 } });
  }
  return stack.map((s) => s.crumb);
}
