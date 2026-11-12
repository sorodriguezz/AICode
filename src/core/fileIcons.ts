// File icons: the glyph and color a file shows with in the explorer, tabs, quick open and chat.
// Built in: the Seti icons (an icon font plus VS Code's icon-theme JSON, MIT — see icons/LICENSE.md).
// With the setting `workbench.iconTheme` = "none", files show plain codicons instead.

import setiFont from "./icons/seti.woff?url";
import seti from "./icons/seti.json";
import { icon, fileIcon, fileIconColor } from "./ui";

interface IconDef {
  fontCharacter?: string;
  fontColor?: string;
}
interface IconTheme {
  iconDefinitions: Record<string, IconDef>;
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
  light?: { file?: string; fileExtensions?: Record<string, string>; fileNames?: Record<string, string>; languageIds?: Record<string, string> };
}

let enabled = true;
let light = false;
let languageOf: (name: string) => string = () => "plaintext";
let fontReady = false;
const cache = new Map<string, IconDef | null>();

function ensureFont() {
  if (fontReady) return;
  fontReady = true;
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: "aicode-seti"; src: url("${setiFont}") format("woff"); font-weight: normal; font-style: normal; font-display: block; }`;
  document.head.append(style);
}

export function configureFileIcons(opts: { enabled?: boolean; light?: boolean; languageOf?: (name: string) => string }) {
  if (opts.enabled !== undefined) enabled = opts.enabled;
  if (opts.light !== undefined) light = opts.light;
  if (opts.languageOf) languageOf = opts.languageOf;
  cache.clear();
}

export function fileIconsEnabled() {
  return enabled;
}

/** Resolves like VS Code: file name, then extensions (longest first), then language, then the default. */
function resolve(name: string): IconDef | null {
  const lower = name.toLowerCase();
  const key = `${light ? "l" : "d"}:${lower}`;
  if (cache.has(key)) return cache.get(key)!;
  const t = seti as unknown as IconTheme;
  const pick = (table: "fileNames" | "fileExtensions" | "languageIds", k: string) => (light ? t.light?.[table]?.[k] : undefined) ?? t[table]?.[k];
  let id = pick("fileNames", lower);
  if (!id) {
    const parts = lower.split(".");
    for (let i = 1; i < parts.length && !id; i++) id = pick("fileExtensions", parts.slice(i).join("."));
  }
  if (!id) {
    const lang = languageOf(name);
    if (lang && lang !== "plaintext") id = pick("languageIds", lang);
  }
  id ??= (light ? t.light?.file : undefined) ?? t.file;
  const def = (id && t.iconDefinitions[id]) || null;
  cache.set(key, def);
  return def;
}

/** An element showing the file's icon (a Seti glyph, or a codicon when icons are off). */
export function fileIconEl(name: string, extraClass = ""): HTMLElement {
  if (enabled) {
    const def = resolve(name);
    if (def?.fontCharacter) {
      ensureFont();
      const span = document.createElement("span");
      span.className = `ficon font-ficon${extraClass ? " " + extraClass : ""}`;
      span.textContent = String.fromCodePoint(parseInt(def.fontCharacter.replace(/^\\/, ""), 16));
      if (def.fontColor) span.style.color = def.fontColor;
      span.setAttribute("aria-hidden", "true");
      return span;
    }
  }
  const el = icon(fileIcon(name), `ficon${extraClass ? " " + extraClass : ""}`);
  const c = fileIconColor(name);
  if (c) el.style.color = c;
  return el;
}
