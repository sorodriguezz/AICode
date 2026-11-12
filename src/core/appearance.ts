// Appearance: turns the configuration into what the window looks like, live. Colors over the theme
// (colorCustomizations, syntax rules, the cursor), see-through parts and background images, the tab
// bar's shape, tooltips, hidden parts, CSS variables, the user's own CSS, and the window itself
// (macOS material, always on top, shadow). Every part of the window carries `data-part="<name>"`
// (see PART_NAMES), which is what hiding, opacity and custom CSS target.

import { getCurrentWindow, Effect, EffectState } from "@tauri-apps/api/window";
import type * as monaco from "monaco-editor";
import { invoke } from "./ipc";
import { config, SURFACE_PARTS } from "./config";
import { setThemeCustomizations, type ThemeCustomizations, type VsTheme } from "./theme";
import { notify } from "./widgets";

type Surface = (typeof SURFACE_PARTS)[number];

interface Background {
  image?: string;
  size?: string;
  position?: string;
  repeat?: string;
  opacity?: number;
  blur?: number;
  color?: string;
}

/** The selector each surface paints, and the theme color it paints with. */
const SURFACES: Record<Surface, { selector: string; color: (c: Record<string, string>) => string | undefined; varName?: string }> = {
  window: { selector: "html, body, #app", color: (c) => c["editor.background"] },
  titleBar: { selector: '[data-part="titleBar"]', color: (c) => c["editor.background"] },
  statusBar: { selector: '[data-part="statusBar"]', color: (c) => c["editor.background"] },
  activityBar: { selector: '[data-part="activityBar"]', color: (c) => c["activityBar.background"] },
  sideBar: { selector: '[data-part="sideBar"]', color: (c) => c["sideBar.background"] },
  secondarySideBar: { selector: '[data-part="secondarySideBar"]', color: (c) => c["sideBar.background"] },
  panel: { selector: '[data-part="panel"]', color: (c) => c["panel.background"] },
  editor: { selector: '[data-part="editor"], [data-part="editor"] .breadcrumbs, [data-part="editor"] .custom-host, [data-part="editorSide"], [data-part="centerView"]', color: (c) => c["editor.background"] },
  tabs: { selector: '[data-part="tabs"]', color: (c) => c["editorWidget.background"] ?? c["editorGroupHeader.tabsBackground"] },
};

/** `#rgb`, `#rrggbb` or `#rrggbbaa` with its alpha multiplied by `a`; other colors through color-mix. */
export function withAlpha(color: string | undefined, a: number): string {
  if (!color) return `rgba(0,0,0,${a})`;
  const m = color.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((ch) => ch + ch).join("");
    const base = hex.slice(0, 6);
    const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    const out = Math.round(Math.max(0, Math.min(1, alpha * a)) * 255);
    return `#${base}${out.toString(16).padStart(2, "0")}`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const cssString = (s: string) => `"${s.replace(/["\\\n]/g, (c) => (c === "\n" ? "\\a " : `\\${c}`))}"`;

/** Short names in tokenColorCustomizations, as in VS Code. */
const TOKEN_GROUPS: Record<string, string[]> = {
  comments: ["comment", "punctuation.definition.comment"],
  strings: ["string"],
  keywords: ["keyword", "storage.type", "storage.modifier", "keyword.control"],
  numbers: ["constant.numeric"],
  types: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  functions: ["entity.name.function", "support.function"],
  variables: ["variable", "variable.other"],
};

export class Appearance {
  private style = document.createElement("style");
  private userStyle = document.createElement("style");
  private background = document.createElement("div");
  private images = new Map<string, Promise<string | null>>();
  private tooltip: Tooltips;
  private win = getCurrentWindow();
  /** Whether this window was created transparent (it cannot change without reopening). */
  readonly transparentAtStart: boolean;
  private lastEffects = "";
  private lastOnTop: boolean | null = null;
  private lastShadow: boolean | null = null;
  private cssFileTexts = new Map<string, string>();
  private surfacesCss = "";
  private see = new Set<Surface>();

  /** `createdTransparent`: whether Rust made this window transparent (window_is_transparent). */
  constructor(createdTransparent: boolean) {
    this.style.id = "aicode-appearance";
    this.userStyle.id = "aicode-user-css";
    this.background.className = "app-background";
    this.background.dataset.part = "windowBackground";
    document.head.append(this.style);
    document.head.append(this.userStyle);
    document.body.prepend(this.background);
    this.tooltip = new Tooltips();
    this.transparentAtStart = createdTransparent;
    setThemeCustomizations((id, kind, colors) => this.themeCustomizations(id, kind, colors));
  }

  /** Everything, from the configuration as it is now. */
  async applyAll() {
    this.applyRoot();
    this.applyHidden();
    await this.applyUserCss();
    this.applyTooltips();
    await this.applyWindow();
    await this.applyBackgrounds();
    this.repaintTheme();
  }

  /** What one batch of changed core keys needs redone. */
  async applyChanged(keys: string[]) {
    const has = (...prefixes: string[]) => keys.some((k) => prefixes.some((p) => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p)));
    if (has("workbench.tabs.*", "workbench.fontFamily", "workbench.fontSize", "workbench.cornerRadius", "workbench.titleBar.height", "workbench.statusBar.height", "workbench.scrollbars.*", "workbench.focusOutline", "workbench.activityBar.indicator", "workbench.cssVariables", "workbench.tooltips.maxWidth")) this.applyRoot();
    if (has("workbench.hide", "workbench.breadcrumbs", "workbench.badges", "workbench.tabs.visible", "workbench.tabs.showIcons")) this.applyHidden();
    if (has("workbench.customCSS", "workbench.customCSSFiles")) await this.applyUserCss();
    if (has("workbench.tooltips.*")) this.applyTooltips();
    if (has("window.*")) await this.applyWindow();
    if (has("window.background", "workbench.partBackgrounds")) await this.applyBackgrounds();
    if (has("workbench.colorCustomizations", "editor.tokenColorCustomizations", "editor.cursorColor", "workbench.opacity", "workbench.partOpacity", "workbench.partBackgrounds", "window.background")) this.repaintTheme();
    if (keys.includes("window.transparent")) this.checkTransparency();
  }

  /** Says so when window.transparent differs from how this window was created. */
  checkTransparency() {
    if (!!config.core("window.transparent", false) === this.transparentAtStart) return;
    notify("info", this.transparentAtStart ? "This window was created transparent. Reopen it to make it opaque." : "Transparency is set when a window is created. Reopen this window to make it transparent.", [
      { label: "Reopen Window", run: () => import("./commands").then((c) => c.execute("window.reopen")) },
    ]);
  }

  /** A CSS file of the user's was saved: reapply it. */
  async fileSaved(path: string) {
    const files = (config.core<string[]>("workbench.customCSSFiles", []) ?? []).map((f) => this.expand(f));
    if (files.includes(path)) await this.applyUserCss();
  }

  // ---------- root variables and modes ----------

  private applyRoot() {
    const c = <T>(k: string, d: T) => config.core(k, d);
    const root = document.documentElement;
    const ds = root.dataset;
    ds.tabShape = c("workbench.tabs.shape", "connected");
    ds.tabClose = c("workbench.tabs.closeButton", "right");
    ds.tabIndicator = c("workbench.tabs.activeIndicator", "top");
    ds.tabWrap = c("workbench.tabs.wrap", false) ? "on" : "off";
    ds.activityIndicator = c("workbench.activityBar.indicator", "background");
    ds.scrollbars = c("workbench.scrollbars.visibility", "hover");
    ds.focusOutline = c("workbench.focusOutline", true) ? "on" : "off";
    const vars: Record<string, string> = {
      "--editor-tabs-h": `${c("workbench.tabs.height", 32)}px`,
      "--tab-min-w": `${c("workbench.tabs.minWidth", 80)}px`,
      "--tab-max-w": `${c("workbench.tabs.maxWidth", 220)}px`,
      "--tab-gap": `${c("workbench.tabs.gap", 0)}px`,
      "--scrollbar-size": `${c("workbench.scrollbars.size", 10)}px`,
      "--tooltip-max-w": `${c("workbench.tooltips.maxWidth", 360)}px`,
      "--card-radius": `${c("workbench.cornerRadius", 8)}px`,
      "--ui-font-size": `${c("workbench.fontSize", 13)}px`,
    };
    const titleH = c("workbench.titleBar.height", 35);
    const statusH = c("workbench.statusBar.height", 28);
    if (titleH !== 35) vars["--titlebar-h"] = `${titleH}px`;
    if (statusH !== 28) vars["--statusbar-h"] = `${statusH}px`;
    const font = c("workbench.fontFamily", "");
    if (font) vars["--font-ui"] = font;
    const custom = c<Record<string, unknown>>("workbench.cssVariables", {});
    if (isObject(custom)) for (const [k, v] of Object.entries(custom)) if (v !== null && v !== undefined) vars[k.startsWith("--") ? k : `--${k}`] = String(v);
    this.rootVars = vars;
    this.writeStyle();
  }

  private rootVars: Record<string, string> = {};
  private hiddenCss = "";
  private backgroundCss = "";

  private writeStyle() {
    const vars = Object.entries(this.rootVars).map(([k, v]) => `  ${k}: ${v};`).join("\n");
    this.style.textContent = [`:root {\n${vars}\n}`, this.surfacesCss, this.backgroundCss, this.hiddenCss].filter(Boolean).join("\n");
  }

  // ---------- hidden parts ----------

  private applyHidden() {
    const list = [...(config.core<string[]>("workbench.hide", []) ?? []), ...this.extraHide];
    if (config.core("workbench.breadcrumbs", true) === false) list.push("breadcrumbs");
    if (config.core("workbench.badges", true) === false) list.push("activityBar.badge");
    if (config.core("workbench.tabs.visible", true) === false) list.push("tabs");
    if (config.core("workbench.tabs.showIcons", true) === false) list.push("tab.icon");
    this.hiddenCss = selectorsFor(list).map((sel) => `${sel} { display: none !important; }`).join("\n");
    this.writeStyle();
  }

  // ---------- the user's CSS ----------

  private async applyUserCss() {
    const inline = config.core<string | string[]>("workbench.customCSS", "");
    const parts = (Array.isArray(inline) ? inline : [inline]).filter((x) => typeof x === "string" && x.trim());
    const files = (config.core<string[]>("workbench.customCSSFiles", []) ?? []).filter((f) => typeof f === "string" && f);
    for (const f of files) {
      const path = this.expand(f);
      try {
        const text = (await invoke<{ text: string }>("fs_read_text", { modId: "core", path })).text;
        this.cssFileTexts.set(path, text);
        parts.push(`/* ${path} */\n${text}`);
      } catch (e) {
        console.warn(`custom CSS ${path}:`, e);
      }
    }
    this.userStyle.textContent = parts.join("\n\n");
    // After every mod's stylesheet, so the user's rules win.
    document.head.append(this.style, this.userStyle);
  }

  private home = "";
  private expand(p: string) {
    return p.startsWith("~/") && this.home ? this.home + p.slice(1) : p;
  }
  async init() {
    this.home = await invoke<string>("home_dir").catch(() => "");
  }

  // ---------- tooltips ----------

  private applyTooltips() {
    this.tooltip.configure(config.core("workbench.tooltips.style", "custom"), config.core("workbench.tooltips.delay", 500));
  }

  // ---------- the window ----------

  private async applyWindow() {
    const vibrancy = config.core<string>("window.vibrancy", "none");
    const effects = vibrancy && vibrancy !== "none" ? vibrancy : "";
    if (effects !== this.lastEffects) {
      this.lastEffects = effects;
      try {
        if (effects) await this.win.setEffects({ effects: [effects as Effect], state: EffectState.FollowsWindowActiveState });
        else await this.win.clearEffects();
      } catch (e) {
        console.warn("window effects", e);
      }
      if (effects && !this.transparentAtStart) {
        notify("info", "The background material shows through a transparent window. Turn on Transparent Window and reopen it.", [
          { label: "Turn On and Reopen", run: async () => { await config.update("core", "window.transparent", true); (await import("./commands")).execute("window.reopen"); } },
        ]);
      }
    }
    const onTop = !!config.core("window.alwaysOnTop", false) || this.pinned;
    if (onTop !== this.lastOnTop) {
      this.lastOnTop = onTop;
      await this.win.setAlwaysOnTop(onTop).catch((e) => console.warn("always on top", e));
    }
    const shadow = config.core("window.shadow", true) !== false;
    if (shadow !== this.lastShadow) {
      const first = this.lastShadow === null;
      this.lastShadow = shadow;
      // Windows start with a shadow: only a change (or "off" at start) needs a call.
      if (!(first && shadow)) await this.win.setShadow(shadow).catch(() => {});
    }
  }

  /** This window pinned on top by its own pin button or its layout (over window.alwaysOnTop). */
  pinned = false;
  /** Parts hidden in this window only (its layout's `hide`). */
  extraHide: string[] = [];
  async setPinned(on: boolean) {
    this.pinned = on;
    await this.applyWindow();
  }
  isOnTop() {
    return !!this.lastOnTop;
  }

  // ---------- backgrounds ----------

  private async image(src: string): Promise<string | null> {
    if (/^(data:|https:|blob:)/.test(src)) return src;
    const path = this.expand(src);
    if (!this.images.has(path)) {
      this.images.set(
        path,
        invoke<string>("fs_read_data_url", { modId: "core", path }).catch((e) => {
          notify("warning", `Background image ${path}: ${e}`);
          return null;
        }),
      );
    }
    return this.images.get(path)!;
  }

  private async applyBackgrounds() {
    // The whole window.
    const win = config.core<Background>("window.background", {});
    this.background.replaceChildren();
    this.background.style.cssText = "";
    if (isObject(win) && (win.image || win.color)) {
      const url = win.image ? await this.image(win.image) : null;
      const isVideo = !!win.image && /\.(mp4|m4v|webm|mov)$/i.test(win.image);
      Object.assign(this.background.style, { display: "block", backgroundColor: win.color ?? "" });
      if (url && isVideo) {
        const video = document.createElement("video");
        Object.assign(video, { src: url, autoplay: true, loop: true, muted: true, playsInline: true });
        Object.assign(video.style, { width: "100%", height: "100%", objectFit: win.size === "contain" ? "contain" : "cover", opacity: String(win.opacity ?? 1), filter: win.blur ? `blur(${win.blur}px)` : "" });
        this.background.append(video);
      } else if (url) {
        const layer = document.createElement("div");
        Object.assign(layer.style, {
          position: "absolute",
          inset: win.blur ? `-${win.blur * 2}px` : "0",
          backgroundImage: `url(${cssString(url)})`,
          backgroundSize: win.size ?? "cover",
          backgroundPosition: win.position ?? "center",
          backgroundRepeat: win.repeat ?? "no-repeat",
          opacity: String(win.opacity ?? 1),
          filter: win.blur ? `blur(${win.blur}px)` : "",
        });
        this.background.append(layer);
      }
    }
    // One part at a time: the image sits over the part's color and under its content.
    const parts = config.core<Record<string, Background>>("workbench.partBackgrounds", {});
    const rules: string[] = [];
    if (isObject(parts)) {
      for (const [name, bg] of Object.entries(parts)) {
        const surface = SURFACES[name as Surface];
        if (!surface || !isObject(bg) || name === "window") continue;
        const url = bg.image ? await this.image(bg.image) : null;
        if (!url && !bg.color) continue;
        const sel = surface.selector.split(",")[0].trim();
        // The tab bar already draws its bottom line with ::after.
        const pseudo = name === "tabs" ? "::before" : "::after";
        rules.push(
          `${sel} { position: relative; isolation: isolate; }`,
          `${sel}${pseudo} { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: -1; border-radius: inherit;` +
            (url ? ` background-image: url(${cssString(url)}); background-size: ${bg.size ?? "cover"}; background-position: ${bg.position ?? "center"}; background-repeat: ${bg.repeat ?? "no-repeat"};` : "") +
            (bg.color ? ` background-color: ${bg.color};` : "") +
            ` opacity: ${bg.opacity ?? 0.25};${bg.blur ? ` filter: blur(${bg.blur}px);` : ""} }`,
        );
      }
    }
    this.backgroundCss = rules.join("\n");
    this.writeStyle();
  }

  // ---------- colors over the theme ----------

  private repaintTheme() {
    setThemeCustomizations((id, kind, colors) => this.themeCustomizations(id, kind, colors));
  }

  /** The window's own appearance follows the theme, so macOS's glass is dark under a dark theme. */
  private windowKind: "dark" | "light" | null = null;
  private matchWindowTheme(kind: "dark" | "light") {
    if (kind === this.windowKind) return;
    this.windowKind = kind;
    this.win.setTheme(kind).catch((e) => console.warn("window theme", e));
  }

  private themeCustomizations(themeId: string, kind: "dark" | "light", themed: Record<string, string>): ThemeCustomizations {
    this.matchWindowTheme(kind);
    const out: Required<ThemeCustomizations> = { colors: {}, tokenColors: [], editorColors: {} };
    // Colors: the general ones, then the ones for this theme ("[aicode-light]": { … }).
    const custom = config.core<Record<string, any>>("workbench.colorCustomizations", {}) ?? {};
    for (const [k, v] of Object.entries(custom)) if (!k.startsWith("[") && typeof v === "string") out.colors[k] = v;
    const forTheme = custom[`[${themeId}]`];
    if (isObject(forTheme)) for (const [k, v] of Object.entries(forTheme)) if (typeof v === "string") out.colors[k] = v;
    const cursor = config.core<string>("editor.cursorColor", "");
    if (cursor) out.colors["editorCursor.foreground"] = cursor;

    // Syntax colors.
    const tokens = config.core<Record<string, any>>("editor.tokenColorCustomizations", {}) ?? {};
    const addTokens = (t: Record<string, any>) => {
      for (const [group, scopes] of Object.entries(TOKEN_GROUPS)) {
        const v = t[group];
        if (typeof v === "string") out.tokenColors.push({ scope: scopes, settings: { foreground: v } });
        else if (isObject(v)) out.tokenColors.push({ scope: scopes, settings: { foreground: v.foreground, fontStyle: v.fontStyle } });
      }
      if (Array.isArray(t.textMateRules)) for (const r of t.textMateRules) if (isObject(r) && isObject(r.settings)) out.tokenColors.push(r as NonNullable<VsTheme["tokenColors"]>[number]);
    };
    addTokens(tokens);
    if (isObject(tokens[`[${themeId}]`])) addTokens(tokens[`[${themeId}]`]);

    // See-through parts.
    const colors = { ...themed, ...out.colors };
    const all = Number(config.core("workbench.opacity", 1));
    const per = config.core<Record<string, number>>("workbench.partOpacity", {}) ?? {};
    const partBgs = config.core<Record<string, Background>>("workbench.partBackgrounds", {}) ?? {};
    const winBg = config.core<Background>("window.background", {});
    const rules: string[] = [];
    this.see.clear();
    for (const name of SURFACE_PARTS) {
      // Each part's opacity times the global one: workbench.opacity turns every part up or down at once.
      const raw = Number(per[name] ?? 1) * (Number.isFinite(all) ? all : 1);
      const a = Number.isFinite(Number(raw)) ? Math.max(0, Math.min(1, Number(raw))) : 1;
      const hasImage = isObject(partBgs[name]) && !!(partBgs[name].image || partBgs[name].color);
      if (a >= 1 && !hasImage) continue;
      this.see.add(name);
      const surface = SURFACES[name];
      const color = withAlpha(surface.color(colors), a);
      rules.push(`${surface.selector} { background-color: ${color} !important; }`);
      if (name === "tabs") {
        rules.push(
          `[data-part="tabs"] { --aicode-tab-activeBackground: ${withAlpha(colors["tab.activeBackground"] ?? colors["editor.background"], a)}; }`,
          `[data-part="tabs"] .tab { background-color: transparent !important; }`,
        );
      }
    }
    const translucent = this.see.size > 0 || this.transparentAtStart || (isObject(winBg) && !!(winBg.image || winBg.color));
    if (translucent && !this.see.has("window")) {
      // The window's own color goes on the background layer, so the image or the desktop can replace it.
      rules.push(`html, body, #app { background-color: transparent !important; }`, `.app-background { background-color: ${winBg?.color ?? colors["editor.background"] ?? "transparent"}; }`);
      if (this.transparentAtStart && !(isObject(winBg) && (winBg.image || winBg.color))) rules.push(`.app-background { display: block; }`);
    }
    if (this.see.has("window")) rules.push(`.app-background { display: block; }`);
    // The editor (Monaco) paints its own background: clear it and let the part's show.
    if (this.see.has("editor")) {
      const clear = "#00000000";
      Object.assign(out.editorColors, {
        "editor.background": clear,
        "editorGutter.background": clear,
        "minimap.background": clear,
        "editorStickyScroll.background": withAlpha(colors["editor.background"], Math.max(0.85, Number(per.editor ?? 1) * all)),
        "editorStickyScrollHover.background": colors["editorStickyScrollHover.background"] ?? colors["list.hoverBackground"] ?? colors["editor.background"],
      });
    }
    this.surfacesCss = rules.join("\n");
    this.writeStyle();
    return out;
  }
}

/** `workbench.hide` entries to CSS selectors: part names, "statusBar.item:<id>", or "css:<selector>". */
export function selectorsFor(list: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const s = raw.trim();
    if (s.startsWith("css:")) out.push(s.slice(4));
    else if (/^[\w.-]+:[\w.:-]+$/.test(s)) {
      const at = s.indexOf(":");
      out.push(`[data-part="${s.slice(0, at)}"][data-id="${s.slice(at + 1)}"]`);
    } else if (/^[\w.-]+$/.test(s)) out.push(`[data-part="${s}"]`);
  }
  return out;
}

// ---------- tooltips ----------

/**
 * Themed tooltips for everything that has a `title`: the title moves to `data-tip` while the
 * pointer is over the element (so the system's does not show too) and a tooltip styled by the
 * theme shows after the delay. "native" leaves titles alone; "off" shows none.
 */
class Tooltips {
  private style = "custom";
  private delay = 500;
  private el: HTMLElement | null = null;
  private timer = 0;
  private current: HTMLElement | null = null;

  constructor() {
    document.addEventListener("mouseover", (e) => this.over(e), true);
    document.addEventListener("mouseout", (e) => this.out(e), true);
    document.addEventListener("mousedown", () => this.hide(), true);
    document.addEventListener("wheel", () => this.hide(), { capture: true, passive: true });
    window.addEventListener("blur", () => this.hide());
  }

  configure(style: string, delay: number) {
    this.style = style;
    this.delay = Math.max(0, Number(delay) || 0);
    this.hide();
    if (style === "native") document.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => this.restore(el));
  }

  private restore(el: HTMLElement) {
    if (el.dataset.tip !== undefined) {
      if (!el.getAttribute("title")) el.setAttribute("title", el.dataset.tip);
      delete el.dataset.tip;
    }
  }

  private over(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target?.closest) return;
    // Monaco's own hovers and widgets keep their behavior.
    if (target.closest(".monaco-editor .view-lines, .monaco-hover")) return;
    const el = target.closest<HTMLElement>("[title], [data-tip]");
    if (this.style === "native") {
      if (el) this.restore(el);
      return;
    }
    if (!el) return;
    if (el.hasAttribute("title")) {
      const title = el.getAttribute("title");
      if (title) el.dataset.tip = title;
      else delete el.dataset.tip;
      el.removeAttribute("title");
    }
    if (this.style === "off" || el === this.current) return;
    this.hide();
    this.current = el;
    const text = el.dataset.tip;
    if (!text) return;
    this.timer = window.setTimeout(() => this.show(el, text), this.delay);
  }

  private out(e: MouseEvent) {
    if (!this.current) return;
    const to = e.relatedTarget as Node | null;
    if (to && this.current.contains(to)) return;
    this.hide();
  }

  private show(anchor: HTMLElement, text: string) {
    if (!anchor.isConnected) return;
    const el = (this.el ??= Object.assign(document.createElement("div"), { className: "aicode-tooltip", role: "tooltip" }));
    el.dataset.part = "tooltip";
    el.textContent = text;
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
    let y = r.bottom + 6;
    let below = true;
    if (y + hgt > window.innerHeight - 6) {
      y = r.top - hgt - 6;
      below = false;
    }
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.dataset.side = below ? "below" : "above";
    el.classList.add("visible");
  }

  hide() {
    clearTimeout(this.timer);
    this.current = null;
    this.el?.classList.remove("visible");
    this.el?.remove();
  }
}

// ---------- the editor's options ----------

const DEFAULT_FONT = "Menlo, 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace";

/** Monaco options from the configuration (the font size is applied by the editor service). */
export function editorOptions(): monaco.editor.IEditorOptions & Record<string, unknown> {
  const g = <T>(k: string, d: T) => config.core(k, d);
  const bracketGuides = g<string>("editor.guides.bracketPairs", "active");
  const ruler = g("editor.overviewRuler", true) !== false;
  const scrollSize = Number(g("editor.scrollbar.size", 14));
  const rulers = g<unknown[]>("editor.rulers", []);
  const base: monaco.editor.IEditorOptions = {
    fontFamily: g("editor.fontFamily", "") || DEFAULT_FONT,
    fontWeight: String(g("editor.fontWeight", "normal")),
    fontLigatures: !!g("editor.fontLigatures", false),
    letterSpacing: Number(g("editor.letterSpacing", 0)),
    lineHeight: Number(g("editor.lineHeight", 0)),
    wordWrap: g("editor.wordWrap", "off") as any,
    lineNumbers: g("editor.lineNumbers", "on") as any,
    renderWhitespace: g("editor.renderWhitespace", "selection") as any,
    renderControlCharacters: g("editor.renderControlCharacters", true) !== false,
    smoothScrolling: g("editor.smoothScrolling", true) !== false,
    scrollBeyondLastLine: !!g("editor.scrollBeyondLastLine", false),
    mouseWheelZoom: !!g("editor.mouseWheelZoom", false),
    padding: { top: Number(g("editor.padding.top", 4)), bottom: Number(g("editor.padding.bottom", 0)) },
    stickyScroll: { enabled: g("editor.stickyScroll", true) !== false },
    bracketPairColorization: { enabled: g("editor.bracketPairColorization", true) !== false },
    matchBrackets: g("editor.matchBrackets", "always") as any,
    dragAndDrop: g("editor.dragAndDrop", true) !== false,
    links: g("editor.links", true) !== false,
    colorDecorators: g("editor.colorDecorators", true) !== false,
    quickSuggestions: g("editor.quickSuggestions", true) !== false,
    suggestOnTriggerCharacters: g("editor.suggestOnTriggerCharacters", true) !== false,
    hover: { enabled: (g("editor.hover.enabled", true) !== false ? "on" : "off") as any, delay: Number(g("editor.hover.delay", 300)) },
    codeLens: g("editor.codeLens", true) !== false,
    inlayHints: { enabled: g("editor.inlayHints", "on") as any },
    occurrencesHighlight: g("editor.occurrencesHighlight", true) !== false ? "singleFile" : "off",
    selectionHighlight: g("editor.selectionHighlight", true) !== false,
    cursorStyle: g("editor.cursorStyle", "line") as any,
    cursorBlinking: g("editor.cursorBlinking", "smooth") as any,
    cursorWidth: Number(g("editor.cursorWidth", 0)),
    cursorSmoothCaretAnimation: g("editor.cursorSmoothCaretAnimation", "on") as any,
    cursorSurroundingLines: Number(g("editor.cursorSurroundingLines", 0)),
    multiCursorModifier: g("editor.multiCursorModifier", "alt") as any,
    minimap: {
      enabled: g("editor.minimap", true) !== false,
      side: g("editor.minimap.side", "right") as any,
      size: g("editor.minimap.size", "proportional") as any,
      scale: Number(g("editor.minimap.scale", 1)),
      renderCharacters: g("editor.minimap.renderCharacters", true) !== false,
      showSlider: g("editor.minimap.showSlider", "mouseover") as any,
      maxColumn: 120,
    },
    glyphMargin: g("editor.glyphMargin", true) !== false,
    folding: g("editor.folding", true) !== false,
    showFoldingControls: g("editor.showFoldingControls", "mouseover") as any,
    renderLineHighlight: g("editor.renderLineHighlight", "all") as any,
    rulers: Array.isArray(rulers) ? (rulers.filter((r) => typeof r === "number" || isObject(r)) as any) : [],
    guides: { indentation: g("editor.guides.indentation", true) !== false, bracketPairs: bracketGuides === "true" ? true : bracketGuides === "false" ? false : "active" },
    overviewRulerLanes: ruler ? 3 : 0,
    hideCursorInOverviewRuler: !ruler,
    overviewRulerBorder: g("editor.overviewRulerBorder", true) !== false,
    lightbulb: { enabled: g("editor.lightbulb", "onCode") as any },
    scrollbar: {
      vertical: g("editor.scrollbar.vertical", "auto") as any,
      horizontal: g("editor.scrollbar.horizontal", "auto") as any,
      verticalScrollbarSize: scrollSize,
      horizontalScrollbarSize: Math.max(0, scrollSize - 2),
    },
  };
  const raw = g<Record<string, unknown>>("editor.monacoOptions", {});
  return { ...base, ...(isObject(raw) ? raw : {}) };
}
