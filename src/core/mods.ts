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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke, listen, onStream, ModInfo } from "./ipc";
import * as commands from "./commands";
import { Workbench, ViewProvider, StatusItem } from "./workbench";
import { EditorService, EditProposal, CustomTabSpec, TitleAction, EditorType, SidePaneSpec } from "./editor";
import { Workspace } from "./workspace";
import { notify, pick, inputBox, confirm, contextMenu, QuickItem, MenuItem } from "./widgets";
import { h, icon, iconButton, clear, basename, dirname, joinPath, fileIcon, fileIconColor, Disposable, toDisposable } from "./ui";
import { ThemeEntry, VsTheme } from "./theme";
import type { GrammarSource } from "./textmate";
import { Emitter } from "./events";
import { Declarative, checkActions } from "./declarative";
import { fileIconEl } from "./fileIcons";

export type ModState = "idle" | "activating" | "active" | "failed";

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

  constructor(private wb: Workbench, private editors: EditorService, private workspace: Workspace) {
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
  async load(): Promise<ModInfo[]> {
    const all = await invoke<ModInfo[]>("mods_list");
    for (const info of all.filter((m) => m.enabled && !m.problems.length)) {
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

  private contribute(m: Loaded) {
    const c = m.info.contributes ?? {};
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
        showQuickPick: <T extends QuickItem>(items: T[], opts?: { placeholder?: string; matchDescription?: boolean }) => pick(items, opts),
        showInputBox: (opts: { prompt?: string; placeholder?: string; value?: string; validate?: (v: string) => string | null }) => inputBox(opts),
        confirm: (message: string, detail?: string, primary?: string) => confirm(message, detail, primary),
        contextMenu: (x: number, y: number, items: MenuItem[]) => contextMenu(x, y, items),
        pickFolder: async () => {
          const r = await openDialog({ directory: true, multiple: false });
          return typeof r === "string" ? r : null;
        },
        pickFiles: async () => {
          const r = await openDialog({ directory: false, multiple: true });
          return Array.isArray(r) ? r : r ? [r] : [];
        },
        copy: (text: string) => invoke<void>("clipboard_write", { text }),
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
        open: (path: string, opts?: { line?: number; column?: number; preview?: boolean }) => editors.openFile(path, opts).then((d) => (d ? editors.info(d) : null)),
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
        /** Another editor for some files, offered by "Reopen Editor With…" and the breadcrumbs. */
        registerEditorType: (type: EditorType) => track(editors.registerEditorType(type)),
        /** A pane beside the editor (one at a time), like a second editor group. */
        openSide: (spec: SidePaneSpec) => editors.openSide(spec),
        closeSide: () => editors.closeSide(),
        /** A page over the workbench (VS Code's modal editor); a tab when the modal is turned off. */
        openPage: (spec: CustomTabSpec) => editors.openPage(spec),
      },

      workspace: {
        folder: () => workspace.folder,
        setFolder: (path: string | null) => workspace.set(path),
        onDidChangeFolder: (fn: (folder: string | null) => void) => track(workspace.onDidChange.event(fn)),
        listFiles: (limit?: number) => (workspace.folder ? call<string[]>("fs_list_files", { root: workspace.folder, limit }) : Promise.resolve([])),
      },

      fs: {
        readText: (path: string) => call<{ text: string; binary: boolean; bom: boolean; eol: "\n" | "\r\n" }>("fs_read_text", { path }),
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

      process: {
        which: (program: string) => call<string | null>("proc_which", { program }),
        /** Runs a program; output streams to onData, the end to onExit. */
        spawn: async (
          program: string,
          args: string[],
          opts: { cwd?: string; stdin?: string; env?: Record<string, string>; onData?: (data: string, stream: "stdout" | "stderr") => void; onExit?: (code: number | null) => void } = {},
        ) => {
          const id = await call<number>("proc_spawn", { program, args, cwd: opts.cwd ?? workspace.folder ?? undefined, stdin: opts.stdin, env: opts.env });
          let resolveDone: (code: number | null) => void;
          const done = new Promise<number | null>((r) => (resolveDone = r));
          // A quick program may have exited already: its buffered exit then arrives inside onStream,
          // before offExit is assigned — so the cleanup must not need it yet.
          let offExit: (() => void) | null = null;
          let exited = false;
          const offData = onStream("proc://data", id, (p) => opts.onData?.(p.data, p.stream));
          offExit = onStream("proc://exit", id, (p) => {
            exited = true;
            offData();
            offExit?.();
            opts.onExit?.(p.code);
            resolveDone(p.code);
          });
          if (exited) offExit();
          return { id, done, kill: () => invoke("proc_kill", { id }) };
        },
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

      settings: {
        all: () => invoke<Record<string, unknown>>("settings_get", { modId }),
        get: async <T>(key: string, fallback: T): Promise<T> => {
          const all = await invoke<Record<string, unknown>>("settings_get", { modId });
          return (key in all ? all[key] : fallback) as T;
        },
        set: (key: string, value: unknown) => invoke("settings_set", { modId, key, value }),
      },

      mods: {
        /** What another enabled mod exported from activate() — activating it if needed. */
        get: (id: string) => (host.mods.has(id) ? host.activate(id) : Promise.resolve(undefined)),
        isEnabled: (id: string) => host.mods.has(id),
      },

      ui: { h, icon, iconButton, clear, basename, dirname, joinPath, fileIcon, fileIconColor, fileIconEl },
    });
  }
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

