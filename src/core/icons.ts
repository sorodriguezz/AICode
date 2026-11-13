// Icons mods change or add. Every icon in the window is a codicon (`<i class="codicon codicon-NAME">`:
// the activity bar, the status bar, tab bars, menus, Monaco's widgets). A mod can draw any of them
// differently, or add new names that work wherever an icon name does (a view's icon, a status item,
// a title action): an SVG (tinted with the text color, or in its own colors), a picture, a font
// glyph, or another codicon.
//
//   ctx.icons.set("files", "<svg …>…</svg>")                 the Explorer's icon, everywhere
//   ctx.icons.set("docker", { path: "icons/docker.svg" })    a new icon from the mod's folder
//   ctx.icons.set("debug", { codicon: "rocket" })            another codicon's glyph
//   ctx.icons.set("x", { char: "", font: "fonts/my.woff2" })
//   ctx.icons.set("logo", { path: "logo.png", color: true }) a picture, in its own colors
//
// or in mod.json: "contributes": { "icons": { "files": "icons/files.svg", "docker": { "path": "…" } } }

import { type Disposable, toDisposable } from "./ui";

export type IconSource =
  | string
  | {
      /** SVG markup. */
      svg?: string;
      /** A file of the mod (resolved against the mod's folder by the caller) or any URL. */
      path?: string;
      url?: string;
      /** Another codicon's glyph. */
      codicon?: string;
      /** A glyph of a font: `char` ("" or "e001"), from `font` (a URL / mod file) or a loaded family. */
      char?: string;
      font?: string;
      fontFamily?: string;
      /** Draw the picture in its own colors (default: an SVG or picture is a mask tinted with the text color). */
      color?: boolean;
      /** Size relative to the icon box (default 1 = the box). */
      scale?: number;
    };

interface Entry {
  name: string;
  owner: string;
  css: string;
}

const entries: Entry[] = [];
let styleEl: HTMLStyleElement | null = null;
let fontN = 0;

const cssString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "")}"`;
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "");

/** The glyph a codicon draws (its ::before content), read from the stylesheet. */
function codiconContent(name: string): string | null {
  const probe = document.createElement("i");
  probe.className = `codicon codicon-${safeName(name)}`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.append(probe);
  const content = getComputedStyle(probe, "::before").content;
  probe.remove();
  return content && content !== "none" && content !== "normal" ? content : null;
}

function paint() {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.owner = "icons";
    document.head.append(styleEl);
  }
  // Later entries win: a mod enabled after another draws over it, and removing one shows the one below.
  styleEl.textContent = entries.map((e) => e.css).join("\n");
}

/** `resolve` turns a mod-relative `path` into a URL (the caller knows the mod). */
export function setIcon(name: string, source: IconSource, owner: string, resolve: (path: string) => string = (p) => p): Disposable {
  const n = safeName(name);
  if (!n) throw new Error(`invalid icon name ${JSON.stringify(name)}`);
  const sel = `.codicon.codicon-${n}::before, .codicon-${n}.codicon::before`;
  const src = typeof source === "string" ? (source.trim().startsWith("<") ? { svg: source } : { path: source }) : source;
  const scale = Number(src.scale) > 0 ? Number(src.scale) : 1;
  let css = "";
  if (src.codicon) {
    const content = codiconContent(src.codicon);
    if (!content) throw new Error(`no codicon named ${src.codicon}`);
    css = `${sel} { content: ${content} !important; }`;
  } else if (src.char) {
    const ch = /^[0-9a-f]{4,6}$/i.test(src.char) ? String.fromCodePoint(parseInt(src.char, 16)) : src.char;
    let family = src.fontFamily ?? "";
    let face = "";
    if (src.font) {
      family = `aicode-icons-${++fontN}`;
      face = `@font-face { font-family: ${cssString(family)}; src: url(${cssString(resolve(src.font))}); font-display: block; }\n`;
    }
    css = `${face}${sel} { content: ${cssString(ch)} !important;${family ? ` font-family: ${cssString(family)} !important;` : ""} }`;
  } else {
    const url = src.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src.svg)}` : src.url ?? (src.path ? resolve(src.path) : "");
    if (!url) throw new Error(`icon ${name}: give svg, path, url, codicon or char`);
    const box = `content: "" !important; display: inline-block; width: ${scale}em; height: ${scale}em; vertical-align: text-bottom;`;
    css = src.color
      ? `${sel} { ${box} background: url(${cssString(url)}) center / contain no-repeat; }`
      : `${sel} { ${box} background-color: currentColor; -webkit-mask: url(${cssString(url)}) center / contain no-repeat; mask: url(${cssString(url)}) center / contain no-repeat; }`;
  }
  const entry: Entry = { name: n, owner, css };
  entries.push(entry);
  paint();
  return toDisposable(() => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
    paint();
  });
}

/** Icon names a mod changed or added (for the docs and diagnostics). */
export function iconOverrides(): { name: string; owner: string }[] {
  return entries.map(({ name, owner }) => ({ name, owner }));
}
