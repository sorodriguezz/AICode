// The mod host. Reads the enabled mods' manifests, puts what they declare on screen without running
// them (views, commands, keybindings, themes), and loads a mod's code only when one of its
// activation events fires:
//
//   onStartup            when the window opens
//   onView:<view id>     when its view is first shown
//   onCommand:<id>       when its command is first run
//   onLanguage:<id>      when a file of that language is first opened
//   onFolder             when a folder is opened
//
// Each mod gets its own `ctx` — the whole API it may use, with its id attached to every call.

import * as monaco from "monaco-editor";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "./dialog";
import { NATIVE_LANGUAGE, nativeEval, nativeOpen, nativeSpawn } from "./native";
import { invoke, listen, onStream, ModInfo } from "./ipc";
import * as commands from "./commands";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Workbench, ViewProvider, StatusItem, TitleItem, ViewLocation, LayoutOptions, type ActivityItem, type FloatRect, type EdgeSpec, type DropTargetSpec, type DragEvent, type ViewMove } from "./workbench";
import { motionEnabled, play, leave, flip, onDidChangeMotion } from "./motion";
import { addMenuItem, menuContributions, prepareMenuBarItem, type MenuContribution } from "./menus";
import { setIcon, iconOverrides, type IconSource } from "./icons";
import { EditorService, EditProposal, CustomTabSpec, TitleAction, EditorType, SidePaneSpec, BreadcrumbProvider } from "./editor";
import { Workspace } from "./workspace";
import { notify, pick, inputBox, confirm, contextMenu, QuickItem, MenuItem } from "./widgets";
import { h, icon, iconButton, clear, basename, dirname, joinPath, isAbsolute, pathRoot, uiPath, fileIcon, fileIconColor, Disposable, toDisposable } from "./ui";
import { ThemeEntry, VsTheme } from "./theme";
import type { GrammarSource } from "./textmate";
import { Emitter } from "./events";
import { byLayer, insertStyle, setModSources } from "./layers";
import { Declarative, checkActions } from "./declarative";
import { fileIconEl, folderIconEl, registerIconTheme, drawIconThemeWith } from "./fileIcons";
import { config, type SettingSchema, type Values, type Change } from "./config";
import { openWindow, layouts, type WindowSpec } from "./windows";

export type ModState = "idle" | "activating" | "active" | "failed";

/** What main.ts gives the host for the window API (the window's own spec, pinning, reopening). */
export interface WindowServices {
  current: () => WindowSpec | null;
  setPinned: (on: boolean) => Promise<void>;
  isOnTop: () => boolean;
  reopen: () => Promise<void>;
  detachView: (viewId: string) => Promise<void>;
}

const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** A mod's settings declarations (contributes.settings) as configuration schema. */
export function modSchema(declared: unknown): Record<string, SettingSchema> {
  const out: Record<string, SettingSchema> = {};
  if (!isPlainObject(declared)) return out;
  for (const [key, d] of Object.entries(declared)) {
    if (!isPlainObject(d)) continue;
    const type = ["number", "boolean", "array", "object"].includes(d.type) ? d.type : "string";
    out[key] = {
      type,
      default: d.default ?? (type === "boolean" ? false : type === "number" ? 0 : type === "array" ? [] : type === "object" ? {} : ""),
      title: d.title ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c: string) => c.toUpperCase()),
      description: d.description,
      enum: Array.isArray(d.enum) ? d.enum.map((v: unknown, i: number) => ({ value: v, label: Array.isArray(d.enumLabels) ? String(d.enumLabels[i] ?? v) : String(v) })) : undefined,
      min: d.minimum ?? d.min,
      max: d.maximum ?? d.max,
      hidden: d.hidden,
      format: d.format === "color" ? "color" : undefined,
    };
  }
  return out;
}

/**
 * A mod's `configurationDefaults` as a configuration layer. It is written like profile.json's
 * `settings` ({ "core": {…}, "<mod id>": {…} }); keys that are not an owner are core settings, so
 * { "editor.cursorColor": "#f0f" } works too. `contributes.windowLayouts` joins core
 * "workbench.windowLayouts".
 */
export function modDefaults(info: ModInfo, owners: Set<string>): Values {
  const out: Values = {};
  const raw = info.contributes?.configurationDefaults;
  if (isPlainObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if ((k === "core" || owners.has(k)) && isPlainObject(v)) out[k] = { ...(out[k] ?? {}), ...v };
      else (out.core ??= {})[k] = v;
    }
  }
  const layoutsOf = info.contributes?.windowLayouts;
  if (isPlainObject(layoutsOf)) {
    const core = (out.core ??= {});
    core["workbench.windowLayouts"] = { ...(isPlainObject(core["workbench.windowLayouts"]) ? core["workbench.windowLayouts"] : {}), ...layoutsOf };
  }
  return out;
}

/** How a file shows in lists (the explorer, open editors): a letter, a theme color, a tooltip. */
export interface Decoration {
  badge?: string;
  /** A theme color key, such as "gitDecoration.modifiedResourceForeground". */
  color?: string;
  tooltip?: string;
  /** Shown faded (ignored files). */
  faded?: boolean;
}
type DecorationProvider = (path: string) => Decoration | undefined;

/** Every mod's decorations, merged: later providers fill in what earlier ones left out. */
export const decorations = new (class {
  providers = new Set<DecorationProvider>();
  onDidChange = new Emitter<void>();
  get(path: string): Decoration | undefined {
    let out: Decoration | undefined;
    for (const p of this.providers) {
      const d = p(path);
      if (d) out = { ...d, ...out };
    }
    return out;
  }
})();

/** fs://change from Rust, dispatched to the watchers of each folder. */
const watchers = new Map<string, Set<() => void>>();
let watchListening: Promise<unknown> | null = null;
function watchDir(dir: string, fn: () => void, modId: string): Disposable {
  watchListening ??= listen<{ dir: string }>("fs://change", (e) => watchers.get(e.payload.dir)?.forEach((f) => f()));
  let set = watchers.get(dir);
  if (!set) watchers.set(dir, (set = new Set()));
  set.add(fn);
  const id = invoke<number>("fs_watch", { modId, path: dir }).catch(() => null);
  return toDisposable(() => {
    set!.delete(fn);
    if (!set!.size) watchers.delete(dir);
    id.then((i) => i != null && invoke("fs_unwatch", { id: i }));
  });
}

interface Loaded {
  info: ModInfo;
  state: ModState;
  error?: string;
  exports?: unknown;
  activation?: Promise<unknown>;
  subscriptions: Disposable[];
  activatedAt?: number;
  loadMs?: number;
}

export class ModHost {
  private mods = new Map<string, Loaded>();
  readonly themes: ThemeEntry[] = [];
  /** TextMate grammars by scope name, from every enabled mod. */
  private grammars = new Map<string, GrammarSource>();
  readonly onDidChangeState = new Emitter<string>();
  private mcpHandler: ((call: { callId: number; name: string; arguments: any }) => Promise<unknown>) | null = null;
  readonly declarative: Declarative;
  /** Set by main.ts once the window knows what it is. */
  windowServices: WindowServices | null = null;
  /** Mods asked before this window closes (`ctx.window.onWillClose`). */
  private closeHooks = new Set<(info: { lastWindow: boolean }) => unknown>();
  /** Menu bar icons of this window's mods, by "<mod id>:<id>". */
  private trays = new Map<string, { onClick?: (e: TrayClick) => void; onDoubleClick?: (e: TrayClick) => void; items: Map<string, TrayMenuItem> }>();
  private trayListening: Promise<unknown> | null = null;
  readonly onDidReopen = new Emitter<{ hasVisibleWindows: boolean }>();
  /** `emit(channel, data)` of native contexts, by context id. */
  private nativeHandlers = new Map<number, (channel: string, data: unknown) => void>();
  private nativeListening: Promise<unknown> | null = null;
  /** Global shortcuts of this window's mods, by accelerator. */
  private shortcuts = new Map<string, { pressed?: () => void; released?: () => void }>();
  private shortcutListening: Promise<unknown> | null = null;

  private listenNative() {
    this.nativeListening ??= listen<{ id: number; channel: string; data: unknown }>("native://event", (e) => {
      const fn = this.nativeHandlers.get(e.payload.id);
      if (fn) {
        try {
          fn(e.payload.channel, e.payload.data);
        } catch (err) {
          console.error(err);
        }
      }
    });
    return this.nativeListening;
  }

  private listenShortcuts() {
    this.shortcutListening ??= listen<{ accelerator: string; state: "pressed" | "released" }>("shortcut://event", (e) => {
      const s = this.shortcuts.get(e.payload.accelerator);
      try {
        s?.[e.payload.state]?.();
      } catch (err) {
        console.error(err);
      }
    });
    return this.shortcutListening;
  }

  /**
   * Whether the window may close: every mod's onWillClose is asked, and one returning false keeps
   * it open (it may have hidden it instead, to keep working in the background).
   */
  async allowClose(info: { lastWindow: boolean }): Promise<boolean> {
    for (const hook of [...this.closeHooks]) {
      try {
        if ((await hook(info)) === false) return false;
      } catch (e) {
        console.error("onWillClose", e);
      }
    }
    return true;
  }

  private listenTray() {
    this.trayListening ??= listen<{ key: string; kind: string; item?: string; button?: string; x?: number; y?: number }>("tray://event", (e) => {
      const t = this.trays.get(e.payload.key);
      if (!t) return;
      const p = e.payload;
      if (p.kind === "menu" && p.item) {
        const item = t.items.get(p.item);
        if (item?.run) Promise.resolve(item.run()).catch((err) => console.error(err));
        else if (item?.command) commands.execute(item.command, ...(item.args ?? [])).catch((err) => console.error(err));
      } else if (p.kind === "click") t.onClick?.({ button: p.button as TrayClick["button"], x: p.x ?? 0, y: p.y ?? 0 });
      else if (p.kind === "doubleClick") t.onDoubleClick?.({ button: p.button as TrayClick["button"], x: p.x ?? 0, y: p.y ?? 0 });
    });
    return this.trayListening;
  }

  constructor(private wb: Workbench, private editors: EditorService, private workspace: Workspace) {
    listen<{ hasVisibleWindows: boolean }>("app://reopen", (e) => this.onDidReopen.fire(e.payload)).catch(() => {});
    this.declarative = new Declarative({
      wb,
      editors,
      workspace,
      modExports: (id) => (this.mods.has(id) ? this.activate(id) : Promise.resolve(undefined)),
      isEnabled: (id) => this.mods.has(id),
    });
    commands.setLazyActivator(async (commandId) => {
      const owner = [...this.mods.values()].find((m) => m.info.activation.includes(`onCommand:${commandId}`) || (m.info.contributes?.commands ?? []).some((c: any) => c.id === commandId));
      if (!owner) return false;
      await this.activate(owner.info.id);
      return true;
    });
    wb.viewActivator = async (viewId) => {
      const owner = [...this.mods.values()].find((m) => (m.info.contributes?.views ?? []).some((v: any) => v.id === viewId));
      if (owner) await this.activate(owner.info.id);
    };
    const languagesSeen = new Set<string>();
    editors.onDidChangeActive.event((info) => {
      if (!info?.language || languagesSeen.has(info.language)) return;
      languagesSeen.add(info.language);
      this.fire(`onLanguage:${info.language}`);
    });
    workspace.onDidChange.event((folder) => folder && this.fire("onFolder"));
    listen<{ callId: number; name: string; arguments: any }>("mcp://call", async (e) => {
      let result: unknown;
      try {
        result = this.mcpHandler ? await this.mcpHandler(e.payload) : { isError: true, content: [{ type: "text", text: "no mod answers MCP calls" }] };
      } catch (err) {
        result = { isError: true, content: [{ type: "text", text: String(err) }] };
      }
      invoke("mcp_reply", { callId: e.payload.callId, result });
    });
  }

  list(): (ModInfo & { state: ModState; error?: string; loadMs?: number })[] {
    return [...this.mods.values()].map((m) => ({ ...m.info, state: m.state, error: m.error, loadMs: m.loadMs }));
  }

  get(id: string) {
    return this.mods.get(id);
  }

  /** Reads manifests and lays out every enabled mod's declarations. Loads no mod code. */
  async load(list?: ModInfo[]): Promise<ModInfo[]> {
    const all = list ?? (await invoke<ModInfo[]>("mods_list"));
    setModSources(all);
    // Declarations go on screen in layer order (layers.ts), so a user's mod lands over a bundled one.
    for (const info of byLayer(all.filter((m) => m.enabled && !m.problems.length), (m) => m.id)) {
      const loaded: Loaded = { info, state: "idle", subscriptions: [] };
      this.mods.set(info.id, loaded);
      this.contribute(loaded);
    }
    for (const info of all.filter((m) => m.enabled && m.problems.length)) {
      notify("warning", `${info.name} was not loaded: ${info.problems.join("; ")}`);
    }
    for (const m of this.mods.values()) {
      const problems = checkActions(m.info);
      if (problems.length) notify("warning", `${m.info.name}: ${problems.join("; ")}`);
    }
    return all;
  }

  /** The configuration layers of the enabled mods (their configurationDefaults), in load order. */
  static configurationLayers(all: ModInfo[]): { mod: string; values: Values }[] {
    const owners = new Set(all.map((m) => m.id));
    setModSources(all);
    // In layer order (layers.ts): bundled mods, then the user's; the user's configuration goes over all of them.
    return byLayer(all.filter((m) => m.enabled && !m.problems.length), (m) => m.id).map((m) => ({ mod: m.id, values: modDefaults(m, owners) })).filter((l) => Object.keys(l.values).length);
  }

  private contribute(m: Loaded) {
    const c = m.info.contributes ?? {};
    const declared = modSchema(c.settings);
    if (Object.keys(declared).length) config.registerSchema(m.info.id, declared);
    // Stylesheets: a file of the mod, or CSS written in mod.json. They stay while the mod is on.
    for (const st of Array.isArray(c.styles) ? c.styles : []) {
      const path = typeof st === "string" ? st : st?.path;
      const css = typeof st === "object" && st ? st.css : undefined;
      if (path) m.subscriptions.push(addStylesheetLink(this.url(m.info.id, path), m.info.id));
      else if (typeof css === "string" || Array.isArray(css)) m.subscriptions.push(addStyle(Array.isArray(css) ? css.join("\n") : css, m.info.id));
    }
    // Title bar buttons (like VS Code's "Open in Agents").
    for (const item of Array.isArray(c.titleBar) ? c.titleBar : []) {
      if (!item || (!item.command && !item.run)) continue;
      const handle = this.wb.addTitleItem({ id: item.id, icon: item.icon, text: item.text, title: item.title ?? item.tooltip, command: item.command, args: item.args, align: item.align, order: item.order });
      m.subscriptions.push({ dispose: handle.dispose });
    }
    // Icons: change any codicon, or add names that work wherever an icon name does (icons.ts).
    if (c.icons && typeof c.icons === "object") {
      for (const [name, source] of Object.entries(c.icons)) {
        try {
          m.subscriptions.push(setIcon(name, source as IconSource, m.info.id, (p) => this.url(m.info.id, p)));
        } catch (e) {
          console.warn(`[${m.info.id}] icon ${name}:`, e);
        }
      }
    }
    // Menu items: { "explorer/context": [{ "command", "label", "icon", "keybinding", "order" }], "menubar/Docker": […] }.
    if (c.menus && typeof c.menus === "object") {
      for (const [menu, list] of Object.entries(c.menus)) {
        for (const it of Array.isArray(list) ? (list as any[]) : []) {
          if (!it?.command) continue;
          const title = (c.commands ?? []).find((x: any) => x.id === it.command)?.title;
          m.subscriptions.push(addContributedMenuItem(menu, { id: it.id ?? it.command, label: it.label ?? title ?? it.command, icon: it.icon, keybinding: it.keybinding, command: it.command, args: it.args, order: it.order, separatorBefore: it.separatorBefore, owner: m.info.id }));
        }
      }
    }
    // Activity bar buttons that run a command (not views).
    for (const it of Array.isArray(c.activityBar) ? c.activityBar : []) {
      if (!it?.icon || !it.command) continue;
      const handle = this.wb.addActivityItem({ id: it.id, icon: it.icon, title: it.title, command: it.command, args: it.args, position: it.position, order: it.order });
      m.subscriptions.push({ dispose: handle.dispose });
    }
    for (const v of c.views ?? []) {
      this.wb.registerView({ id: v.id, title: v.title, icon: v.icon ?? m.info.icon ?? "extensions", location: v.location ?? "sidebar", order: v.order ?? 50, owner: m.info.id });
      commands.register(`workbench.view.${v.id}`, () => this.wb.showView(v.id), { title: `Show ${v.title}`, category: "View", owner: m.info.id });
      if (v.keybinding) commands.bind(v.keybinding, `workbench.view.${v.id}`, m.info.id);
    }
    for (const cmd of c.commands ?? []) {
      commands.declare({ id: cmd.id, title: cmd.title, category: cmd.category ?? m.info.name, icon: cmd.icon, owner: m.info.id, hidden: cmd.hidden });
      if (cmd.keybinding) commands.bind(cmd.keybinding, cmd.id, m.info.id);
    }
    for (const kb of c.keybindings ?? []) commands.bind(kb.key, kb.command, m.info.id, kb.args);
    for (const t of c.themes ?? []) {
      this.themes.push({
        id: `${m.info.id}/${t.id ?? t.label}`,
        label: t.label,
        uiTheme: t.uiTheme === "vs" ? "vs" : t.uiTheme === "hc-black" ? "hc-black" : "vs-dark",
        source: m.info.name,
        // A theme is a file of the mod, or written inline in mod.json.
        load: () => (t.path ? this.loadTheme(m.info.id, t.path) : Promise.resolve({ ...t, colors: t.colors ?? {}, tokenColors: t.tokenColors ?? [] } as VsTheme)),
      });
    }
    // File icon themes (VS Code's JSON format); `workbench.iconTheme` picks one. See fileIcons.ts.
    for (const t of Array.isArray(c.iconThemes) ? c.iconThemes : []) {
      if (!t?.id || !t.path) continue;
      const url = this.url(m.info.id, t.path);
      m.subscriptions.push(registerIconTheme({ id: t.id, label: t.label ?? t.id, source: m.info.name, mod: m.info.id, url, load: async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${t.path}: ${res.status}`);
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return parseJsonc(text); // a theme with comments
        }
      } }));
    }
    for (const l of c.languages ?? []) this.contributeLanguage(m.info.id, l);
    for (const g of c.grammars ?? []) {
      if (!g.scopeName || !g.path) continue;
      this.grammars.set(g.scopeName, { scopeName: g.scopeName, url: this.url(m.info.id, g.path), path: g.path, language: g.language, injectTo: g.injectTo, embeddedLanguages: g.embeddedLanguages });
      if (g.language) {
        const source = this.grammars.get(g.scopeName)!;
        // The grammar engine loads the first time a file of this language is opened.
        monaco.languages.onLanguage(g.language, async () => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const tm = await import("./textmate");
              await tm.attachGrammar(g.language, source, this.grammars);
              return;
            } catch (e) {
              if (attempt === 3) console.warn(`grammar ${g.scopeName} of ${m.info.id} (${source.url}):`, e);
              else await new Promise((r) => setTimeout(r, 400 * attempt));
            }
          }
        });
      }
    }
    for (const s of c.snippets ?? []) {
      if (s.items && typeof s.items === "object") this.registerSnippets(s.language, s.items);
      else if (s.path) this.loadSnippets(m.info.id, s.language, s.path);
    }
    // What a JSON mod does without code: commands with actions, launcher views, status items…
    m.subscriptions.push(...this.declarative.contribute(m.info));
  }

  /**
   * `aimod://localhost/<mod>/<path>` (or `http://aimod.localhost/…` on Windows). Built segment by
   * segment: `convertFileSrc` alone would encode the slashes, and a module's relative imports
   * (`./vendor/x.mjs`) would then resolve against the wrong folder.
   */
  private contributeLanguage(modId: string, l: any) {
    if (!l?.id) return;
    const known = monaco.languages.getLanguages().find((x) => x.id === l.id);
    if (!known) {
      monaco.languages.register({ id: l.id, extensions: l.extensions, aliases: l.aliases, filenames: l.filenames, filenamePatterns: l.filenamePatterns, firstLine: l.firstLine, mimetypes: l.mimetypes });
    } else {
      // Extend a language Monaco already knows with the extra file names an extension adds.
      monaco.languages.register({ id: l.id, extensions: l.extensions, filenames: l.filenames, filenamePatterns: l.filenamePatterns });
    }
    if (l.configuration && typeof l.configuration === "object") {
      const raw = l.configuration;
      monaco.languages.onLanguage(l.id, async () => {
        const tm = await import("./textmate");
        monaco.languages.setLanguageConfiguration(l.id, tm.toLanguageConfiguration(raw));
      });
    } else if (l.configuration) {
      const path = l.configuration;
      monaco.languages.onLanguage(l.id, async () => {
        try {
          const raw = parseJsonc(await (await fetch(this.url(modId, path))).text());
          const tm = await import("./textmate");
          monaco.languages.setLanguageConfiguration(l.id, tm.toLanguageConfiguration(raw));
        } catch (e) {
          console.warn(`language configuration of ${l.id} (${modId}):`, e);
        }
      });
    }
  }

  /** A mod's theme file, following `include` (a theme built on another) and token files. */
  private async loadTheme(modId: string, path: string, depth = 0): Promise<VsTheme> {
    const res = await fetch(this.url(modId, path));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const theme = parseJsonc(await res.text()) as VsTheme & { tokenColors?: any };
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const resolve = (rel: string) => normalizePath(dir + rel);
    if (typeof theme.tokenColors === "string") {
      const file = theme.tokenColors as string;
      theme.tokenColors = file.endsWith(".json") ? (parseJsonc(await (await fetch(this.url(modId, resolve(file)))).text()).tokenColors ?? []) : [];
    }
    if (theme.include && depth < 5) {
      const base = await this.loadTheme(modId, resolve(theme.include), depth + 1);
      return { ...theme, colors: { ...base.colors, ...theme.colors }, tokenColors: [...(base.tokenColors ?? []), ...(theme.tokenColors ?? [])] };
    }
    return theme;
  }

  url(modId: string, path: string) {
    const base = convertFileSrc("", "aimod").replace(/\/?$/, "/");
    const segments = [modId, ...normalizePath(path).split("/")].map(encodeURIComponent);
    return base + segments.join("/");
  }

  fire(event: string) {
    for (const m of this.mods.values()) {
      if (m.state === "idle" && m.info.main && (m.info.activation.includes(event) || m.info.activation.includes("*"))) {
        this.activate(m.info.id).catch(() => {});
      }
    }
  }

  async activate(id: string): Promise<unknown> {
    const m = this.mods.get(id);
    if (!m) throw new Error(`${id} is not enabled`);
    if (m.state === "active") return m.exports;
    if (m.activation) return m.activation;
    if (!m.info.main) {
      m.state = "active";
      return undefined;
    }
    m.state = "activating";
    this.onDidChangeState.fire(id);
    m.activation = (async () => {
      const t0 = performance.now();
      try {
        for (const dep of m.info.dependencies) await this.activate(dep);
        const module = await import(/* @vite-ignore */ this.url(id, m.info.main!));
        const ctx = this.createContext(m);
        m.exports = typeof module.activate === "function" ? await module.activate(ctx) : undefined;
        m.state = "active";
        m.activatedAt = Date.now();
        m.loadMs = Math.round(performance.now() - t0);
        return m.exports;
      } catch (e) {
        m.state = "failed";
        m.error = String(e instanceof Error ? e.message : e);
        console.error(`[mod ${id}]`, e);
        notify("error", `${m.info.name} failed to start: ${m.error}`);
        throw e;
      } finally {
        this.onDidChangeState.fire(id);
      }
    })();
    return m.activation;
  }

  private async loadSnippets(modId: string, language: string, path: string) {
    try {
      const res = await fetch(this.url(modId, path));
      this.registerSnippets(language, parseJsonc(await res.text()));
    } catch (e) {
      console.warn(`snippets of ${modId}`, e);
    }
  }

  private registerSnippets(language: string, data: Record<string, { prefix: string | string[]; body: string | string[]; description?: string }>) {
    {
      monaco.languages.registerCompletionItemProvider(language, {
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return {
            suggestions: Object.entries(data).flatMap(([name, s]) =>
              (Array.isArray(s.prefix) ? s.prefix : [s.prefix]).map((prefix) => ({
                label: prefix,
                kind: monaco.languages.CompletionItemKind.Snippet,
                detail: s.description ?? name,
                documentation: name,
                insertText: Array.isArray(s.body) ? s.body.join("\n") : s.body,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
              })),
            ),
          };
        },
      });
    }
  }

  // ---------- the API a mod sees ----------

  private createContext(m: Loaded) {
    const modId = m.info.id;
    const subs = m.subscriptions;
    const track = <T extends Disposable>(d: T): T => {
      subs.push(d);
      return d;
    };
    const call = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { modId, ...args });
    const host = this;
    const editors = this.editors;
    const wb = this.wb;
    const workspace = this.workspace;

    /** Runs a program; output streams to onData, the end to onExit (ctx.process.spawn). */
    const spawnProc = async (
      program: string,
      args: string[],
      opts: {
        cwd?: string;
        stdin?: string;
        env?: Record<string, string>;
        /** Keep the input open: write to the program while it runs with `write()`, close it with `end()`. */
        keepStdin?: boolean;
        /** "base64": `onData` gets the raw bytes (a Uint8Array), for programs that print binary. */
        encoding?: "utf8" | "base64";
        onData?: (data: any, stream: "stdout" | "stderr") => void;
        onExit?: (code: number | null) => void;
      } = {},
    ) => {
      const id = await call<number>("proc_spawn", { program, args, cwd: opts.cwd ?? workspace.folder ?? undefined, stdin: opts.stdin, env: opts.env, keepStdin: !!opts.keepStdin, encoding: opts.encoding });
      let resolveDone: (code: number | null) => void;
      const done = new Promise<number | null>((r) => (resolveDone = r));
      // A quick program may have exited already: its buffered exit then arrives inside onStream,
      // before offExit is assigned — so the cleanup must not need it yet.
      let offExit: (() => void) | null = null;
      let exited = false;
      const offData = onStream("proc://data", id, (p) => opts.onData?.(p.base64 ? fromBase64(p.data) : p.data, p.stream));
      offExit = onStream("proc://exit", id, (p) => {
        exited = true;
        offData();
        offExit?.();
        opts.onExit?.(p.code);
        resolveDone(p.code);
      });
      if (exited) offExit();
      return {
        id,
        done,
        kill: () => invoke("proc_kill", { id }),
        /** Text, or bytes (Uint8Array). Needs `keepStdin`. */
        write: (data: string | Uint8Array) => (typeof data === "string" ? invoke<void>("proc_write", { id, data }) : invoke<void>("proc_write", { id, data: toBase64(data), base64: true })),
        /** Closes the input (the program reads end-of-file). */
        end: () => invoke<void>("proc_end", { id }),
      };
    };

    return Object.freeze({
      id: modId,
      apiVersion: 1,
      manifest: m.info,
      monaco,
      subscriptions: subs,
      /** A URL for a file inside this mod (an image, a stylesheet, a worker). */
      asset: (path: string) => host.url(modId, path),

      commands: {
        register: (id: string, run: (...args: any[]) => unknown, info: { title?: string; category?: string } = {}) =>
          track(commands.register(id, run, { owner: modId, category: m.info.name, ...info })),
        execute: (id: string, ...args: any[]) => commands.execute(id, ...args),
        bind: (key: string, command: string, args?: unknown) => track(commands.bind(key, command, modId, args)),
        exists: (id: string) => commands.has(id),
        /** Every command: id, title, category, owner and its keybinding. */
        list: () => commands.all().map((c) => ({ id: c.id, title: c.title, category: c.category, owner: c.owner, keybinding: commands.keybindingFor(c.id) ?? null })),
      },

      views: {
        provide: (viewId: string, provider: ViewProvider) => track(wb.provideView(viewId, provider)),
        reveal: (viewId: string, focus = true) => wb.showView(viewId, focus),
        isVisible: (viewId: string) => wb.isVisible(viewId),
        setBadge: (viewId: string, count: number) => wb.setBadge(viewId, count),
        refreshActions: () => wb.refreshActions(),
        onDidChangeLayout: (fn: () => void) => track(wb.onDidChangeLayout.event(fn)),
      },

      statusBar: {
        add: (item: StatusItem) => {
          const handle = wb.addStatus(item);
          track({ dispose: handle.dispose });
          return handle;
        },
      },

      window: {
        showInfo: (message: string, ...actions: { label: string; run: () => void }[]) => notify("info", message, actions),
        showWarning: (message: string, ...actions: { label: string; run: () => void }[]) => notify("warning", message, actions),
        showError: (message: string, ...actions: { label: string; run: () => void }[]) => notify("error", message, actions),
        showQuickPick: <T extends QuickItem>(items: T[], opts?: Parameters<typeof pick<T>>[1]) => pick(items, opts),
        showInputBox: (opts: { prompt?: string; placeholder?: string; value?: string; password?: boolean; validate?: (v: string) => string | null }) => inputBox(opts),
        confirm: (message: string, detail?: string, primary?: string) => confirm(message, detail, primary),
        /** `opts.menu`: this menu's id, so other mods can add to it (`ctx.menus.add(id, …)`); `opts.context` goes to their items. */
        contextMenu: (x: number, y: number, items: MenuItem[], opts?: { menu?: string; context?: unknown; above?: boolean }) => contextMenu(x, y, items, opts),
        pickFolder: async () => {
          const r = await openDialog({ directory: true, multiple: false });
          return typeof r === "string" ? r : null;
        },
        pickFiles: async () => {
          const r = await openDialog({ directory: false, multiple: true });
          return Array.isArray(r) ? r : r ? [r] : [];
        },
        copy: (text: string) => invoke<void>("clipboard_write", { text }),
        /** Hides this window: it keeps running (its mods, programs and terminals). `show()` brings it back. */
        hide: () => getCurrentWindow().hide(),
        show: async () => {
          const w = getCurrentWindow();
          await w.show();
          await w.unminimize().catch(() => {});
          await w.setFocus().catch(() => {});
        },
        isVisible: () => getCurrentWindow().isVisible(),
        minimize: () => getCurrentWindow().minimize(),
        focus: () => getCurrentWindow().setFocus(),
        /**
         * Asked before this window closes (the red button, ⌘⇧W, Close Window): return false to keep
         * it open — hide it instead and the app keeps working, with the Dock icon or a menu bar
         * icon (`ctx.app.tray`) to bring it back. `lastWindow`: no other window is open.
         */
        onWillClose: (fn: (info: { lastWindow: boolean }) => boolean | void | Promise<boolean | void>) => {
          host.closeHooks.add(fn);
          return track(toDisposable(() => host.closeHooks.delete(fn)));
        },
      },

      /** The app beyond this window: menu bar icons, the Dock, quitting. */
      app: {
        /**
         * An icon in the macOS menu bar (a status item) with an optional menu. `icon`: a codicon name,
         * SVG markup, a .png/.svg in the mod's folder, an absolute path, a data: URL, or "app".
         * Menu items: `{ id, label, run | command, checked, enabled, accelerator, separator, submenu }`.
         * Returns `{ update(patch), dispose() }`.
         */
        tray: (spec: TraySpec) => {
          const id = spec.id ?? "main";
          const key = `${modId}:${id}`;
          let current: TraySpec = { ...spec };
          void host.listenTray();
          const send = async () => {
            const items = new Map<string, TrayMenuItem>();
            const flatten = (list: TrayMenuItem[] | undefined, prefix: string): any[] | undefined =>
              list?.map((it, i) => {
                const itemId = it.id ?? `${prefix}${i}`;
                if (!it.separator) items.set(itemId, it);
                return { id: itemId, label: it.label, enabled: it.enabled, checked: it.checked, separator: it.separator, accelerator: it.accelerator, submenu: flatten(it.submenu, `${itemId}.`) };
              });
            const menu = flatten(current.menu, "");
            host.trays.set(key, { onClick: current.onClick, onDoubleClick: current.onDoubleClick, items });
            const icon = await trayIcon(current.icon, (p) => host.url(modId, p), m.info.dir);
            await call<void>("app_tray_set", { id, spec: { icon, template: current.template, title: current.title, tooltip: current.tooltip, menu, menuOnLeftClick: current.menuOnLeftClick } });
          };
          let ready = send().catch((e) => console.error(`tray ${id}:`, e));
          const dispose = () => {
            host.trays.delete(key);
            void ready.then(() => invoke("app_tray_remove", { modId, id }));
          };
          track(toDisposable(dispose));
          return {
            update: (patch: Partial<TraySpec>) => {
              current = { ...current, ...patch };
              ready = ready.then(send).catch((e) => console.error(`tray ${id}:`, e));
              return ready;
            },
            dispose,
          };
        },
        /** The Dock icon (and ⌘Tab): false makes AICode an app that lives in the menu bar. */
        setDockVisible: (visible: boolean) => call<void>("app_set_dock_visible", { visible }),
        /** A badge on the Dock icon (a count, a word); null removes it. */
        setBadge: (text: string | number | null) => invoke<void>("app_set_badge", { text: text == null ? null : String(text) }),
        /** Quits AICode (sessions are kept, as with ⌘Q). */
        quit: () => invoke<void>("app_quit"),
        /** The Dock icon was clicked; with no window on screen, hidden windows come back by themselves. */
        onReopen: (fn: (info: { hasVisibleWindows: boolean }) => void) => track(host.onDidReopen.event(fn)),
        /**
         * A shortcut for the whole system: it works while AICode is in the background or hidden, and
         * needs no permission. `key` like the window's ("mod+shift+space", "alt+f1"); `fn` runs when it
         * is pressed (`onRelease` when it is let go). Resolves to a disposable.
         */
        globalShortcut: async (key: string, fn: () => void, opts: { onRelease?: () => void } = {}) => {
          const accelerator = toAccelerator(key);
          await host.listenShortcuts();
          host.shortcuts.set(accelerator, { pressed: fn, released: opts.onRelease });
          try {
            await call<void>("app_shortcut_register", { accelerator });
          } catch (e) {
            host.shortcuts.delete(accelerator);
            throw e;
          }
          return track(toDisposable(() => {
            host.shortcuts.delete(accelerator);
            invoke("app_shortcut_unregister", { accelerator }).catch(() => {});
          }));
        },
      },

      /**
       * Native macOS code in JavaScript (JavaScript for Automation): the whole Cocoa API through
       * `$` (`$.NSApplication.sharedApplication` is AICode itself), JS functions as blocks,
       * `ObjC.registerSubclass` for delegates and targets. No Rust, no compiling. See docs/MODS.md.
       */
      native: {
        /** The language native code is written in here: "jxa" (macOS), "powershell" (Windows), "python" (Linux). */
        language: NATIVE_LANGUAGE,
        /** Runs `source` (a function body: `return` a JSON-able value). macOS: inside AICode, on the main thread; elsewhere in a helper process. `opts.args` is `args` there (`$Arguments` in PowerShell). */
        eval: (source: string, opts: { args?: unknown } = {}) =>
          NATIVE_LANGUAGE === "jxa" ? call<unknown>("native_eval", { source, args: opts.args ?? null }) : nativeEval(spawnProc, source, opts.args ?? null),
        /**
         * A native context that stays: its top-level functions and state live until `dispose()`
         * (a `dispose()` function of its own runs first). `call(name, ...args)` runs one of its
         * functions; `emit(channel, data)` in it reaches `on(channel, fn)` / `opts.onEvent`.
         */
        open: async (source: string, opts: { args?: unknown; onEvent?: (channel: string, data: unknown) => void } = {}) => {
          const listeners = new Map<string, Set<(data: unknown) => void>>();
          let id = -1;
          const route = (channel: string, data: unknown) => {
            opts.onEvent?.(channel, data);
            listeners.get(channel)?.forEach((f) => f(data));
            listeners.get("*")?.forEach((f) => f({ channel, data }));
          };
          const on = (channel: string, fn: (data: unknown) => void) => {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel)!.add(fn);
            return toDisposable(() => listeners.get(channel)?.delete(fn));
          };
          if (NATIVE_LANGUAGE !== "jxa") {
            const ctxt = await nativeOpen(spawnProc, source, opts.args ?? null, route);
            let closed = false;
            const dispose = async () => {
              if (closed) return;
              closed = true;
              await ctxt.close();
            };
            track(toDisposable(() => void dispose()));
            return { id, call: ctxt.call, on, dispose };
          }
          await host.listenNative();
          id = await call<number>("native_open", { source, args: opts.args ?? null });
          host.nativeHandlers.set(id, route);
          let closed = false;
          const dispose = async () => {
            if (closed) return;
            closed = true;
            host.nativeHandlers.delete(id);
            await invoke("native_close", { id }).catch(() => {});
          };
          track(toDisposable(() => void dispose()));
          return {
            id,
            call: <T = unknown>(name: string, ...args: unknown[]) => invoke<T>("native_call", { id, name, args }),
            on,
            dispose,
          };
        },
        /**
         * Native JavaScript in a process of its own (`osascript -l JavaScript`): for code that loops,
         * waits or should not hold up the window. In it: `args`, `send(data)` (→ `onMessage`),
         * `receive(fn)` (← `send()` here) and `keepAlive()` (runs until killed or stdin closes).
         */
        spawn: async (source: string, opts: { args?: unknown; onMessage?: (data: unknown) => void; onStderr?: (text: string) => void; onExit?: (code: number | null) => void } = {}) => {
          if (NATIVE_LANGUAGE !== "jxa") {
            const helper = await nativeSpawn(spawnProc, source, opts);
            track(toDisposable(() => void helper.kill()));
            return helper;
          }
          let buf = "";
          const proc = await spawnProc("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA_HELPER_PRELUDE + `var args = ${JSON.stringify(opts.args ?? null)};
` + source], {
            keepStdin: true,
            onData: (data: string, stream: "stdout" | "stderr") => {
              if (stream === "stderr") return opts.onStderr?.(data);
              buf += data;
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                let msg: unknown = line;
                try {
                  msg = JSON.parse(line);
                } catch {}
                opts.onMessage?.(msg);
              }
            },
            onExit: opts.onExit,
          });
          track(toDisposable(() => void proc.kill()));
          return {
            send: (data: unknown) => proc.write(JSON.stringify(data) + "\n"),
            kill: () => proc.kill(),
            done: proc.done,
          };
        },
      },

      /** Animations that follow the user's choice and macOS "Reduce motion". */
      motion: {
        enabled: () => motionEnabled(),
        /** Plays a CSS animation class once. */
        play: (el: Element, cls: string) => play(el, cls),
        /** Adds a leaving class and waits for its animation. */
        leave: (el: Element, cls: string, maxMs?: number) => leave(el, cls, maxMs),
        /** Animates elements from where they were to where `mutate()` puts them (reordering, moving). */
        flip: (target: Element | Element[] | (() => Element[]), mutate: () => void | Promise<void>, opts?: Parameters<typeof flip>[2]) => flip(target, mutate, opts),
        onDidChange: (fn: (enabled: boolean) => void) => track(onDidChangeMotion.event(fn)),
      },

      editor: {
        active: () => editors.activeInfo(),
        all: () => editors.list(),
        getText: (idOrPath?: string) => {
          if (idOrPath) return editors.textOf(idOrPath);
          return editors.activeText()?.model.getValue();
        },
        getSelection: () => editors.selection(),
        replaceSelection: (text: string) => editors.replaceSelection(text),
        /** `asText`: in the text editor even when a mod's editor type opens such files by default. */
        open: (path: string, opts?: { line?: number; column?: number; preview?: boolean; asText?: boolean }) => editors.openFile(path, opts).then((d) => (d ? editors.info(d) : null)),
        focus: (id: string) => editors.activateById(id),
        newUntitled: (text?: string, language?: string) => editors.info(editors.newUntitled(text, language)),
        openCustom: (spec: CustomTabSpec) => editors.info(editors.openCustom(spec)),
        close: (id: string) => {
          const doc = editors.find(id);
          return doc ? editors.close(doc) : Promise.resolve(false);
        },
        save: (id?: string) => editors.save(id ? editors.find(id) ?? null : editors.activeText()),
        proposeEdit: (target: string, proposal: EditProposal, opts?: { description?: string; source?: string }) =>
          editors.proposeEdit(target, proposal, { source: opts?.source ?? m.info.name, description: opts?.description }),
        onDidChangeActive: (fn: (info: ReturnType<EditorService["activeInfo"]>) => void) => track(editors.onDidChangeActive.event(fn)),
        onDidChangeEditors: (fn: () => void) => track(editors.onDidChangeDocs.event(fn)),
        onDidSave: (fn: (info: any) => void) => track(editors.onDidSave.event(fn)),
        onDidChangeContent: (fn: (info: any) => void) => track(editors.onDidChangeContent.event(fn)),
        /** The Monaco editor itself, for mods that add decorations, actions or widgets. */
        monacoEditor: () => editors.editor,
        /** An icon in the tab bar while `when(activeEditor)` holds (VS Code's editor/title). */
        addTitleAction: (action: TitleAction) => track(editors.addTitleAction({ ...action, id: `${modId}:${action.id}` })),
        /** Re-checks every tab bar icon's `when` (after what it depends on changed). */
        refreshTitleActions: () => editors.renderTitleActions(),
        /** The breadcrumbs after the file name for some languages: `{ languages, path(text, line, column) → [{ name, line, icon }] }`. */
        registerBreadcrumbs: (provider: BreadcrumbProvider) => track(editors.registerBreadcrumbs(provider)),
        /** Another editor for some files, offered by "Reopen Editor With…" and the breadcrumbs. */
        registerEditorType: (type: EditorType) => track(editors.registerEditorType(type)),
        /** A pane beside the editor (one at a time), like a second editor group. */
        openSide: (spec: SidePaneSpec) => editors.openSide(spec),
        closeSide: () => editors.closeSide(),
        /** That pane over the whole editor group, or back beside it (toggles with no argument). */
        maximizeSide: (on?: boolean) => editors.maximizeSide(on),
        isSideMaximized: () => editors.isSideMaximized(),
        /** A page over the workbench (VS Code's modal editor); a tab when the modal is turned off. */
        openPage: (spec: CustomTabSpec) => editors.openPage(spec),
        /** An open document's Monaco model (`editor.open(path, { background: true })` opens one without showing it). */
        model: (idOrPath: string) => editors.modelOf(idOrPath),
        /**
         * Another Monaco editor in `el` (a split, a peek, a floating editor) with the main one's
         * options, kept in step. With a document (id or path) it edits that document: dirty state,
         * saving and undo are shared. Disposed with the mod.
         */
        createEditor: (el: HTMLElement, idOrPath?: string | null, options?: Parameters<EditorService["createEditor"]>[2]) => {
          const ed = editors.createEditor(el, idOrPath ? editors.modelOf(idOrPath) : null, options);
          track({ dispose: () => ed.dispose() });
          return ed;
        },
        /** Moves a tab before another (null: to the end). */
        moveTab: (id: string, beforeId: string | null) => editors.moveTab(id, beforeId),
        onDidMoveTab: (fn: (e: { id: string; from: number; to: number }) => void) => track(editors.onDidMoveTab.event(fn)),
        /** Around each redraw of the tab bar (measure before, animate after). */
        onWillRenderTabs: (fn: () => void) => track(editors.onWillRenderTabs.event(fn)),
        onDidRenderTabs: (fn: () => void) => track(editors.onDidRenderTabs.event(fn)),
      },

      workspace: {
        folder: () => workspace.folder,
        setFolder: (path: string | null) => workspace.change(path),
        onDidChangeFolder: (fn: (folder: string | null) => void) => track(workspace.onDidChange.event(fn)),
        listFiles: (limit?: number) => (workspace.folder ? call<string[]>("fs_list_files", { root: workspace.folder, limit }) : Promise.resolve([])),
      },

      fs: {
        readText: (path: string) => call<{ text: string; binary: boolean; bom: boolean; eol: "\n" | "\r\n" }>("fs_read_text", { path }),
        /** Any file (an image, a PDF, a binary) as a data: URL, ready for an <img>/<video> src. Up to 40 MB. */
        readDataUrl: (path: string) => call<string>("fs_read_data_url", { path }),
        /** Any file's bytes. Up to 40 MB. */
        readBytes: async (path: string) => {
          const url = await call<string>("fs_read_data_url", { path });
          const bin = atob(url.slice(url.indexOf(",") + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        },
        writeText: (path: string, text: string, opts: { bom?: boolean } = {}) => call<void>("fs_write_text", { path, text, bom: !!opts.bom }),
        readDir: (path: string) => call<{ name: string; path: string; is_dir: boolean; is_symlink: boolean }[]>("fs_read_dir", { path }),
        stat: (path: string) => call<{ exists: boolean; is_dir: boolean; size: number; modified_ms: number }>("fs_stat", { path }),
        create: (path: string, dir = false) => call<void>("fs_create", { path, dir }),
        rename: async (from: string, to: string) => {
          await call<void>("fs_rename", { from, to });
          editors.movePath(from, to);
        },
        /** Moves a file or folder to the Trash (or deletes it for good with { trash: false }). */
        delete: (path: string, opts: { trash?: boolean } = {}) => call<void>("fs_delete", { path, trash: opts.trash ?? true }),
        copy: (from: string, to: string) => call<void>("fs_copy", { from, to }),
        /** Shows the file selected in Finder / Explorer. */
        reveal: (path: string) => call<void>("fs_reveal", { path }),
        /** Calls fn when something directly inside the folder changes on disk. */
        watch: (dir: string, fn: () => void) => track(watchDir(dir, fn, modId)),
        listFiles: (root: string, limit?: number) => call<string[]>("fs_list_files", { root, limit }),
        search: (
          root: string,
          query: string,
          opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; maxResults?: number; include?: string; exclude?: string; useIgnore?: boolean; paths?: string[] } = {},
        ) =>
          call<{ hits: { path: string; line: number; column: number; length: number; text: string }[]; files_searched: number; truncated: boolean }>("fs_search", {
            root,
            query,
            regex: !!opts.regex,
            caseSensitive: !!opts.caseSensitive,
            wholeWord: !!opts.wholeWord,
            maxResults: opts.maxResults,
            include: opts.include || undefined,
            exclude: opts.exclude || undefined,
            useIgnore: opts.useIgnore ?? true,
            paths: opts.paths,
          }),
        home: () => invoke<string>("home_dir"),
      },

      /** The mod's own folder for what it downloads or builds up (models, binaries, caches):
       *  `AICode/data/<mod id>/`, created on first use, kept across updates of the mod. */
      storage: {
        dir: () => call<string>("mod_data_dir"),
      },

      process: {
        which: (program: string) => call<string | null>("proc_which", { program }),
        /** Runs a program; output streams to onData, the end to onExit. */
        spawn: spawnProc,
      },

      pty: {
        /** { default, shells }: the login shell and the other shells installed. */
        shells: () => call<{ default: string | null; shells: string[] }>("pty_shells"),
        spawn: async (opts: { cwd?: string; command?: string; args?: string[]; cols: number; rows: number; onData: (data: string) => void; onExit?: (code: number | null) => void }) => {
          const id = await call<number>("pty_spawn", { cwd: opts.cwd ?? workspace.folder ?? undefined, command: opts.command, args: opts.args, cols: opts.cols, rows: opts.rows });
          let offExit: (() => void) | null = null;
          let exited = false;
          const offData = onStream("pty://data", id, (p) => opts.onData(p.data));
          offExit = onStream("pty://exit", id, (p) => {
            exited = true;
            offData();
            offExit?.();
            opts.onExit?.(p.code);
          });
          if (exited) offExit();
          return {
            id,
            write: (data: string) => invoke("pty_write", { id, data }),
            resize: (cols: number, rows: number) => invoke("pty_resize", { id, cols, rows }),
            kill: () => invoke("pty_kill", { id }),
          };
        },
      },

      mcp: {
        start: () => call<{ port: number; url: string; token: string }>("mcp_start"),
        stop: () => invoke("mcp_stop"),
        status: () => invoke<{ port: number; url: string; token: string; tools: number } | null>("mcp_status"),
        setTools: (tools: unknown[]) => invoke("mcp_set_tools", { tools }),
        onCall: (handler: (call: { callId: number; name: string; arguments: any }) => Promise<unknown>) => {
          host.mcpHandler = handler;
          return track(toDisposable(() => host.mcpHandler === handler && (host.mcpHandler = null)));
        },
      },

      external: {
        open: (target: string, app?: string) => call<void>("open_external", { target, app }),
        appInstalled: (name: string) => invoke<boolean>("app_installed", { name }),
      },

      decorations: {
        /** provider(path) → { badge, color, tooltip, faded } for files and folders; call the returned fire() when they change. */
        register: (provider: DecorationProvider) => {
          decorations.providers.add(provider);
          decorations.onDidChange.fire();
          const d = track(toDisposable(() => { decorations.providers.delete(provider); decorations.onDidChange.fire(); }));
          return { dispose: () => d.dispose(), fire: () => decorations.onDidChange.fire() };
        },
        get: (path: string) => decorations.get(path),
        onDidChange: (fn: () => void) => track(decorations.onDidChange.event(fn)),
      },

      /** This mod's settings: the user's value, else a mod's default, else the one declared in contributes.settings. */
      settings: {
        all: async () => config.all(modId),
        get: async <T>(key: string, fallback: T): Promise<T> => config.get(modId, key, fallback) as T,
        /** The same, without waiting (the configuration is already in memory). */
        getNow: <T>(key: string, fallback?: T): T => config.get(modId, key, fallback) as T,
        set: (key: string, value: unknown) => config.update(modId, key, value),
        inspect: (key: string) => config.inspect(modId, key),
        onDidChange: (fn: (keys: string[]) => void) => track(config.watch(modId, "*", (changes) => fn(changes.map((c) => c.key)))),
      },

      /** The whole configuration: the editor's settings ("core") and every mod's, by layers. */
      config: {
        /** A core setting's effective value (editor.*, workbench.*, window.*…). */
        get: <T>(key: string, fallback?: T): T => config.core(key, fallback) as T,
        /** Any owner's setting (another mod's, by its id). */
        getFor: <T>(owner: string, key: string, fallback?: T): T => config.get(owner, key, fallback) as T,
        all: (owner = "core") => config.all(owner),
        inspect: (key: string, owner = "core") => config.inspect(owner, key),
        /** Writes the user's value to profile.json (null removes it). */
        update: (key: string, value: unknown, owner = "core") => config.update(owner, key, value),
        onDidChange: (fn: (changes: Change[]) => void) => track(config.onDidChange.event(fn)),
        /** Calls fn when these core keys (a trailing * matches a prefix) change. */
        watch: (keys: string[] | string, fn: (changes: Change[]) => void, owner = "core") => track(config.watch(owner, keys, fn)),
        schema: (owner = "core") => config.schema(owner),
      },

      /** CSS that stays while the mod runs (or until disposed). */
      styles: {
        add: (css: string) => track(addStyle(css, modId)),
        addFile: (path: string) => track(addStylesheetLink(host.url(modId, path), modId)),
      },

      /** The window's parts and layout. Parts carry data-part="<name>" (see docs/CONFIGURATION.md). */
      workbench: {
        /**
         * In this window, draw the file icon theme `themeId` with `targetId` (null: itself) — the
         * choice stays `themeId`. The File Icon Themes mod's Auto pack follows the open folder this way.
         */
        drawIconThemeWith: async (themeId: string, targetId: string | null) => {
          if (!(await drawIconThemeWith(themeId, targetId))) return;
          editors.refreshTabs();
          decorations.onDidChange.fire(); // lists that show files repaint
        },
        root: () => wb.root,
        part: (name: string) => document.querySelector<HTMLElement>(`[data-part="${name}"]`),
        parts: (name: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-part="${name}"]`)),
        /** A button in the activity bar that runs a command (not a view): `{ icon, title, command | run, position: "top" | "bottom", order, badge }`. */
        addActivityItem: (item: ActivityItem) => {
          const handle = wb.addActivityItem(item);
          track({ dispose: handle.dispose });
          return handle;
        },
        /** Draws a view (any mod's, or the core's) with another icon until disposed. */
        setViewIcon: (viewId: string, iconName: string) => track(wb.setViewIcon(viewId, iconName)),
        addTitleItem: (item: TitleItem) => {
          const handle = wb.addTitleItem(item);
          track({ dispose: handle.dispose });
          return handle;
        },
        options: () => ({ ...wb.options }),
        setOptions: (o: Partial<LayoutOptions>) => wb.setOptions(o),
        toggle: (loc: ViewLocation) => wb.toggle(loc),
        isPartVisible: (loc: ViewLocation) => wb.viewsAt(loc).length > 0 && wb.state[loc].visible,
        views: () => wb.allViews(),
        moveView: (id: string, to: ViewLocation, beforeId?: string) => wb.moveView(id, to, beforeId),
        setCenterView: (id: string | null) => wb.setCenterView(id),
        centerView: () => wb.centerViewId(),
        /** Where a view is: "sidebar", "secondary", "panel", "center", "floating", "external" or "hidden". */
        whereIs: (id: string) => wb.whereIs(id),
        /** A view in a frame over the workbench, moved and resized by the user (and kept by the profile). */
        floatView: (id: string, rect?: Partial<FloatRect>) => wb.floatView(id, rect),
        dockView: (id: string, to?: ViewLocation) => wb.dockView(id, to),
        closeFloating: (id: string) => wb.closeFloating(id),
        floatRect: (id: string) => wb.floatRect(id),
        setFloatRect: (id: string, rect: Partial<FloatRect>) => wb.setFloatRect(id, rect),
        /** Shows a view inside the mod's own element until disposed (a dock, a split, a card). */
        hostView: (id: string, el: HTMLElement) => track(wb.hostView(id, el)),
        /** A strip of the mod's own at an edge of the window: `{ side: "left" | "right" | "top" | "bottom", order }` → `{ el, dispose }`. */
        addEdge: (spec: EdgeSpec) => {
          const edge = wb.addEdge(spec);
          track({ dispose: edge.dispose });
          return edge;
        },
        /** Makes an element take dragged views and tabs: `{ kinds, over(item, e), drop(item, e), hoverClass }`. */
        addDropTarget: (el: HTMLElement, spec: DropTargetSpec) => track(wb.addDropTarget(el, spec)),
        onDidMoveView: (fn: (e: ViewMove) => void) => track(wb.onDidMoveView.event(fn)),
        onDidChangeLayout: (fn: () => void) => track(wb.onDidChangeLayout.event(fn)),
        /** Around each redraw of the activity bar and part headers (measure before, animate after). */
        onWillRender: (fn: () => void) => track(wb.onWillRenderChrome.event(fn)),
        onDidRender: (fn: () => void) => track(wb.onDidRenderChrome.event(fn)),
        /** A view or a tab started or stopped being dragged (with its ghost element). */
        onDidStartDrag: (fn: (e: DragEvent) => void) => track(wb.onDidStartDrag.event(fn)),
        onDidEndDrag: (fn: (e: DragEvent) => void) => track(wb.onDidEndDrag.event(fn)),
      },

      /** Windows: open one with a layout or a single view, keep this one on top, and so on. */
      windows: {
        open: (spec: WindowSpec) => openWindow(spec),
        openView: (viewId: string, opts: Omit<WindowSpec, "view"> = {}) => openWindow({ ...opts, view: viewId }),
        layouts: () => layouts(),
        current: () => host.windowServices?.current() ?? null,
        setAlwaysOnTop: (on: boolean) => host.windowServices?.setPinned(on),
        isAlwaysOnTop: () => host.windowServices?.isOnTop() ?? false,
        reopen: () => host.windowServices?.reopen(),
        moveViewToNewWindow: (viewId: string) => host.windowServices?.detachView(viewId),
      },

      mods: {
        /** What another enabled mod exported from activate() — activating it if needed. */
        get: (id: string) => (host.mods.has(id) ? host.activate(id) : Promise.resolve(undefined)),
        isEnabled: (id: string) => host.mods.has(id),
        /**
         * What enabled mods declare under `contributes.<point>` — a mod's own extension point
         * (the AI Chat's `chatAgents`). Each item comes with `mod`, the id of the mod declaring it;
         * `ctx.mods.get(mod)` loads that mod. Reading the manifests runs no code.
         */
        contributions: (point: string) =>
          [...host.mods.values()].flatMap((m) => {
            const items = m.info.contributes?.[point];
            return (Array.isArray(items) ? items : []).map((item: any) => ({ ...item, mod: m.info.id, modName: m.info.name }));
          }),
      },

      /**
       * HTTP from Rust: any URL, method, headers and body — no CORS, no CSP — with the real status
       * and headers, binary bodies, timings, streaming and cancel. Needs the "network" permission (declared for the user).
       */
      http: {
        request: (opts: HttpOptions) => httpRequest(call, opts),
        get: (url: string, opts: Omit<HttpOptions, "url" | "method"> = {}) => httpRequest(call, { ...opts, url, method: "GET" }),
        post: (url: string, body: HttpOptions["body"], opts: Omit<HttpOptions, "url" | "method" | "body"> = {}) => httpRequest(call, { ...opts, url, method: "POST", body }),
      },

      /** Passwords, tokens, connection strings: in the macOS Keychain (service "AICode: <mod id>" unless `service` is given). */
      secrets: {
        get: (key: string, opts: { service?: string } = {}) => call<string | null>("secret_get", { key, service: opts.service }),
        set: (key: string, value: string, opts: { service?: string } = {}) => call<void>("secret_set", { key, value, service: opts.service }),
        delete: (key: string, opts: { service?: string } = {}) => call<void>("secret_delete", { key, service: opts.service }),
      },

      /**
       * Items in the window's menus: any context menu by id ("editor/context", "editor/tab",
       * "editor/title", "explorer/context", "explorer/title", "terminal/context", "activityBar",
       * "view/title", "manage", or a mod's own) and the app's menu bar ("menubar/File", "menubar/Edit",
       * "menubar/View", "menubar/Window", or "menubar/<New Menu>"). See menus.ts.
       */
      menus: {
        add: (menu: string, item: MenuContribution) => track(addContributedMenuItem(menu, { ...item, owner: modId })),
        items: (menu: string) => menuContributions(menu).map((i) => ({ ...i })),
      },

      /** Draw any icon differently, or add new icon names (SVG, picture, font glyph, another codicon). See icons.ts. */
      icons: {
        set: (name: string, source: IconSource) => track(setIcon(name, source, modId, (p) => host.url(modId, p))),
        list: () => iconOverrides(),
      },

      ui: { h, icon, iconButton, clear, basename, dirname, joinPath, isAbsolute, pathRoot, uiPath, fileIcon, fileIconColor, fileIconEl, folderIconEl },
    });
  }
}

/** A `<style>` in the page until disposed. */
export function addStyle(css: string, owner: string): Disposable {
  const el = document.createElement("style");
  el.dataset.owner = owner;
  el.textContent = css;
  insertStyle(el, owner);
  return toDisposable(() => el.remove());
}

/** A stylesheet file (a mod's, by its aimod: URL) until disposed. */
export function addStylesheetLink(href: string, owner: string): Disposable {
  const el = document.createElement("link");
  el.rel = "stylesheet";
  el.href = href;
  el.dataset.owner = owner;
  insertStyle(el, owner);
  return toDisposable(() => el.remove());
}

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

/** JSON with comments and trailing commas (theme, snippet and language files of mods). */
export function parseJsonc(text: string): any {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
    } else if (ch === '"') {
      inString = true;
      out += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}


// ---------- helpers for ctx.process (binary) and ctx.http ----------

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface HttpOptions {
  url: string;
  method?: string;
  /** An object or [name, value] pairs (a header can repeat). */
  headers?: Record<string, string> | [string, string][];
  /** Text, bytes, or any other value (sent as JSON, with Content-Type: application/json). */
  body?: string | Uint8Array | ArrayBuffer | object | null;
  timeoutMs?: number;
  followRedirects?: boolean;
  /** Accept invalid or self-signed certificates (a local server). */
  insecure?: boolean;
  /** As soon as the status and headers arrive. */
  onHead?: (head: { status: number; statusText: string; headers: [string, string][]; url: string; ttfbMs: number }) => void;
  /** Each piece of the body as it arrives (server-sent events, logs, big downloads). */
  onChunk?: (chunk: Uint8Array) => void;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  version: string;
  headers: [string, string][];
  /** First value of a header (any case). */
  header(name: string): string | null;
  body: Uint8Array;
  text(): string;
  json<T = any>(): T;
  /** Time to first byte and total, in milliseconds; size of the body in bytes. */
  timings: { ttfbMs: number; totalMs: number };
  size: number;
}

/** Sends a request through Rust; the promise has `cancel()` and `id`. */
function httpRequest(call: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>, opts: HttpOptions): Promise<HttpResponse> & { cancel(): void; id: Promise<number> } {
  const headers: [string, string][] = Array.isArray(opts.headers) ? [...opts.headers] : Object.entries(opts.headers ?? {});
  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  let body: string | undefined;
  let bodyBase64 = false;
  const b = opts.body;
  if (b == null) body = undefined;
  else if (typeof b === "string") body = b;
  else if (b instanceof Uint8Array || b instanceof ArrayBuffer) {
    body = toBase64(b instanceof ArrayBuffer ? new Uint8Array(b) : b);
    bodyBase64 = true;
  } else {
    body = JSON.stringify(b);
    if (!has("content-type")) headers.push(["Content-Type", "application/json"]);
  }
  let cancelled = false;
  let reqId: number | null = null;
  const idPromise = call<number>("http_request", {
    request: { url: opts.url, method: opts.method ?? "GET", headers, body, bodyBase64, timeoutMs: opts.timeoutMs, followRedirects: opts.followRedirects, insecure: opts.insecure },
  });
  const promise = new Promise<HttpResponse>((resolve, reject) => {
    idPromise.then((id) => {
      reqId = id;
      if (cancelled) invoke("http_cancel", { id });
      let head: any = null;
      const chunks: Uint8Array[] = [];
      const offHead = onStream("http://head", id, (p) => {
        head = p;
        opts.onHead?.({ status: p.status, statusText: p.statusText, headers: p.headers, url: p.url, ttfbMs: p.ttfbMs });
      });
      const offData = onStream("http://data", id, (p) => {
        const chunk = fromBase64(p.data);
        chunks.push(chunk);
        opts.onChunk?.(chunk);
      });
      const offEnd = onStream("http://end", id, (p) => {
        offHead();
        offData();
        offEnd();
        if (p.error) return reject(Object.assign(new Error(p.error), { cancelled: !!p.cancelled, status: head?.status }));
        const size = chunks.reduce((n, c) => n + c.length, 0);
        const all = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        let decoded: string | null = null;
        const text = () => (decoded ??= new TextDecoder().decode(all));
        resolve({
          status: head?.status ?? 0,
          statusText: head?.statusText ?? "",
          ok: !!head && head.status >= 200 && head.status < 300,
          url: head?.url ?? opts.url,
          version: head?.version ?? "",
          headers: head?.headers ?? [],
          header: (name: string) => (head?.headers ?? []).find(([k]: [string, string]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null,
          body: all,
          text,
          json: () => JSON.parse(text()),
          timings: { ttfbMs: head?.ttfbMs ?? 0, totalMs: p.totalMs ?? 0 },
          size,
        });
      });
    }, reject);
  });
  return Object.assign(promise, {
    id: idPromise,
    cancel: () => {
      cancelled = true;
      if (reqId != null) invoke("http_cancel", { id: reqId });
    },
  });
}

/** A mod's menu item; one in the menu bar also gets its command and its keyboard shortcut (menus.ts). */
function addContributedMenuItem(menu: string, item: MenuContribution): Disposable {
  if (!menu.startsWith("menubar/")) return addMenuItem(menu, item);
  const prepared = prepareMenuBarItem(item);
  const added = addMenuItem(menu, prepared.item);
  return toDisposable(() => {
    added.dispose();
    prepared.dispose();
  });
}


// ---------- menu bar icons (ctx.app.tray) ----------

export interface TrayClick {
  button: "left" | "right" | "middle";
  x: number;
  y: number;
}

export interface TrayMenuItem {
  id?: string;
  label?: string;
  run?: () => unknown;
  command?: string;
  args?: unknown[];
  enabled?: boolean;
  /** A check mark (the item is a toggle). */
  checked?: boolean;
  separator?: boolean;
  accelerator?: string;
  submenu?: TrayMenuItem[];
}

export interface TraySpec {
  /** Several icons per mod: give each an id (default "main"). */
  id?: string;
  icon?: string;
  /** Drawn in the menu bar's color (default true for an icon of the mod's). */
  template?: boolean;
  title?: string;
  tooltip?: string;
  menu?: TrayMenuItem[];
  menuOnLeftClick?: boolean;
  onClick?: (e: TrayClick) => void;
  onDoubleClick?: (e: TrayClick) => void;
}

/** What Rust takes for a tray icon: "app", a PNG data: URL, or an absolute PNG path. SVGs and codicons are drawn into a PNG here. */
async function trayIcon(icon: string | undefined, url: (path: string) => string, dir: string): Promise<string> {
  const src = icon?.trim();
  if (!src || src === "app") return "app";
  if (src.startsWith("data:image/png")) return src;
  if (src.startsWith("<")) return rasterize(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`);
  if (src.startsWith("data:")) return rasterize(src);
  if (/\.png$/i.test(src)) return isAbsolute(src) ? src : `${dir}/${normalizePath(src)}`;
  if (/\.(svg|jpe?g|gif|webp)$/i.test(src)) return rasterize(isAbsolute(src) ? convertFileSrc(src) : url(src));
  return codiconPng(src);
}

/** Menu bar icons are 22pt high: drawn at 2x. */
const TRAY_PX = 44;

function rasterize(href: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = TRAY_PX;
      const g = c.getContext("2d")!;
      const r = Math.min(TRAY_PX / (img.naturalWidth || TRAY_PX), TRAY_PX / (img.naturalHeight || TRAY_PX));
      const w = (img.naturalWidth || TRAY_PX) * r;
      const hh = (img.naturalHeight || TRAY_PX) * r;
      g.drawImage(img, (TRAY_PX - w) / 2, (TRAY_PX - hh) / 2, w, hh);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error(`could not load the icon ${href.slice(0, 80)}`));
    img.src = href;
  });
}

/** A codicon (or an icon a mod drew over one with ctx.icons — its glyph only) as a PNG. */
async function codiconPng(name: string): Promise<string> {
  const el = document.createElement("i");
  el.className = `codicon codicon-${name}`;
  el.style.cssText = "position: fixed; left: -9999px; top: 0;";
  document.body.append(el);
  try {
    const before = getComputedStyle(el, "::before");
    const content = before.content.replace(/^["']|["']$/g, "");
    if (!content || content === "none" || content === "normal") throw new Error(`no icon named ${name}`);
    await document.fonts.load(`${TRAY_PX}px ${before.fontFamily}`, content).catch(() => {});
    const c = document.createElement("canvas");
    c.width = c.height = TRAY_PX;
    const g = c.getContext("2d")!;
    g.font = `${Math.round(TRAY_PX * 0.8)}px ${before.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#000";
    g.fillText(content, TRAY_PX / 2, TRAY_PX / 2);
    return c.toDataURL("image/png");
  } finally {
    el.remove();
  }
}


// ---------- native code (ctx.native, ctx.app.globalShortcut) ----------

/** What `ctx.native.spawn` scripts get: `send`, `receive`, `keepAlive`. */
const JXA_HELPER_PRELUDE = `ObjC.import('Foundation'); ObjC.import('stdlib');
var __out = $.NSFileHandle.fileHandleWithStandardOutput;
function send(data) { __out.writeData($(JSON.stringify(data === undefined ? null : data) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
function receive(fn) {
  var fh = $.NSFileHandle.fileHandleWithStandardInput, buf = "";
  $.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock($.NSFileHandleDataAvailableNotification, fh, $.NSOperationQueue.mainQueue, function () {
    var d = fh.availableData;
    if (d.length == 0) $.exit(0);
    buf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding));
    var lines = buf.split("\\n"); buf = lines.pop();
    lines.forEach(function (l) { if (l) { try { fn(JSON.parse(l)); } catch (e) { send({ error: String(e) }); } } });
    fh.waitForDataInBackgroundAndNotify;
  });
  fh.waitForDataInBackgroundAndNotify;
}
function keepAlive() { $.NSRunLoop.currentRunLoop.run; }
`;

/** "mod+shift+space" → "CmdOrCtrl+Shift+Space" (what the global shortcut service reads). */
export function toAccelerator(key: string): string {
  const symbols: Record<string, string> = { "`": "Backquote", "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight", ",": "Comma", "=": "Equal", "-": "Minus", ".": "Period", "'": "Quote", ";": "Semicolon", "/": "Slash" };
  const mods: Record<string, string> = { mod: "CmdOrCtrl", cmd: "Cmd", meta: "Cmd", command: "Cmd", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" };
  const parts = key.trim().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || /\s/.test(key.trim())) throw new Error(`a global shortcut is one keystroke with modifiers ("mod+shift+space"), not ${JSON.stringify(key)}`);
  const last = parts.pop()!;
  const k = symbols[last] ?? (last.length === 1 ? last.toUpperCase() : last[0].toUpperCase() + last.slice(1).toLowerCase());
  return [...parts.map((m) => mods[m.toLowerCase()] ?? m), k].join("+");
}
