// A tiny DOM helper shared by the core and handed to mods as `ctx.ui`, so a mod can build its view
// without bringing a framework (it still may: a view is just an element).

export type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = String(value);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key === "dataset" && typeof value === "object") Object.assign(el.dataset, value);
      else if (value === true) el.setAttribute(key, "");
      else if (key in el && typeof value !== "string") (el as any)[key] = value;
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** A codicon. "sync~spin", as VS Code's $(sync~spin), turns (status bar and title bar items take it too). */
export function icon(name: string, extra = ""): HTMLElement {
  const i = document.createElement("i");
  const [base, mod] = name.split("~");
  if (mod === "spin") extra = extra ? `${extra} codicon-modifier-spin` : "codicon-modifier-spin";
  i.className = `codicon codicon-${base}${extra ? " " + extra : ""}`;
  return i;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  return h("button", { class: "icon-button", title, "aria-label": title, onclick: onClick }, icon(name));
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? (i === 0 ? "/" : "") : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function tildify(path: string, home: string): string {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** A file-type icon from the name — codicons only, so it matches the rest of the UI. */
export function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "package.json" || lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (/\.(md|markdown|mdx)$/.test(lower)) return "markdown";
  if (/\.(png|jpe?g|gif|svg|webp|ico|bmp)$/.test(lower)) return "file-media";
  if (/\.(zip|tar|gz|tgz|rar|7z)$/.test(lower)) return "file-zip";
  if (/\.(pdf)$/.test(lower)) return "file-pdf";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|cpp|h|cs|rb|php|swift|kt|scala|lua|sh|zsh|sql|vue|svelte|css|scss|html|xml|yaml|yml|toml)$/.test(lower)) return "file-code";
  if (lower.startsWith(".env") || lower.endsWith(".ini") || lower.endsWith(".conf") || lower.endsWith(".cfg") || lower.startsWith(".")) return "gear";
  return "file";
}

/** A color for a file's icon, by kind (like the familiar per-language icon colors). */
export function fileIconColor(name: string): string | undefined {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (lower === "dockerfile" || lower.startsWith("docker-compose")) return "#519aba";
  if (lower.startsWith(".git") || lower === ".ds_store") return "#6d8086";
  if (lower.startsWith(".env")) return "#cbcb41";
  if (/(^|\.)lock$|-lock\.(json|yaml)$/.test(lower)) return "#6d8086";
  const byExt: Record<string, string> = {
    ts: "#519aba", tsx: "#519aba", mts: "#519aba", cts: "#519aba",
    js: "#cbcb41", jsx: "#cbcb41", mjs: "#cbcb41", cjs: "#cbcb41",
    json: "#cbcb41", jsonc: "#cbcb41",
    md: "#519aba", mdx: "#519aba", markdown: "#519aba",
    html: "#e37933", htm: "#e37933", xml: "#e37933", vue: "#8dc149", svelte: "#e37933",
    css: "#519aba", scss: "#f55385", sass: "#f55385", less: "#519aba",
    py: "#519aba", rb: "#cc3e44", go: "#519aba", rs: "#e37933", java: "#cc3e44", kt: "#a074c4", swift: "#e37933",
    c: "#519aba", h: "#a074c4", cpp: "#519aba", hpp: "#a074c4", cs: "#519aba", php: "#a074c4", lua: "#519aba",
    sh: "#8dc149", zsh: "#8dc149", bash: "#8dc149", fish: "#8dc149", ps1: "#519aba",
    yaml: "#a074c4", yml: "#a074c4", toml: "#6d8086", ini: "#6d8086", conf: "#6d8086", cfg: "#6d8086",
    sql: "#f55385", graphql: "#f55385", txt: "#6d8086", log: "#6d8086", csv: "#8dc149",
    png: "#a074c4", jpg: "#a074c4", jpeg: "#a074c4", gif: "#a074c4", svg: "#e37933", webp: "#a074c4", ico: "#cbcb41",
    zip: "#6d8086", gz: "#6d8086", pdf: "#cc3e44", wasm: "#a074c4",
  };
  return byExt[ext];
}

export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return { dispose: () => { if (!done) { done = true; fn(); } } };
}
