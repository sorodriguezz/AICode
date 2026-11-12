// File icon themes: the icon a file (or folder) shows with in the explorer, tabs, quick open, chat,
// search and source control. The core has no icon set of its own: mods contribute VS Code
// file-icon-theme JSON files (`contributes.iconThemes`, see docs/MODS.md) and the setting
// `workbench.iconTheme` picks one. With none (or "none"), files show plain codicons.
//
// Both kinds of VS Code icon theme work: font glyphs (`fonts` + `fontCharacter`/`fontColor`, like
// Seti) and pictures (`iconPath`, like vscode-icons), with `file`, `folder`, `folderExpanded`,
// `fileExtensions`, `fileNames`, `folderNames`, `folderNamesExpanded`, `languageIds` and their
// `light` overrides. AICode also reads `fileNamePatterns` / `folderNamePatterns` (`*` globs, in
// order, after exact names and before extensions) — what CodeFlow's packs need for `*Controller.java`.
//
// The explorer asks once per row, so everything is cached: a name is resolved once per theme and
// light/dark, and each icon becomes one CSS class (its picture is fetched once, by that rule).

import { icon, fileIcon, fileIconColor, type Disposable } from "./ui";

interface IconDef {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontId?: string;
  fontSize?: string;
}
type Table = Record<string, string>;
interface Tables {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Table;
  fileNames?: Table;
  folderNames?: Table;
  folderNamesExpanded?: Table;
  languageIds?: Table;
  fileNamePatterns?: Table;
  folderNamePatterns?: Table;
}
interface IconThemeJson extends Tables {
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  iconDefinitions?: Record<string, IconDef>;
  light?: Tables;
  hidesExplorerArrows?: boolean;
}

/** An icon theme a mod contributes. `url` is the theme file's; its relative paths resolve from it. */
export interface IconThemeEntry {
  id: string;
  label: string;
  /** The contributing mod's name and id. */
  source: string;
  mod: string;
  url: string;
  load: () => Promise<unknown>;
}

/** One side (dark or light) of a loaded theme, with its tables lowercased and patterns compiled. */
interface Side {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions: Map<string, string>;
  fileNames: Map<string, string>;
  folderNames: Map<string, string>;
  folderNamesExpanded: Map<string, string>;
  languageIds: Map<string, string>;
  filePatterns: Patterns;
  folderPatterns: Patterns;
}
interface Loaded {
  entry: IconThemeEntry;
  dark: Side;
  light: Side;
  defs: Record<string, IconDef>;
  /** Font id → CSS font-family. */
  fonts: Map<string, string>;
  /** Definition id → the CSS class drawing it (made the first time it is shown). */
  classes: Map<string, string>;
  hasFolders: boolean;
}

const registry: IconThemeEntry[] = [];
const loadedThemes = new Map<string, Promise<Loaded>>();
/** What files are drawn with: the chosen theme, or the one a mod draws it with (`drawIconThemeWith`). */
let current: Loaded | null = null;
/** The theme `workbench.iconTheme` chose. */
let selected: IconThemeEntry | null = null;
/** In this window, theme → the theme that draws it (the Auto pack → the pack the folder calls for). */
const drawnWith = new Map<IconThemeEntry, string>();
let light = false;
let languageOf: (name: string) => string = () => "plaintext";
/** `<l|d><f|d|o>:<name>` → the definition id it resolved to (null: none). */
const cache = new Map<string, string | null>();
let sheet: HTMLStyleElement | null = null;
let nextClass = 1;

/** Called by the mod host for each `contributes.iconThemes` entry; undone when the mod goes. */
export function registerIconTheme(entry: IconThemeEntry): Disposable {
  registry.push(entry);
  return {
    dispose: () => {
      const i = registry.indexOf(entry);
      if (i >= 0) registry.splice(i, 1);
    },
  };
}

/** Every icon theme the enabled mods contribute, in load order. */
export function iconThemes(): readonly IconThemeEntry[] {
  return registry;
}

/** The id of the chosen theme, or null (plain codicons). */
export function currentIconTheme(): string | null {
  return current ? selected?.id ?? null : null;
}

/** The id of the theme files are actually drawn with (differs from the chosen one when a mod redirects it). */
export function drawnIconTheme(): string | null {
  return current?.entry.id ?? null;
}

/** A theme by its id (`seti`), or by `<mod id>/<id>`. */
export function findIconTheme(id: string | null | undefined): IconThemeEntry | undefined {
  if (!id || id === "none") return undefined;
  return registry.find((t) => t.id === id) ?? registry.find((t) => `${t.mod}/${t.id}` === id);
}

/**
 * Draws files with this theme from now on ("none", or an id nothing contributes: codicons).
 * Resolves once the theme file is read, so callers repaint after it.
 */
export async function setIconTheme(id: string | null | undefined): Promise<void> {
  selected = findIconTheme(id) ?? null;
  const entry = selected ? findIconTheme(drawnWith.get(selected)) ?? selected : undefined;
  if (!entry) {
    current = null;
    cache.clear();
    return;
  }
  if (current?.entry === entry) return;
  try {
    const loaded = await loadTheme(entry);
    current = loaded;
  } catch (e) {
    console.warn(`file icon theme ${entry.id} (${entry.mod}):`, e);
    current = null;
  }
  cache.clear();
}

/**
 * In this window, draws the theme `themeId` with the theme `targetId` (null: with itself again).
 * The choice stays `themeId` — its picker entry, the setting — only the drawing changes. A mod with
 * a theme that adapts (the Auto pack, by the open folder) calls this. True when files must repaint.
 */
export async function drawIconThemeWith(themeId: string, targetId: string | null): Promise<boolean> {
  const theme = findIconTheme(themeId);
  if (!theme) return false;
  const target = targetId ? findIconTheme(targetId) : undefined;
  if (target && target !== theme) drawnWith.set(theme, target.id);
  else drawnWith.delete(theme);
  if (selected !== theme) return false;
  const before = current;
  await setIconTheme(theme.id);
  return current !== before;
}

export function configureFileIcons(opts: { light?: boolean; languageOf?: (name: string) => string }) {
  if (opts.light !== undefined) light = opts.light;
  if (opts.languageOf) languageOf = opts.languageOf;
  cache.clear();
}

export function fileIconsEnabled() {
  return !!current;
}

function loadTheme(entry: IconThemeEntry): Promise<Loaded> {
  const key = `${entry.mod}\n${entry.url}`;
  let p = loadedThemes.get(key);
  if (!p) {
    p = entry.load().then((raw) => compile(entry, raw as IconThemeJson));
    p.catch(() => loadedThemes.delete(key));
    loadedThemes.set(key, p);
  }
  return p;
}

const lowerMap = (t: Table | undefined) => new Map(Object.entries(t ?? {}).map(([k, v]) => [k.toLowerCase(), v] as [string, string]));
/** `*` globs, in order. Each keeps its text, so a `light` entry can replace the dark one in place. */
type Patterns = [glob: string, re: RegExp, id: string][];
const globs = (t: Table | undefined, under: Patterns = []): Patterns => {
  const own = Object.entries(t ?? {});
  const fresh: Patterns = own
    .filter(([k]) => !under.some(([g]) => g === k))
    .map(([k, v]) => [k, new RegExp(`^${k.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"), v]);
  const byKey = new Map(own);
  return [...fresh, ...under.map(([g, re, id]) => [g, re, byKey.get(g) ?? id] as Patterns[number])];
};

function side(t: Tables, base?: Side): Side {
  // `light` overrides a table entry by entry; what it does not name stays the dark one.
  const merge = <K, V>(own: Map<K, V>, under?: Map<K, V>) => (under ? new Map([...under, ...own]) : own);
  return {
    file: t.file ?? base?.file,
    folder: t.folder ?? base?.folder,
    folderExpanded: t.folderExpanded ?? base?.folderExpanded,
    fileExtensions: merge(lowerMap(t.fileExtensions), base?.fileExtensions),
    fileNames: merge(lowerMap(t.fileNames), base?.fileNames),
    folderNames: merge(lowerMap(t.folderNames), base?.folderNames),
    folderNamesExpanded: merge(lowerMap(t.folderNamesExpanded), base?.folderNamesExpanded),
    languageIds: merge(new Map(Object.entries(t.languageIds ?? {})), base?.languageIds),
    // A light pattern replaces the dark one with the same text where it stands; a new one goes first.
    filePatterns: globs(t.fileNamePatterns, base?.filePatterns),
    folderPatterns: globs(t.folderNamePatterns, base?.folderPatterns),
  };
}

function compile(entry: IconThemeEntry, raw: IconThemeJson): Loaded {
  if (!raw || typeof raw !== "object" || !raw.iconDefinitions) throw new Error("not a file icon theme (no iconDefinitions)");
  const resolve = (rel: string) => new URL(rel, entry.url).href;
  const defs: Record<string, IconDef> = {};
  for (const [id, d] of Object.entries(raw.iconDefinitions)) defs[id] = d.iconPath ? { ...d, iconPath: resolve(d.iconPath) } : d;
  const dark = side(raw);
  const lightSide = raw.light ? side(raw.light, dark) : dark;
  const fonts = new Map<string, string>();
  const faces: string[] = [];
  for (const f of raw.fonts ?? []) {
    const family = `aicode-icons-${entry.mod.replace(/[^a-z0-9]/gi, "-")}-${entry.id.replace(/[^a-z0-9]/gi, "-")}-${String(f.id).replace(/[^a-z0-9]/gi, "-")}`;
    fonts.set(f.id, family);
    const src = (f.src ?? []).map((s) => `url("${resolve(s.path)}")${s.format ? ` format("${s.format}")` : ""}`).join(", ");
    if (src) faces.push(`@font-face { font-family: "${family}"; src: ${src}; font-weight: ${f.weight ?? "normal"}; font-style: ${f.style ?? "normal"}; font-display: block; }`);
  }
  if (faces.length) style().append(document.createTextNode(faces.join("\n") + "\n"));
  const hasFolders = !!(dark.folder || dark.folderNames.size || dark.folderPatterns.length);
  return { entry, dark, light: lightSide, defs, fonts, classes: new Map(), hasFolders };
}

function style(): HTMLStyleElement {
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.dataset.owner = "file-icons";
    document.head.append(sheet);
  }
  return sheet;
}

/** The CSS class that draws a definition: one rule per icon, so its file is fetched once. */
function classFor(t: Loaded, id: string, def: IconDef): string {
  let cls = t.classes.get(id);
  if (cls) return cls;
  cls = `fi-${nextClass++}`;
  t.classes.set(id, cls);
  if (def.iconPath) style().append(document.createTextNode(`.${cls} { background-image: url("${def.iconPath}"); }\n`));
  else {
    const family = (def.fontId && t.fonts.get(def.fontId)) || t.fonts.values().next().value;
    const rules = [family ? `font-family: "${family}";` : "", def.fontSize ? `font-size: ${def.fontSize};` : ""].join(" ");
    style().append(document.createTextNode(`.${cls} { ${rules} }\n`));
  }
  return cls;
}

/** Resolves like VS Code: file name, then extensions (longest first), then language, then the default. */
function resolveFile(t: Loaded, name: string): string | undefined {
  const s = light ? t.light : t.dark;
  const lower = name.toLowerCase();
  let id = s.fileNames.get(lower);
  if (!id) for (const [, re, v] of s.filePatterns) if (re.test(lower)) { id = v; break; }
  if (!id) {
    const parts = lower.split(".");
    for (let i = 1; i < parts.length && !id; i++) id = s.fileExtensions.get(parts.slice(i).join("."));
  }
  if (!id && s.languageIds.size) {
    const lang = languageOf(name);
    if (lang && lang !== "plaintext") id = s.languageIds.get(lang);
  }
  return id ?? s.file;
}

function resolveFolder(t: Loaded, name: string, expanded: boolean): string | undefined {
  const s = light ? t.light : t.dark;
  const lower = name.toLowerCase();
  let id = expanded ? s.folderNamesExpanded.get(lower) ?? s.folderNames.get(lower) : s.folderNames.get(lower);
  if (!id) for (const [, re, v] of s.folderPatterns) if (re.test(lower)) { id = v; break; }
  // A pattern names the closed folder; its open twin is the one the theme calls `<id>-opened`/`_open`.
  if (id && expanded && !s.folderNamesExpanded.has(lower)) id = t.defs[`${id}-opened`] ? `${id}-opened` : t.defs[`${id}_open`] ? `${id}_open` : id;
  return id ?? (expanded ? s.folderExpanded ?? s.folder : s.folder);
}

function lookup(kind: "f" | "d" | "o", name: string): { cls: string; def: IconDef } | null {
  const t = current;
  if (!t) return null;
  const key = `${light ? "l" : "d"}${kind}:${name.toLowerCase()}`;
  let id = cache.get(key);
  if (id === undefined) {
    const found = kind === "f" ? resolveFile(t, name) : resolveFolder(t, name, kind === "o");
    id = found && t.defs[found] ? found : null;
    if (cache.size > 5000) cache.clear();
    cache.set(key, id);
  }
  const def = id ? t.defs[id] : undefined;
  if (!id || !def || (!def.iconPath && !def.fontCharacter)) return null;
  return { cls: classFor(t, id, def), def };
}

function draw(found: { cls: string; def: IconDef }, extraClass: string): HTMLElement {
  const span = document.createElement("span");
  span.setAttribute("aria-hidden", "true");
  if (found.def.iconPath) {
    span.className = `ficon svg-ficon ${found.cls}${extraClass ? " " + extraClass : ""}`;
  } else {
    span.className = `ficon font-ficon ${found.cls}${extraClass ? " " + extraClass : ""}`;
    // `"\\E001"` (Seti) is a code point in hex; anything else is the character itself.
    const ch = found.def.fontCharacter!;
    span.textContent = /^\\?[0-9a-f]{2,6}$/i.test(ch) ? String.fromCodePoint(parseInt(ch.replace(/^\\/, ""), 16)) : ch;
    if (found.def.fontColor) span.style.color = found.def.fontColor;
  }
  return span;
}

/** An element showing the file's icon (the icon theme's, or a codicon when there is none). */
export function fileIconEl(name: string, extraClass = ""): HTMLElement {
  const found = lookup("f", name);
  if (found) return draw(found, extraClass);
  const el = icon(fileIcon(name), `ficon${extraClass ? " " + extraClass : ""}`);
  const c = fileIconColor(name);
  if (c) el.style.color = c;
  return el;
}

/**
 * A folder's icon, or null when the theme draws no folders (Seti, or no theme) — then the explorer
 * shows only its arrows, as VS Code does.
 */
export function folderIconEl(name: string, expanded = false, extraClass = ""): HTMLElement | null {
  if (!current?.hasFolders) return null;
  const found = lookup(expanded ? "o" : "d", name);
  return found ? draw(found, extraClass) : null;
}
