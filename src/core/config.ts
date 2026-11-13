// Configuration in layers, like VS Code. Every setting has a default (its schema); enabled mods
// can change defaults (`contributes.configurationDefaults`); the profile holds the user's values
// (profile.json → settings); and a window opened with a layout can override some of them for that
// window only. The value a setting has is the last layer that sets it:
//
//   schema default  ←  mods' defaults (in load order)  ←  user (profile.json)  ←  this window
//
// Objects merge key by key across layers (a mod adds one color to `workbench.colorCustomizations`
// without wiping the others); a `null` inside an object removes that key. Anything else is
// replaced whole.
//
// Owners: the editor's own settings live under "core"; each mod's under its id.

import * as monaco from "monaco-editor";
import { invoke } from "./ipc";
import { Emitter } from "./events";
import type { Disposable } from "./ui";

export type SettingType = "boolean" | "number" | "string" | "array" | "object";

export interface SettingSchema {
  type: SettingType;
  default: unknown;
  title?: string;
  description?: string;
  /** Settings page section. */
  section?: string;
  enum?: { value: unknown; label: string }[];
  min?: number;
  max?: number;
  /** A color (shown with a swatch, validated as CSS color text). */
  format?: "color";
  /** Kept out of the Settings page (edited by the workbench itself or in JSON only). */
  hidden?: boolean;
  /** How the change takes effect: right away (default), after Reload Window, or a reopened window. */
  applies?: "live" | "reload" | "reopen";
  /** JSON schema for arrays and objects (profile.json completions). */
  json?: Record<string, unknown>;
}

export type Values = Record<string, Record<string, unknown>>;

export interface Change {
  owner: string;
  key: string;
}

export interface Inspection {
  default: unknown;
  mods: { mod: string; value: unknown }[];
  user: unknown;
  window: unknown;
  value: unknown;
}

/** `true` → boolean, `12` → number: a fallback's literal type should not narrow the result. */
type Widen<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep merge for configuration objects: `null` deletes a key, arrays and scalars replace. */
export function mergeConfig(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isObject(base) || !isObject(over)) return over === null ? undefined : clone(over);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = isObject(out[k]) && isObject(v) ? mergeConfig(out[k], v) : clone(v);
  }
  return out;
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ConfigService {
  private schemas = new Map<string, Record<string, SettingSchema>>();
  private user: Values = {};
  /** One entry per enabled mod with configurationDefaults, in load order. */
  private modLayers: { mod: string; values: Values }[] = [];
  private windowLayer: Values = {};
  private cache = new Map<string, unknown>();
  readonly onDidChange = new Emitter<Change[]>();
  readonly onDidChangeSchema = new Emitter<void>();

  // ---------- schemas ----------

  registerSchema(owner: string, props: Record<string, SettingSchema>) {
    this.schemas.set(owner, { ...(this.schemas.get(owner) ?? {}), ...props });
    this.cache.clear();
    this.onDidChangeSchema.fire();
  }

  schema(owner: string): Record<string, SettingSchema> {
    return this.schemas.get(owner) ?? {};
  }

  owners(): string[] {
    const set = new Set<string>([...this.schemas.keys(), ...Object.keys(this.user), ...Object.keys(this.windowLayer)]);
    for (const l of this.modLayers) for (const o of Object.keys(l.values)) set.add(o);
    return [...set];
  }

  // ---------- layers ----------

  /** The profile's own values (profile.json → settings), all owners. */
  async loadUser() {
    const all = await invoke<Values>("settings_all").catch(() => ({}) as Values);
    this.replaceLayer(() => (this.user = isObject(all) ? (all as Values) : {}));
  }

  setModLayers(layers: { mod: string; values: Values }[]) {
    this.replaceLayer(() => (this.modLayers = layers.filter((l) => isObject(l.values))));
  }

  setWindowLayer(values: Values) {
    this.replaceLayer(() => (this.windowLayer = values ?? {}));
  }

  /** Swaps a layer and tells listeners which effective values changed. */
  private replaceLayer(swap: () => void) {
    const before = this.snapshot();
    swap();
    this.cache.clear();
    const after = this.snapshot();
    const changes: Change[] = [];
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!same(before[id], after[id])) {
        const at = id.indexOf("\u0000");
        changes.push({ owner: id.slice(0, at), key: id.slice(at + 1) });
      }
    }
    if (changes.length) this.onDidChange.fire(changes);
  }

  private snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const owner of this.owners()) for (const key of this.keys(owner)) out[`${owner}\u0000${key}`] = this.get(owner, key);
    return out;
  }

  /** Every key known for an owner: declared, or set by any layer. */
  keys(owner: string): string[] {
    const set = new Set<string>(Object.keys(this.schema(owner)));
    for (const v of [this.user[owner], this.windowLayer[owner], ...this.modLayers.map((l) => l.values[owner])]) if (isObject(v)) for (const k of Object.keys(v)) set.add(k);
    return [...set];
  }

  // ---------- reading ----------

  get<T = any>(owner: string, key: string, fallback?: T): Widen<T> {
    const id = `${owner}\u0000${key}`;
    if (!this.cache.has(id)) this.cache.set(id, this.resolve(owner, key));
    const v = this.cache.get(id);
    return (v === undefined ? fallback : clone(v)) as Widen<T>;
  }

  /** Every setting of an owner with its effective value. */
  all(owner: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of this.keys(owner)) {
      const v = this.get(owner, key);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  /** The core setting `key` (the editor's own). */
  core<T = any>(key: string, fallback?: T): Widen<T> {
    return this.get<T>("core", key, fallback);
  }

  private resolve(owner: string, key: string): unknown {
    let value: unknown = this.schema(owner)[key]?.default;
    for (const l of this.modLayers) {
      const v = l.values[owner]?.[key];
      if (v !== undefined) value = mergeConfig(value, v);
    }
    for (const layer of [this.user, this.windowLayer]) {
      const v = layer[owner]?.[key];
      if (v !== undefined && v !== null) value = mergeConfig(value, v);
    }
    return value;
  }

  inspect(owner: string, key: string): Inspection {
    return {
      default: clone(this.schema(owner)[key]?.default),
      mods: this.modLayers.filter((l) => l.values[owner]?.[key] !== undefined).map((l) => ({ mod: l.mod, value: clone(l.values[owner][key]) })),
      user: clone(this.user[owner]?.[key]),
      window: clone(this.windowLayer[owner]?.[key]),
      value: this.get(owner, key),
    };
  }

  /** The user's own value (profile.json), or undefined. */
  userValue(owner: string, key: string): unknown {
    return clone(this.user[owner]?.[key]);
  }

  // ---------- writing ----------

  /** Sets the user's value (`null` or `undefined` removes it: back to the defaults). */
  async update(owner: string, key: string, value: unknown) {
    const v = value === undefined ? null : value;
    await invoke("settings_set", { modId: owner, key, value: v });
    this.replaceLayer(() => {
      const section = { ...(this.user[owner] ?? {}) };
      if (v === null) delete section[key];
      else section[key] = clone(v);
      this.user = { ...this.user, [owner]: section };
    });
  }

  /** Calls `fn` when one of the keys (or any key under a prefix ending in "*") of an owner changes. */
  watch(owner: string, keys: string[] | string, fn: (changes: Change[]) => void): Disposable {
    const list = Array.isArray(keys) ? keys : [keys];
    const hit = (c: Change) => c.owner === owner && list.some((k) => (k.endsWith("*") ? c.key.startsWith(k.slice(0, -1)) : c.key === k));
    return this.onDidChange.event((changes) => {
      const mine = changes.filter(hit);
      if (mine.length) fn(mine);
    });
  }

  // ---------- documents ----------

  /** JSON schema for profile.json: completions and validation while it is edited. */
  profileJsonSchema(modIds: string[]): Record<string, unknown> {
    const settingsProps: Record<string, unknown> = {};
    for (const owner of new Set(["core", ...this.schemas.keys()])) {
      settingsProps[owner] = { type: "object", properties: this.ownerJsonProperties(owner), additionalProperties: true };
    }
    return {
      type: "object",
      properties: {
        description: { type: "string" },
        icon: { type: "string" },
        enabled: { type: "array", items: { type: "string", enum: modIds }, description: "Mods turned on in this profile." },
        defaultsOffered: { type: "array", items: { type: "string" }, description: "Mods AICode turns on by default that this profile has already been given (turning one off keeps it off)." },
        settings: { type: "object", properties: settingsProps, additionalProperties: { type: "object" }, description: "Your values. They go over the defaults and over what mods set." },
        keybindings: {
          type: "array",
          items: { type: "object", properties: { key: { type: "string" }, command: { type: "string" }, args: {} }, required: ["key", "command"] },
        },
      },
    };
  }

  /** JSON schema for one owner's settings (also used for `configurationDefaults` in mod.json). */
  ownerJsonProperties(owner: string): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const [key, s] of Object.entries(this.schema(owner))) {
      const base: Record<string, unknown> = { type: s.type, default: s.default, description: [s.title, s.description].filter(Boolean).join(" — ") };
      if (s.enum) base.enum = s.enum.map((e) => e.value);
      if (s.min !== undefined) base.minimum = s.min;
      if (s.max !== undefined) base.maximum = s.max;
      props[key] = { ...base, ...(s.json ?? {}) };
    }
    return props;
  }

  /** "Default Settings (JSON)": every setting with its default and description, read-only. */
  defaultsDocument(): string {
    const lines: string[] = [
      "// AICode — default settings. This file is read-only: it lists every setting with its default.",
      "// To change one, put it in your profile.json under \"settings\" → \"core\" (or the mod's id).",
      "// Mods can change these defaults with \"contributes.configurationDefaults\"; your values go over theirs.",
      "{",
    ];
    const owners = ["core", ...[...this.schemas.keys()].filter((o) => o !== "core")];
    owners.forEach((owner, oi) => {
      const schema = this.schema(owner);
      const entries = Object.entries(schema);
      if (!entries.length) return;
      lines.push(`  "${owner}": {`);
      let section = "";
      entries.forEach(([key, s], i) => {
        if (s.section && s.section !== section) {
          section = s.section;
          lines.push(`${i ? "\n" : ""}    // ───── ${section} ─────`);
        }
        const doc = [s.title, s.description].filter(Boolean).join(" — ");
        if (doc) lines.push(`    // ${doc.replace(/\n/g, " ")}`);
        if (s.enum) lines.push(`    // One of: ${s.enum.map((e) => JSON.stringify(e.value)).join(", ")}`);
        if (s.applies && s.applies !== "live") lines.push(`    // Applies after ${s.applies === "reload" ? "Reload Window" : "reopening the window"}.`);
        const json = JSON.stringify(s.default, null, 2).replace(/\n/g, "\n    ");
        lines.push(`    ${JSON.stringify(key)}: ${json}${i < entries.length - 1 ? "," : ""}`);
      });
      lines.push(`  }${oi < owners.length - 1 ? "," : ""}`);
    });
    lines.push("}");
    return lines.join("\n");
  }

  /** "Effective Settings (JSON)": the value each setting has now, and which layer set it. */
  effectiveDocument(): string {
    const lines: string[] = [
      "// AICode — effective settings: the value every setting has in this window right now.",
      "// Each line says where the value came from: default, a mod, you (profile.json) or this window.",
      "{",
    ];
    const owners = this.owners().filter((o) => this.keys(o).length).sort((a, b) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
    owners.forEach((owner, oi) => {
      lines.push(`  "${owner}": {`);
      const keys = this.keys(owner).sort();
      keys.forEach((key, i) => {
        const ins = this.inspect(owner, key);
        const from = [
          ins.window !== undefined ? "this window" : null,
          ins.user !== undefined ? "you" : null,
          ...ins.mods.map((m) => `mod ${m.mod}`).reverse(),
        ].filter(Boolean);
        lines.push(`    // ${from.length ? `set by ${from.join(" over ")}` : "default"}`);
        const json = JSON.stringify(ins.value ?? null, null, 2).replace(/\n/g, "\n    ");
        lines.push(`    ${JSON.stringify(key)}: ${json}${i < keys.length - 1 ? "," : ""}`);
      });
      lines.push(`  }${oi < owners.length - 1 ? "," : ""}`);
    });
    lines.push("}");
    return lines.join("\n");
  }

  /** Completions and validation for profile.json and mod.json in the editor. */
  installJsonSchemas(modIds: string[]) {
    const core = { type: "object", properties: this.ownerJsonProperties("core"), additionalProperties: true };
    const defaultsSchema = {
      type: "object",
      description: "Defaults this mod sets for the editor (\"core\") or other mods (by id), as in profile.json → settings. The user's own values still win.",
      properties: { core, ...Object.fromEntries([...this.schemas.keys()].filter((o) => o !== "core").map((o) => [o, { type: "object", properties: this.ownerJsonProperties(o) }])) },
      additionalProperties: true,
    };
    try {
      monaco.json.jsonDefaults.setDiagnosticsOptions({
        ...monaco.json.jsonDefaults.diagnosticsOptions,
        validate: true,
        allowComments: true,
        trailingCommas: "ignore",
        enableSchemaRequest: false,
        schemas: [
          { uri: "aicode://schemas/profile.json", fileMatch: ["profile.json", "**/profile.json", "*/profile.json"], schema: this.profileJsonSchema(modIds) },
          {
            uri: "aicode://schemas/mod-config.json",
            fileMatch: ["mod.json", "**/mod.json", "*/mod.json"],
            schema: { type: "object", properties: { contributes: { type: "object", properties: { configurationDefaults: defaultsSchema } } } },
          },
        ],
      });
    } catch (e) {
      console.warn("json schemas", e);
    }
  }
}

export const config = new ConfigService();

// ---------- the editor's own settings ----------

const e = (...values: (string | [string, string])[]) => values.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v }));
const isMac = navigator.platform.toLowerCase().includes("mac");

/** Parts of the window, by name: what `workbench.hide`, `workbench.partOpacity` and custom CSS use. */
export const PART_NAMES = [
  "titleBar", "titleBar.nav", "titleBar.commandCenter", "titleBar.items", "titleBar.layoutControls", "titleBar.pin",
  "activityBar", "activityBar.badge", "sideBar", "sideBar.header", "secondarySideBar", "secondarySideBar.header", "panel", "panel.header",
  "editor", "tabs", "tab", "tab.icon", "tab.close", "tab.actions", "breadcrumbs", "editorSide", "watermark",
  "statusBar", "statusBar.item", "sash",
];

/** Parts whose background `workbench.partOpacity` and `workbench.partBackgrounds` can change. */
export const SURFACE_PARTS = ["window", "titleBar", "activityBar", "sideBar", "secondarySideBar", "panel", "editor", "tabs", "statusBar"] as const;

const VIBRANCY = [
  "none", "sidebar", "underWindowBackground", "windowBackground", "hudWindow", "fullScreenUI", "titlebar", "headerView",
  "menu", "popover", "sheet", "contentBackground", "underPageBackground", "tooltip", "selection", "appearanceBased", "light", "dark", "mediumLight", "ultraDark",
];

const backgroundJson = {
  type: "object",
  properties: {
    image: { type: "string", description: "An absolute path (~ works), a data: URL or an https URL." },
    size: { type: "string", description: "CSS background-size: cover, contain, auto, 50%…", default: "cover" },
    position: { type: "string", description: "CSS background-position.", default: "center" },
    repeat: { type: "string", default: "no-repeat" },
    opacity: { type: "number", minimum: 0, maximum: 1, description: "How visible the image is.", default: 1 },
    blur: { type: "number", minimum: 0, description: "Blur in pixels.", default: 0 },
    color: { type: "string", description: "A color painted under the image." },
  },
};

const layoutJson = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      title: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
      alwaysOnTop: { type: "boolean" },
      options: { type: "object", description: "Customize Layout choices: activityBar, statusBar, sidebarSide, panelAlign, quickInput, density." },
      parts: { type: "object", properties: { sidebar: { type: "boolean" }, secondary: { type: "boolean" }, panel: { type: "boolean" } }, description: "Which parts are open when the window opens." },
      sizes: { type: "object", properties: { sidebar: { type: "number" }, secondary: { type: "number" }, panel: { type: "number" } } },
      center: { type: "string", description: "A view shown in place of the editor (e.g. \"agents.chat\")." },
      views: { type: "object", additionalProperties: { enum: ["sidebar", "secondary", "panel", "center", "hidden", "floating"] }, description: "Where each view goes in this window." },
      hide: { type: "array", items: { type: "string" }, description: "Parts hidden in this window (see workbench.hide)." },
      settings: { type: "object", description: "Core settings for this window only (they go over yours)." },
    },
  },
};

const itemJson = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      icon: { type: "string", description: "A codicon name." },
      text: { type: "string" },
      title: { type: "string", description: "Tooltip." },
      command: { type: "string" },
      args: { type: "array" },
      align: { enum: ["left", "center", "right"] },
      order: { type: "number" },
    },
    required: ["command"],
  },
};

export const CORE_SCHEMA: Record<string, SettingSchema> = {
  // ----- Editor -----
  "editor.fontSize": { section: "Editor", type: "number", title: "Font Size", default: isMac ? 12 : 14, min: 6, max: 72 },
  "editor.fontFamily": { section: "Editor", type: "string", title: "Font Family", default: "", description: "Leave empty for Menlo / SF Mono." },
  "editor.fontWeight": { section: "Editor", type: "string", title: "Font Weight", default: "normal", enum: e("normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900") },
  "editor.fontLigatures": { section: "Editor", type: "boolean", title: "Font Ligatures", default: false, description: "For fonts that have them (Fira Code, JetBrains Mono…)." },
  "editor.letterSpacing": { section: "Editor", type: "number", title: "Letter Spacing", default: 0, min: -5, max: 20 },
  "editor.lineHeight": { section: "Editor", type: "number", title: "Line Height", default: 0, min: 0, max: 100, description: "0 picks one from the font size." },
  "editor.wordWrap": { section: "Editor", type: "string", title: "Word Wrap", default: "off", enum: e("off", "on", ["bounded", "At the window edge or 80 columns"]) },
  "editor.lineNumbers": { section: "Editor", type: "string", title: "Line Numbers", default: "on", enum: e("on", "relative", "interval", "off") },
  "editor.renderWhitespace": { section: "Editor", type: "string", title: "Show Whitespace", default: "selection", enum: e(["none", "Never"], ["selection", "In the selection"], ["boundary", "Except single spaces"], ["trailing", "Trailing only"], ["all", "Always"]) },
  "editor.renderControlCharacters": { section: "Editor", type: "boolean", title: "Show Control Characters", default: true },
  "editor.smoothScrolling": { section: "Editor", type: "boolean", title: "Smooth Scrolling", default: true },
  "editor.scrollBeyondLastLine": { section: "Editor", type: "boolean", title: "Scroll Beyond Last Line", default: false },
  "editor.mouseWheelZoom": { section: "Editor", type: "boolean", title: "Zoom with ⌘ + Wheel", default: false },
  "editor.padding.top": { section: "Editor", type: "number", title: "Padding Top", default: 4, min: 0, max: 200 },
  "editor.padding.bottom": { section: "Editor", type: "number", title: "Padding Bottom", default: 0, min: 0, max: 400 },
  "editor.stickyScroll": { section: "Editor", type: "boolean", title: "Sticky Scroll", default: true, description: "Keeps the enclosing function or block visible at the top." },
  "editor.bracketPairColorization": { section: "Editor", type: "boolean", title: "Colored Bracket Pairs", default: true },
  "editor.matchBrackets": { section: "Editor", type: "string", title: "Highlight Matching Brackets", default: "always", enum: e("always", "near", "never") },
  "editor.dragAndDrop": { section: "Editor", type: "boolean", title: "Drag and Drop Selections", default: true },
  "editor.links": { section: "Editor", type: "boolean", title: "Clickable Links", default: true },
  "editor.colorDecorators": { section: "Editor", type: "boolean", title: "Color Swatches", default: true, description: "A small square before CSS colors." },
  "editor.quickSuggestions": { section: "Editor", type: "boolean", title: "Suggestions as You Type", default: true },
  "editor.suggestOnTriggerCharacters": { section: "Editor", type: "boolean", title: "Suggestions after . and other trigger characters", default: true },
  "editor.hover.enabled": { section: "Editor", type: "boolean", title: "Hover Information", default: true },
  "editor.hover.delay": { section: "Editor", type: "number", title: "Hover Delay (ms)", default: 300, min: 0, max: 10000 },
  "editor.codeLens": { section: "Editor", type: "boolean", title: "Code Lens", default: true },
  "editor.inlayHints": { section: "Editor", type: "string", title: "Inlay Hints", default: "on", enum: e("on", "off", "onUnlessPressed", "offUnlessPressed") },
  "editor.occurrencesHighlight": { section: "Editor", type: "boolean", title: "Highlight Occurrences", default: true },
  "editor.selectionHighlight": { section: "Editor", type: "boolean", title: "Highlight Matches of the Selection", default: true },
  "editor.monacoOptions": {
    section: "Editor",
    type: "object",
    title: "Raw Editor Options",
    default: {},
    description: "Any Monaco editor option, passed as is (https://microsoft.github.io/monaco-editor/docs.html#interfaces/editor.IEditorOptions.html). Goes over everything above.",
  },

  // ----- Cursor -----
  "editor.cursorStyle": { section: "Cursor", type: "string", title: "Cursor Style", default: "line", enum: e("line", "block", "underline", "line-thin", "block-outline", "underline-thin") },
  "editor.cursorBlinking": { section: "Cursor", type: "string", title: "Cursor Blinking", default: "smooth", enum: e("blink", "smooth", "phase", "expand", "solid") },
  "editor.cursorWidth": { section: "Cursor", type: "number", title: "Cursor Width", default: 0, min: 0, max: 20, description: "In pixels, for the line style. 0 is the default width." },
  "editor.cursorSmoothCaretAnimation": { section: "Cursor", type: "string", title: "Smooth Caret Animation", default: "on", enum: e("off", ["explicit", "Only on clicks and arrow keys"], "on") },
  "editor.cursorColor": { section: "Cursor", type: "string", format: "color", title: "Cursor Color", default: "", description: "Any CSS color (#ff79c6). Empty: the theme's." },
  "editor.cursorSurroundingLines": { section: "Cursor", type: "number", title: "Lines Kept Around the Cursor", default: 0, min: 0, max: 50 },
  "editor.multiCursorModifier": { section: "Cursor", type: "string", title: "Multi-Cursor Modifier", default: "alt", enum: e(["alt", "⌥ click adds a cursor"], ["ctrlCmd", "⌘ click adds a cursor"]) },

  // ----- Gutter, minimap and markers -----
  "editor.minimap": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Minimap", default: true },
  "editor.minimap.side": { section: "Gutter, Minimap and Markers", type: "string", title: "Minimap Side", default: "right", enum: e("right", "left") },
  "editor.minimap.size": { section: "Gutter, Minimap and Markers", type: "string", title: "Minimap Size", default: "proportional", enum: e("proportional", "fill", "fit") },
  "editor.minimap.scale": { section: "Gutter, Minimap and Markers", type: "number", title: "Minimap Scale", default: 1, min: 1, max: 3 },
  "editor.minimap.renderCharacters": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Minimap Characters", default: true, description: "Off: blocks of color instead of letters." },
  "editor.minimap.showSlider": { section: "Gutter, Minimap and Markers", type: "string", title: "Minimap Slider", default: "mouseover", enum: e("mouseover", "always") },
  "editor.glyphMargin": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Glyph Margin", default: true, description: "The column for breakpoints and markers left of the line numbers." },
  "editor.folding": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Folding", default: true },
  "editor.showFoldingControls": { section: "Gutter, Minimap and Markers", type: "string", title: "Folding Arrows", default: "mouseover", enum: e("always", "mouseover", "never") },
  "editor.renderLineHighlight": { section: "Gutter, Minimap and Markers", type: "string", title: "Current Line Highlight", default: "all", enum: e("none", "gutter", "line", "all") },
  "editor.rulers": { section: "Gutter, Minimap and Markers", type: "array", title: "Rulers", default: [], description: "Vertical lines at these columns, e.g. [80, 120].", json: { items: { type: "number" } } },
  "editor.guides.indentation": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Indent Guides", default: true },
  "editor.guides.bracketPairs": { section: "Gutter, Minimap and Markers", type: "string", title: "Bracket Pair Guides", default: "active", enum: e(["true", "Always"], ["active", "For the active pair"], ["false", "Never"]) },
  "editor.overviewRuler": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Markers in the Scroll Bar", default: true, description: "Errors, search hits and changes shown along the scroll bar." },
  "editor.overviewRulerBorder": { section: "Gutter, Minimap and Markers", type: "boolean", title: "Scroll Bar Marker Border", default: true },
  "editor.lightbulb": { section: "Gutter, Minimap and Markers", type: "string", title: "Code Action Lightbulb", default: "onCode", enum: e("on", "onCode", "off") },
  "editor.scrollbar.vertical": { section: "Gutter, Minimap and Markers", type: "string", title: "Vertical Scroll Bar", default: "auto", enum: e("auto", "visible", "hidden") },
  "editor.scrollbar.horizontal": { section: "Gutter, Minimap and Markers", type: "string", title: "Horizontal Scroll Bar", default: "auto", enum: e("auto", "visible", "hidden") },
  "editor.scrollbar.size": { section: "Gutter, Minimap and Markers", type: "number", title: "Scroll Bar Size", default: 14, min: 0, max: 40 },

  // ----- Files -----
  "files.autoSave": { section: "Files", type: "string", title: "Auto Save", default: "off", description: "Saves files that are on disk by themselves (File ▸ Auto Save turns it on and off).", enum: e(["off", "Off"], ["afterDelay", "After a delay"], ["onFocusChange", "When the editor loses focus"], ["onWindowChange", "When the window loses focus"]) },
  "files.autoSaveDelay": { section: "Files", type: "number", title: "Auto Save Delay", default: 1000, min: 0, max: 60000, description: "Milliseconds after the last change, when Auto Save is \"After a delay\"." },

  // ----- Workbench -----
  theme: { section: "Workbench", type: "string", title: "Color Theme", default: "aicode-dark", enum: [] },
  "workbench.previewEditors": { section: "Workbench", type: "boolean", title: "Preview Editors", default: true, description: "A single click opens a file in a tab the next one replaces (shown in italics)." },
  "workbench.editor.useModal": { section: "Workbench", type: "string", title: "Open Pages in a Modal", default: "some", description: "Settings, Mods, Keyboard Shortcuts and Profiles open over the editor, like VS Code.", enum: e(["some", "Settings, Mods, Shortcuts and Profiles"], ["off", "Off (always in a tab)"]) },
  "workbench.iconTheme": { section: "Workbench", type: "string", title: "File Icon Theme", default: "seti", description: "One of the icon themes mods contribute (File Icon Themes: seti, vscode-icons, vscode-icons-nestjs…, or vscode-icons-auto to follow each folder's stack), or \"none\" for plain icons." },
  "workbench.iconSize": { section: "Workbench", type: "string", title: "Icon Size", default: "normal", description: "Of the activity bar on the left and the lists in side bars.", enum: e(["normal", "Normal (VS Code size)"], "large", "larger") },
  "workbench.fontFamily": { section: "Workbench", type: "string", title: "UI Font Family", default: "", description: "The font of everything but the editor. Empty: the system font." },
  "workbench.fontSize": { section: "Workbench", type: "number", title: "UI Font Size", default: 13, min: 9, max: 24 },
  "workbench.cornerRadius": { section: "Workbench", type: "number", title: "Corner Radius", default: 8, min: 0, max: 24, description: "Of cards, menus and dialogs." },
  "workbench.titleBar.height": { section: "Workbench", type: "number", title: "Title Bar Height", default: 35, min: 28, max: 80 },
  "workbench.statusBar.height": { section: "Workbench", type: "number", title: "Status Bar Height", default: 28, min: 16, max: 60 },
  "workbench.breadcrumbs": { section: "Workbench", type: "boolean", title: "Breadcrumbs", default: true, description: "The path of the file under the tabs." },
  "workbench.activityBar.indicator": { section: "Workbench", type: "string", title: "Active Activity Indicator", default: "background", enum: e(["background", "A filled square"], ["bar", "A bar at the edge"], ["none", "None"]) },
  "workbench.badges": { section: "Workbench", type: "boolean", title: "Badges", default: true, description: "Counts on the activity bar icons." },
  "workbench.scrollbars.size": { section: "Workbench", type: "number", title: "Scroll Bar Size (lists and pages)", default: 10, min: 0, max: 24 },
  "workbench.scrollbars.visibility": { section: "Workbench", type: "string", title: "Scroll Bars", default: "hover", enum: e(["hover", "While the pointer is over the list"], ["always", "Always"], ["hidden", "Never"]) },
  "workbench.focusOutline": { section: "Workbench", type: "boolean", title: "Focus Outline", default: true, description: "A colored outline around the focused button or field." },
  animations: { section: "Workbench", type: "boolean", title: "Animations", default: true, description: "Also off while macOS Reduce motion is on." },

  // ----- Tabs -----
  "workbench.tabs.shape": { section: "Tabs", type: "string", title: "Tab Shape", default: "connected", enum: e(["connected", "Connected to the editor (VS Code)"], ["square", "Square, classic"], ["rounded", "Rounded cards"], ["pill", "Pills"], ["underline", "Text with an underline"]) },
  "workbench.tabs.height": { section: "Tabs", type: "number", title: "Tab Bar Height", default: 32, min: 20, max: 60 },
  "workbench.tabs.minWidth": { section: "Tabs", type: "number", title: "Tab Minimum Width", default: 80, min: 0, max: 400 },
  "workbench.tabs.maxWidth": { section: "Tabs", type: "number", title: "Tab Maximum Width", default: 220, min: 40, max: 800 },
  "workbench.tabs.gap": { section: "Tabs", type: "number", title: "Space Between Tabs", default: 0, min: 0, max: 20 },
  "workbench.tabs.closeButton": { section: "Tabs", type: "string", title: "Close Button", default: "right", enum: e("right", "left", ["hidden", "Hidden (⌘W or middle click)"]) },
  "workbench.tabs.showIcons": { section: "Tabs", type: "boolean", title: "File Icons in Tabs", default: true },
  "workbench.tabs.activeIndicator": { section: "Tabs", type: "string", title: "Active Tab Indicator", default: "top", enum: e("top", "bottom", "none") },
  "workbench.tabs.wrap": { section: "Tabs", type: "boolean", title: "Wrap Tabs", default: false, description: "Several rows of tabs instead of scrolling." },
  "workbench.tabs.dragToWindow": { section: "Tabs", type: "boolean", title: "Drag a Tab Out to a New Window", default: true },
  "workbench.tabs.visible": { section: "Tabs", type: "boolean", title: "Show the Tab Bar", default: true },

  // ----- Tooltips -----
  "workbench.tooltips.style": { section: "Tooltips", type: "string", title: "Tooltips", default: "custom", enum: e(["custom", "AICode's (themed)"], ["native", "macOS"], ["off", "None"]) },
  "workbench.tooltips.delay": { section: "Tooltips", type: "number", title: "Tooltip Delay (ms)", default: 500, min: 0, max: 5000 },
  "workbench.tooltips.maxWidth": { section: "Tooltips", type: "number", title: "Tooltip Maximum Width", default: 360, min: 100, max: 1000 },

  // ----- Window and transparency -----
  "window.restoreOnStartup": { section: "Window and Transparency", type: "string", title: "Restore on Startup", default: "none", applies: "reopen", description: "What AICode opens when it starts. \"none\": one empty window — the last session waits for File: Reopen Last Session (offered when it had unsaved text). \"all\": every window with its files and folder, as you left them.", enum: e(["none", "Nothing (a clean start)"], ["all", "The last session"]) },
  "window.transparent": { section: "Window and Transparency", type: "boolean", title: "Transparent Window", default: false, applies: "reopen", description: "Lets what is behind the window show through the parts you make see-through (Part Opacity, Background). Needs the window reopened." },
  "window.vibrancy": { section: "Window and Transparency", type: "string", title: "Background Material (macOS)", default: "none", description: "macOS's frosted glass behind the window. Needs Transparent Window.", enum: VIBRANCY.map((v) => ({ value: v, label: v })) },
  "workbench.opacity": { section: "Window and Transparency", type: "number", title: "Opacity of Every Part", default: 1, min: 0, max: 1, description: "0 to 1, multiplies each part's own opacity (Part Opacity): one knob for the whole window. Backgrounds only — text stays solid." },
  "workbench.partOpacity": {
    section: "Window and Transparency",
    type: "object",
    title: "Part Opacity",
    default: {},
    description: `Opacity of one part's background, 0 to 1: ${SURFACE_PARTS.join(", ")} ("window" is what shows between the parts). E.g. { "window": 0, "sideBar": 0.5 }.`,
    json: { properties: Object.fromEntries(SURFACE_PARTS.map((p) => [p, { type: "number", minimum: 0, maximum: 1 }])) },
  },
  "window.background": { section: "Window and Transparency", type: "object", title: "Window Background", default: {}, description: "An image or color behind the whole window: { \"image\": \"~/Pictures/x.jpg\", \"opacity\": 0.3, \"blur\": 4 }. Make parts see-through to show it.", json: backgroundJson },
  "workbench.partBackgrounds": {
    section: "Window and Transparency",
    type: "object",
    title: "Part Backgrounds",
    default: {},
    description: `An image behind one part, under its (see-through) color: { "editor": { "image": "~/x.png", "opacity": 0.15 } }. Parts: ${SURFACE_PARTS.join(", ")}.`,
    json: { properties: Object.fromEntries(SURFACE_PARTS.map((p) => [p, backgroundJson])) },
  },
  "window.alwaysOnTop": { section: "Window and Transparency", type: "boolean", title: "Always on Top", default: false, description: "Keep every AICode window above other apps." },
  "window.shadow": { section: "Window and Transparency", type: "boolean", title: "Window Shadow", default: true },
  "window.pinButton": { section: "Window and Transparency", type: "string", title: "Pin Button", default: "auto", description: "A pin in the title bar that keeps the window on top.", enum: e(["auto", "In windows opened from a tab or a view"], ["always", "Always"], ["never", "Never"]) },

  // ----- Customize anything -----
  "workbench.colorCustomizations": {
    section: "Customize Anything",
    type: "object",
    title: "Color Customizations",
    default: {},
    description: "Theme colors over the theme's, by key (\"tab.activeBackground\": \"#282a36\"). Per theme: \"[aicode-light]\": { … }. Keys are VS Code's theme color names.",
  },
  "editor.tokenColorCustomizations": {
    section: "Customize Anything",
    type: "object",
    title: "Syntax Color Customizations",
    default: {},
    description: "comments, strings, keywords, numbers, types, functions, variables: a color or { foreground, fontStyle }; \"textMateRules\": [ { scope, settings } ]. Per theme: \"[theme-id]\": { … }.",
  },
  "workbench.hide": {
    section: "Customize Anything",
    type: "array",
    title: "Hidden Parts",
    default: [],
    description: `Parts to hide: ${PART_NAMES.join(", ")}. "css:<selector>" hides anything else.`,
    json: { items: { anyOf: [{ enum: PART_NAMES }, { type: "string", pattern: "^css:" }] } },
  },
  "workbench.hiddenViews": { section: "Customize Anything", type: "array", title: "Hidden Views", default: [], description: "Views to take off the window without turning their mod off, by id (\"scm\", \"search\")." },
  "workbench.cssVariables": {
    section: "Customize Anything",
    type: "object",
    title: "CSS Variables",
    default: {},
    description: "Any CSS variable of the workbench (\"--tabs-h\": \"28px\", \"--aicode-focusBorder\": \"hotpink\").",
  },
  "workbench.customCSS": { section: "Customize Anything", type: "string", title: "Custom CSS", default: "", description: "CSS added to the window, after everything else. Target parts with [data-part=\"tab\"] and so on. An array of strings also works.", json: { type: ["string", "array"], items: { type: "string" } } },
  "workbench.customCSSFiles": { section: "Customize Anything", type: "array", title: "Custom CSS Files", default: [], description: "Paths of .css files to add (~ works). Reapplied when you save them.", json: { items: { type: "string" } } },
  "workbench.titleBar.items": { section: "Customize Anything", type: "array", title: "Title Bar Buttons", default: [], description: "Your own buttons: [{ \"icon\": \"rocket\", \"title\": \"Deploy\", \"command\": \"…\", \"align\": \"center\" }].", json: itemJson },
  "workbench.statusBar.items": { section: "Customize Anything", type: "array", title: "Status Bar Items", default: [], description: "Your own status bar items: [{ \"icon\": \"terminal\", \"text\": \"Build\", \"command\": \"…\", \"align\": \"left\" }].", json: itemJson },
  "workbench.windowLayouts": {
    section: "Customize Anything",
    type: "object",
    title: "Window Layouts",
    default: {},
    description: "Named window arrangements, opened with Open Window with Layout… or a { \"type\": \"window\", \"layout\": \"name\" } action: which views go where, which parts show, size, always on top, and settings for that window only.",
    json: layoutJson,
  },

  // ----- Updates -----
  "update.checkOnStartup": { section: "Updates", type: "boolean", title: "Check on Startup", default: false, description: "Ask GitHub for a newer AICode a few seconds after it starts (once per launch). Off: AICode only looks when you click Check for Updates." },

  // ----- kept by the workbench itself -----
  "workbench.layout": { type: "object", default: {}, hidden: true, title: "Layout", description: "Customize Layout's choices (written by the workbench)." },
  "workbench.viewPlacement": {
    type: "object",
    default: {},
    hidden: true,
    title: "View Placement",
    description: 'Where views go: { "<view id>": { "location": "sidebar" | "secondary" | "panel", "order": 10, "float": true | { "x", "y", "w", "h", "open" } } }. Written by the workbench when you drag views; a mod can set defaults with configurationDefaults.',
  },
};

config.registerSchema("core", CORE_SCHEMA);
