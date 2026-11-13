// The editor area: tabs, one Monaco editor whose model changes with the active tab, custom tabs
// (the Mods page, an edit proposal, anything a mod opens), and the core status bar items.
// This is the whole "notepad" — it works with no mod enabled.

import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import cssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import htmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { invoke, TextFile } from "./ipc";
import { h, icon, clear, basename, dirname, Disposable, toDisposable, fileIcon } from "./ui";
import { fileIconEl, configureFileIcons } from "./fileIcons";
import { Emitter } from "./events";
import { Workbench, StatusHandle } from "./workbench";
import { dialog, notify, pick, contextMenu, MenuItem } from "./widgets";
import { bindEditorContextMenu } from "./menus";
import * as commands from "./commands";
import { leave, play } from "./motion";
import { openModal, closeModal, ModalAction } from "./modal";

/** VS Code's default: 12 on macOS, 14 elsewhere. */
export const DEFAULT_FONT_SIZE = navigator.platform.toLowerCase().includes("mac") ? 12 : 14;

(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// The TypeScript service here sees one file at a time, not the project: imports it cannot find are
// not errors to show (VS Code, which sees the project, would resolve them).
{
  const ts = monaco.typescript;
  const ignore = [2307, 2792, 7016, 2875, 2306, 1149, 2691, 5097];
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), diagnosticCodesToIgnore: ignore });
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      resolveJsonModule: true,
    });
  }
}

export interface TextDoc {
  kind: "text";
  id: string;
  path: string | null;
  title: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  bom: boolean;
  lossy: boolean;
  untitled?: number;
  viewState: monaco.editor.ICodeEditorViewState | null;
  preview: boolean;
}

export interface CustomTabSpec {
  title: string;
  icon?: string;
  /** The file this tab shows another view of (a preview): its editor type picker offers the text editor back. */
  forPath?: string;
  /** Which editor type this tab is (see `registerEditorType`). */
  editorType?: string;
  /** Opening a second tab with the same key focuses the first. */
  key?: string;
  /** Lets the session reopen it after a restart. */
  restore?: string;
  render(container: HTMLElement): void | Disposable;
  /** Return false to keep the tab open. */
  onClose?(): boolean | Promise<boolean>;
}

export interface CustomDoc {
  kind: "custom";
  id: string;
  title: string;
  spec: CustomTabSpec;
  /** A preview tab (single click in the explorer on a file a mod's editor type opens): the next preview replaces it. */
  preview?: boolean;
  el?: HTMLElement;
  disposable?: Disposable | void;
}

export type Doc = TextDoc | CustomDoc;

/** An icon in the tab bar for the active editor (VS Code's editor/title menu). */
export interface TitleAction {
  id: string;
  icon: string;
  title: string;
  /** Lower comes first (left). */
  order?: number;
  /** Shown only while this is true for the active editor. */
  when?: (info: EditorInfo) => boolean;
  run: (info: EditorInfo) => void;
}

/** Another way to show a file ("Reopen Editor With…"), e.g. a Markdown preview. */
export interface EditorType {
  id: string;
  label: string;
  /** The files it opens by default (VS Code's custom editor priority "default"): they open straight
   *  in it, never as text first; "Reopen Editor With…" still offers the text editor. Off: only offered. */
  default?: boolean;
  /** False for files it shows that have no text form (a PNG): "Reopen Editor With…" then leaves out
   *  the text editor. Default: offered. */
  hasText?: (info: EditorInfo) => boolean;
  when: (info: EditorInfo) => boolean;
  open: (info: EditorInfo) => void;
}

/** One step of the breadcrumbs after the file name: a key, a heading… `line` is where clicking goes. */
export interface BreadcrumbCrumb {
  name: string;
  line: number;
  /** A codicon (default: symbol-field). */
  icon?: string;
}

/** Where the cursor is inside a file, for the breadcrumbs. Mods offer them per language. */
export interface BreadcrumbProvider {
  languages: string[];
  path(text: string, line: number, column: number): BreadcrumbCrumb[];
}

/** A pane beside the editor (`openSide`). */
export interface SidePaneSpec {
  title: string;
  icon?: string;
  render(container: HTMLElement): void | Disposable;
  /** Icons in the pane's tab bar, before its close button (the mod's own, like "Maximize"). */
  actions?: SidePaneAction[];
  /** Called after the pane is maximized over the editor or restored (`maximizeSide`). */
  onDidChangeMaximized?(maximized: boolean): void;
}

export interface SidePaneAction {
  id: string;
  icon: string;
  title: string;
  run(e: MouseEvent): void;
}

/** A tab moved to another window: its file, and its text when it has unsaved changes. */
export interface DetachedTab {
  path: string | null;
  title: string;
  text?: string;
  language?: string;
  line?: number;
  column?: number;
}

export interface EditorInfo {
  id: string;
  /** "default" for the text editor; a mod's editor type id for its view of a file (a preview). */
  editorType?: string;
  path: string | null;
  title: string;
  language: string;
  dirty: boolean;
  active: boolean;
}

export type EditProposal = { newText: string } | { edits: { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string }[] };

let nextId = 1;

configureFileIcons({ languageOf: (name) => detectLanguage(name) });

export function detectLanguage(path: string): string {
  const name = basename(path).toLowerCase();
  const langs = monaco.languages.getLanguages();
  for (const l of langs) if (l.filenames?.some((f) => f.toLowerCase() === name)) return l.id;
  const special: Record<string, string> = { ".zshrc": "shell", ".bashrc": "shell", ".bash_profile": "shell", ".zprofile": "shell", ".profile": "shell", ".gitignore": "ini", ".npmrc": "ini", ".editorconfig": "ini", makefile: "plaintext" };
  if (special[name]) return special[name];
  if (name.startsWith(".env")) return "ini";
  let best = "";
  let bestId = "plaintext";
  for (const l of langs) {
    for (const ext of l.extensions ?? []) {
      const e = ext.toLowerCase();
      if (name.endsWith(e) && e.length > best.length) {
        best = e;
        bestId = l.id;
      }
    }
  }
  return bestId;
}

function languageName(id: string): string {
  const l = monaco.languages.getLanguages().find((x) => x.id === id);
  return l?.aliases?.[0] ?? id;
}

export class EditorService {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  private docs: Doc[] = [];
  private active: Doc | null = null;
  private monacoHost: HTMLElement;
  private customHost: HTMLElement;
  private watermark: HTMLElement;
  private history: string[] = [];
  private knownTabs = new Set<string>();
  private lastActiveTab: string | null = null;
  private lastShown: Doc | null | undefined = undefined;
  /** Off while the session is being restored, so reopening tabs does not play. */
  motionReady = false;
  private historyIndex = -1;
  private fontSize = DEFAULT_FONT_SIZE;
  private zoom = 1;
  private status: Record<"position" | "indent" | "encoding" | "eol" | "language", StatusHandle>;

  readonly onDidChangeActive = new Emitter<EditorInfo | null>();
  readonly onDidChangeDocs = new Emitter<void>();
  readonly onDidSave = new Emitter<EditorInfo>();
  readonly onDidChangeContent = new Emitter<EditorInfo>();
  /** ⌘+ / ⌘- on the editor font: the profile keeps the size. */
  readonly onDidChangeFontSize = new Emitter<number>();
  /** Custom tabs the session knows how to reopen, by `restore` key. */
  readonly restorers = new Map<string, () => void>();
  /** A tab dragged out of the window, or "Move into New Window": main.ts opens the window. */
  detachTab: ((tab: DetachedTab, at?: { x: number; y: number }) => void) | null = null;
  /** workbench.tabs.dragToWindow */
  dragTabsToWindow = true;

  constructor(private wb: Workbench) {
    // `monaco-component`: Monaco defines its --vscode-* colors on that class, and puts the context
    // menu (in a shadow root) in this host, outside `.monaco-editor`: without it the menu has no background.
    this.monacoHost = h("div", { class: "monaco-host monaco-component" });
    this.customHost = h("div", { class: "custom-host" });
    this.watermark = this.buildWatermark();
    wb.editorBody.append(this.monacoHost, this.customHost, this.watermark);
    // …and so does one on the tab bar's empty space, after the last tab.
    wb.editorTabs.addEventListener("dblclick", (e) => {
      if (e.target === wb.editorTabs) this.newUntitled();
    });
    this.editor = monaco.editor.create(this.monacoHost, {
      // Laid out by our own ResizeObserver below, not `automaticLayout`: Monaco's defers the
      // layout a frame, so on a window resize the minimap canvas is cleared and painted a frame
      // later, and it flickers.
      automaticLayout: false,
      fontFamily: "Menlo, 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace",
      fontSize: this.fontSize,
      lineHeight: 0,
      // VS Code's defaults: real characters, proportional, 120 columns.
      minimap: { enabled: true, renderCharacters: true, size: "proportional", scale: 1, maxColumn: 120, showSlider: "mouseover" },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      renderLineHighlight: "all",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      stickyScroll: { enabled: true },
      padding: { top: 4 },
      fixedOverflowWidgets: true,
      // No translate3d layer per scrollable part: ~25 MB less in the web content process, measured.
      disableLayerHinting: true,
      "semanticHighlighting.enabled": true,
      wordWrap: "off",
    });
    // Mods' items in the editor's right-click menu (`editor/context`).
    bindEditorContextMenu(
      this.editor,
      () => {
        const doc = this.activeText();
        const sel = this.editor.getSelection();
        return { path: doc?.path ?? null, language: doc?.model.getLanguageId() ?? "", selection: sel && doc ? doc.model.getValueInRange(sel) : "" };
      },
      (x, y, items) => contextMenu(x, y, items),
    );
    // Resize and paint in the same frame, before the browser draws: no blank minimap frame.
    let last = "";
    new ResizeObserver(() => {
      const width = this.monacoHost.clientWidth, height = this.monacoHost.clientHeight;
      const key = `${width}x${height}`;
      if (key === last || !width || !height) return;
      last = key;
      this.editor.layout({ width, height });
      this.editor.render(true);
    }).observe(this.monacoHost);
    this.editor.onDidChangeCursorPosition(() => {
      this.paintStatus();
      this.scheduleSymbols();
    });
    this.editor.onDidChangeCursorSelection(() => this.paintStatus());
    this.editor.onDidChangeModelLanguage(() => this.scheduleSymbols());
    this.editor.onDidChangeModelContent(() => {
      const doc = this.active;
      if (doc?.kind === "text") {
        if (doc.preview) doc.preview = false;
        this.renderTabs();
        this.updatePlaceholder();
        this.onDidChangeContent.fire(this.info(doc));
        this.scheduleAutoSave(doc);
      }
    });

    this.status = {
      position: wb.addStatus({ align: "right", priority: 100, command: "editor.gotoLine", tooltip: "Go to Line/Column" }),
      indent: wb.addStatus({ align: "right", priority: 90, command: "editor.indentation", tooltip: "Select Indentation" }),
      encoding: wb.addStatus({ align: "right", priority: 80, tooltip: "Encoding" }),
      eol: wb.addStatus({ align: "right", priority: 70, command: "editor.toggleEol", tooltip: "Select End of Line Sequence" }),
      language: wb.addStatus({ align: "right", priority: 60, command: "editor.changeLanguage", tooltip: "Select Language Mode" }),
    };
    wb.addStatus({ align: "right", priority: -100, icon: "bell", tooltip: "No new notifications" });

    wb.editorTabsActions.append(
      this.titleActionsHost,
      h("button", { class: "icon-button", title: "Split Editor (coming soon)", disabled: true }, icon("split-horizontal")),
      h("button", { class: "icon-button", title: "Views and More Actions…", onclick: (e: MouseEvent) => this.moreMenu(e) }, icon("ellipsis")),
    );
    this.registerCommands();
    this.show(null);
  }

  // ---------- queries ----------

  info(doc: Doc): EditorInfo {
    if (doc.kind === "custom") return { id: doc.id, path: null, title: doc.title, language: "", dirty: false, active: doc === this.active };
    return { id: doc.id, path: doc.path, title: doc.title, language: doc.model.getLanguageId(), dirty: this.isDirty(doc), active: doc === this.active };
  }

  list(): EditorInfo[] {
    return this.docs.map((d) => this.info(d));
  }

  activeInfo(): EditorInfo | null {
    return this.active ? this.info(this.active) : null;
  }

  activeText(): TextDoc | null {
    return this.active?.kind === "text" ? this.active : null;
  }

  isDirty(doc: TextDoc): boolean {
    return doc.model.getAlternativeVersionId() !== doc.savedVersion;
  }

  find(idOrPath: string): TextDoc | undefined {
    return this.docs.find((d): d is TextDoc => d.kind === "text" && (d.id === idOrPath || d.path === idOrPath));
  }

  activateById(id: string): boolean {
    const doc = this.docs.find((d) => d.id === id);
    if (doc) this.activate(doc);
    return !!doc;
  }

  textOf(idOrPath: string): string | undefined {
    return this.find(idOrPath)?.model.getValue();
  }

  selection(): { text: string; startLine: number; startColumn: number; endLine: number; endColumn: number } | null {
    const doc = this.activeText();
    const sel = this.editor.getSelection();
    if (!doc || !sel) return null;
    return { text: doc.model.getValueInRange(sel), startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn };
  }

  // ---------- opening ----------

  newUntitled(text = "", language = "plaintext"): TextDoc {
    const used = new Set(this.docs.map((d) => (d.kind === "text" ? d.untitled : undefined)));
    let n = 1;
    while (used.has(n)) n++;
    const model = monaco.editor.createModel(text, language, monaco.Uri.parse(`untitled:Untitled-${n}`));
    const doc: TextDoc = { kind: "text", id: `doc-${nextId++}`, path: null, title: `Untitled-${n}`, model, savedVersion: text ? -1 : model.getAlternativeVersionId(), bom: false, lossy: false, untitled: n, viewState: null, preview: false };
    this.docs.push(doc);
    this.activate(doc);
    return doc;
  }

  /** The preview tab the next preview replaces: a text one without changes, or a mod's. */
  private replaceablePreview(): Doc | undefined {
    return this.docs.find((d) => (d.kind === "text" ? d.preview && !this.isDirty(d) : !!d.preview));
  }

  /** Closes a tab being replaced, at once (no closing animation: the new one is already in its place). */
  private async dropTab(doc: Doc) {
    const motion = this.motionReady;
    this.motionReady = false;
    try {
      await this.close(doc, true);
    } finally {
      this.motionReady = motion;
    }
  }

  /** `asText`: the text editor itself, never a mod's editor type (a binary file then gets the notice). */
  async openFile(path: string, opts: { line?: number; column?: number; preview?: boolean; background?: boolean; asText?: boolean } = {}): Promise<TextDoc | null> {
    let doc = this.find(path);
    // A mod's editor that opens this kind of file by default takes it before anything is read as text.
    if (!doc && !opts.asText) {
      const info: EditorInfo = { id: "", editorType: "default", path, title: basename(path), language: detectLanguage(path), dirty: false, active: true };
      const claim = this.typesFor(info).find((t) => t.default);
      if (claim) {
        const asPreview = !!opts.preview && this.previewEnabled;
        const previous = asPreview ? this.replaceablePreview() : undefined;
        const before = new Set(this.docs);
        claim.open(info);
        // Preview tabs work as for text: a single click opens one in the place of the last preview.
        const now = this.active;
        if (now?.kind === "custom") {
          if (!before.has(now)) {
            now.preview = asPreview;
            if (previous && previous !== now) {
              this.docs.splice(this.docs.indexOf(now), 1);
              this.docs.splice(this.docs.indexOf(previous), 0, now);
              void this.dropTab(previous);
            }
          } else if (!opts.preview) now.preview = false;
          this.renderTabs();
        }
        return null;
      }
    }
    if (!doc) {
      let file: TextFile;
      try {
        file = await invoke<TextFile>("fs_read_text", { modId: "core", path });
      } catch (e) {
        notify("error", String(e));
        return null;
      }
      if (file.binary) {
        // The text editor cannot show it: a mod's editor type that claims the file (an image viewer)
        // opens it; otherwise a notice, which keeps the path (`forPath`) so mods and "Reopen Editor
        // With…" still know which file it is.
        const info: EditorInfo = { id: "", editorType: "default", path, title: basename(path), language: detectLanguage(path), dirty: false, active: true };
        const type = opts.asText ? undefined : this.typesFor(info)[0];
        if (type) type.open(info);
        else this.openCustom({ title: basename(path), icon: "file-binary", key: `binary:${path}`, forPath: path, render: (el) => el.append(h("div", { class: "notice" }, h("p", null, `${basename(path)} is a binary file or too large to open as text (${(file.size / 1024).toFixed(0)} KB).`))) });
        return null;
      }
      const uri = monaco.Uri.file(path);
      monaco.editor.getModel(uri)?.dispose();
      const model = monaco.editor.createModel(file.text, detectLanguage(path), uri);
      model.setEOL(file.eol === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      doc = { kind: "text", id: `doc-${nextId++}`, path, title: basename(path), model, savedVersion: model.getAlternativeVersionId(), bom: file.bom, lossy: file.lossy, viewState: null, preview: !!opts.preview && this.previewEnabled };
      // A preview tab (single click in the explorer) is replaced by the next preview.
      const previewDoc = opts.preview && this.previewEnabled ? this.replaceablePreview() : undefined;
      if (previewDoc?.kind === "text") {
        const i = this.docs.indexOf(previewDoc);
        this.docs.splice(i, 1, doc);
        previewDoc.model.dispose();
      } else if (previewDoc) {
        // A mod's preview tab (an image): this one takes its place, and it goes.
        this.docs.splice(this.docs.indexOf(previewDoc), 0, doc);
        void this.dropTab(previewDoc);
      } else {
        this.docs.push(doc);
      }
      if (file.lossy) notify("warning", `${basename(path)} is not valid UTF-8. Characters that could not be read were replaced; saving will write UTF-8.`);
    } else if (!opts.preview) {
      doc.preview = false;
    }
    if (!opts.background) this.activate(doc);
    if (opts.line) {
      const pos = { lineNumber: opts.line, column: opts.column ?? 1 };
      this.editor.setPosition(pos);
      this.editor.revealPositionInCenter(pos);
    }
    if (!opts.background) this.editor.focus();
    return doc;
  }

  async openWithDialog() {
    const picked = await openDialog({ multiple: true, directory: false });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const p of list) if (await this.openFile(p)) invoke("recent_add", { path: p });
  }

  openCustom(spec: CustomTabSpec): CustomDoc {
    const existing = spec.key ? this.docs.find((d): d is CustomDoc => d.kind === "custom" && d.spec.key === spec.key) : undefined;
    if (existing) {
      this.activate(existing);
      return existing;
    }
    const doc: CustomDoc = { kind: "custom", id: `doc-${nextId++}`, title: spec.title, spec };
    this.docs.push(doc);
    this.activate(doc);
    return doc;
  }

  /** Opens the editor's pages (Settings, Mods…) over the workbench, like VS Code's modal editor. */
  useModal = true;
  private restoringPage = false;

  /** A page: in the modal editor (or a tab when the modal is off or the page is already a tab). */
  openPage(spec: CustomTabSpec & { actions?: ModalAction[] }) {
    const tab = spec.key ? this.docs.find((d): d is CustomDoc => d.kind === "custom" && d.spec.key === spec.key) : undefined;
    if (!this.useModal || tab || this.restoringPage) return void this.openCustom(spec);
    openModal({
      title: spec.title,
      icon: spec.icon,
      actions: spec.actions,
      moveToMain: () => this.openCustom(spec),
      render: (el) => {
        const inner = h("div", { style: { position: "absolute", inset: "0", overflow: "auto" } });
        el.append(inner);
        // The vertical scrollbar takes its width on the right: the same on the left keeps the
        // page centered, with equal margins on both sides (0 while nothing scrolls).
        const balance = () => {
          const bar = inner.offsetWidth - inner.clientWidth;
          inner.style.paddingLeft = bar > 0 ? `${bar}px` : "";
        };
        const sizes = new ResizeObserver(balance);
        sizes.observe(inner);
        const watchChildren = () => { for (const c of inner.children) sizes.observe(c); };
        const kids = new MutationObserver(() => { watchChildren(); balance(); });
        kids.observe(inner, { childList: true });
        const disposable = spec.render(inner);
        watchChildren();
        balance();
        return toDisposable(() => {
          sizes.disconnect();
          kids.disconnect();
          disposable?.dispose();
        });
      },
    });
  }

  // ---------- tab bar actions & editor types ----------

  private titleActions = new Map<string, TitleAction>();
  private titleActionsHost = h("div", { class: "title-actions" });
  private editorTypes = new Map<string, EditorType>();

  addTitleAction(action: TitleAction): Disposable {
    this.titleActions.set(action.id, action);
    this.renderTitleActions();
    return toDisposable(() => {
      if (this.titleActions.get(action.id) === action) this.titleActions.delete(action.id);
      this.renderTitleActions();
    });
  }

  /** Repaints the tab bar's icons (a mod's `when` changed: a file got changes, a setting flipped). */
  renderTitleActions() {
    const host = this.titleActionsHost;
    clear(host);
    const info = this.activeFile()?.info ?? this.activeInfo();
    if (!info) return;
    const shown = [...this.titleActions.values()].filter((a) => {
      try {
        return !a.when || a.when(info);
      } catch {
        return false;
      }
    });
    shown.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const a of shown) host.append(h("button", { class: "icon-button", title: a.title, onclick: () => a.run(this.activeFile()?.info ?? this.activeInfo() ?? info) }, icon(a.icon)));
  }

  /** A file in a mod's editor type by id. The session is restored before mods start: until that type
   *  is registered the tab waits (with a way to open the file as text), and turns into it then. */
  private openWithType(typeId: string, path: string): Doc | null {
    const info: EditorInfo = { id: "", editorType: "default", path, title: basename(path), language: detectLanguage(path), dirty: false, active: true };
    const type = this.editorTypes.get(typeId);
    if (type) {
      type.open(info);
      return this.active;
    }
    return this.openCustom({
      title: basename(path),
      icon: "loading",
      key: `pending:${typeId}:${path}`,
      forPath: path,
      editorType: typeId,
      render: (el) =>
        el.append(
          h("div", { class: "notice" },
            h("p", null, `Waiting for the editor that shows ${basename(path)}. If its mod is off, `),
            h("button", { class: "btn secondary", onclick: () => this.openFile(path, { asText: true }) }, "Open in Text Editor"),
          ),
        ),
    });
  }

  /** Waiting tabs (above) for this type become its view of the file, in place. */
  private fulfillPending(type: EditorType) {
    const waiting = this.docs.filter((d): d is CustomDoc => d.kind === "custom" && !!d.spec.key?.startsWith(`pending:${type.id}:`));
    if (!waiting.length) return;
    const before = this.active;
    for (const old of waiting) {
      const path = old.spec.forPath!;
      const wasActive = old === before;
      try {
        type.open({ id: "", editorType: "default", path, title: basename(path), language: detectLanguage(path), dirty: false, active: wasActive });
      } catch (e) {
        console.warn("editor type", type.id, e);
        continue;
      }
      const now = this.active;
      if (now && now !== old) {
        this.docs.splice(this.docs.indexOf(now), 1);
        this.docs.splice(this.docs.indexOf(old), 0, now);
        void this.close(old, true);
      }
      if (!wasActive && before && this.docs.includes(before)) this.activate(before, false);
    }
    this.renderTabs();
  }

  registerEditorType(type: EditorType): Disposable {
    this.editorTypes.set(type.id, type);
    this.fulfillPending(type);
    this.paintBreadcrumbs(this.active);
    return toDisposable(() => {
      if (this.editorTypes.get(type.id) === type) this.editorTypes.delete(type.id);
      this.paintBreadcrumbs(this.active);
    });
  }

  /** The file the active editor shows (a text editor's path, or a preview's `forPath`). */
  private activeFile(): { info: EditorInfo; path: string | null; type: string } | null {
    const doc = this.active;
    if (!doc) return null;
    if (doc.kind === "text") return { info: { ...this.info(doc), editorType: "default" }, path: doc.path, type: "default" };
    if (!doc.spec.forPath) return null;
    const text = this.find(doc.spec.forPath);
    const language = text ? text.model.getLanguageId() : detectLanguage(doc.spec.forPath);
    return { info: { ...this.info(doc), path: doc.spec.forPath, language, editorType: doc.spec.editorType ?? "custom" }, path: doc.spec.forPath, type: doc.spec.editorType ?? "custom" };
  }

  private typesFor(info: EditorInfo): EditorType[] {
    return [...this.editorTypes.values()].filter((t) => {
      try {
        return t.when(info);
      } catch {
        return false;
      }
    });
  }

  /** "Reopen Editor With…": the text editor or a mod's view of the same file, in the same tab. */
  /** What "Reopen Editor With…" offers for a file: the text editor (unless a type says the file has no
   *  text form) and every mod's type that shows it. */
  private reopenChoices(cur: { info: EditorInfo; type: string }) {
    const types = this.typesFor(cur.info);
    const noText = types.some((t) => {
      try {
        return t.hasText?.(cur.info) === false;
      } catch {
        return false;
      }
    });
    return [
      ...(noText ? [] : [{ id: "default", label: "Text Editor", description: cur.type === "default" ? "Active" : "Built-in" }]),
      ...types.map((t) => ({ id: t.id, label: t.label, description: cur.type === t.id ? "Active" : "" })),
    ];
  }

  /** Whether "Reopen Editor With…" has anything other than the editor already showing the file. */
  private canReopen(file: { info: EditorInfo; path: string | null; type: string } | null): boolean {
    return !!file?.path && this.reopenChoices(file).some((c) => c.id !== file.type);
  }

  async reopenWith() {
    const cur = this.activeFile();
    if (!cur?.path) return;
    const items = this.reopenChoices(cur);
    const picked = await pick(items, { placeholder: `Select editor for '${basename(cur.path)}'` });
    if (!picked || picked.id === cur.type) return;
    const old = this.active;
    if (picked.id === "default") await this.openFile(cur.path, { asText: true });
    else this.editorTypes.get(picked.id)?.open(cur.info);
    // Same tab, other view: it takes the old one's place, which goes away (unless it has unsaved changes).
    const now = this.active;
    if (old && now && old !== now) {
      const from = this.docs.indexOf(now);
      this.docs.splice(from, 1);
      this.docs.splice(this.docs.indexOf(old) + 1, 0, now);
      this.renderTabs();
      if (!(old.kind === "text" && this.isDirty(old))) await this.close(old);
    }
  }

  // ---------- the pane to the side ----------

  private side: { spec: SidePaneSpec; el: HTMLElement; actions: HTMLElement; disposable?: Disposable | void } | null = null;
  private sideWidth = 0;
  private sideMaximized = false;

  /** Shows a pane beside the editor (VS Code opens a second group there): one at a time. */
  openSide(spec: SidePaneSpec) {
    this.closeSide();
    const wb = this.wb;
    const side = wb.editorSide;
    const body = h("div", { class: "editor-side-body" });
    // Drawn like the tab bar of a second editor group, with its one tab.
    const header = h(
      "div",
      { class: "tabs editor-side-header" },
      h(
        "div",
        { class: "tabs-scroll" },
        h(
          "div",
          { class: "tab active", title: spec.title },
          h("span", { class: "tab-flare", "aria-hidden": "true" }),
          icon(spec.icon ?? "file", "tab-icon"),
          h("span", { class: "label" }, spec.title),
          h("div", { class: "tab-close", title: "Close", onclick: () => this.closeSide() }, icon("close")),
        ),
      ),
      h("div", { class: "tabs-actions" }),
    );
    const actions = header.lastElementChild as HTMLElement;
    side.replaceChildren(header, body);
    side.style.display = "";
    wb.editorSideSash.style.display = "";
    const group = side.parentElement!;
    if (!this.sideWidth) this.sideWidth = Math.round(group.clientWidth / 2);
    side.style.width = `${Math.max(160, Math.min(this.sideWidth, group.clientWidth - 160))}px`;
    this.side = { spec, el: body, actions };
    this.renderSideActions();
    try {
      this.side.disposable = spec.render(body);
    } catch (e) {
      body.append(h("div", { class: "notice" }, String(e)));
    }
    if (!wb.editorSideSash.dataset.wired) {
      wb.editorSideSash.dataset.wired = "1";
      wb.editorSideSash.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const sash = wb.editorSideSash;
        sash.setPointerCapture(e.pointerId);
        sash.classList.add("dragging");
        const x0 = e.clientX;
        const w0 = side.offsetWidth;
        const move = (ev: PointerEvent) => {
          const max = side.parentElement!.clientWidth - 160;
          this.sideWidth = Math.max(160, Math.min(max, w0 - (ev.clientX - x0)));
          side.style.width = `${this.sideWidth}px`;
        };
        const up = () => {
          sash.classList.remove("dragging");
          sash.removeEventListener("pointermove", move);
          sash.removeEventListener("pointerup", up);
        };
        sash.addEventListener("pointermove", move);
        sash.addEventListener("pointerup", up);
      });
    }
  }

  /** The pane's tab bar icons: its own (`spec.actions`), then Close. */
  renderSideActions() {
    if (!this.side) return;
    const { spec, actions } = this.side;
    actions.replaceChildren(
      ...(spec.actions ?? []).map((a) => h("button", { class: "icon-button", title: a.title, dataset: { action: a.id }, onclick: (e: MouseEvent) => a.run(e) }, icon(a.icon))),
      h("button", { class: "icon-button", title: "Close Editor to the Side", onclick: () => this.closeSide() }, icon("close")),
    );
  }

  /** The pane over the whole editor group (true), or back beside the editor (false); toggles with no argument. */
  maximizeSide(on?: boolean) {
    if (!this.side) return false;
    const next = on ?? !this.sideMaximized;
    if (next === this.sideMaximized) return next;
    this.sideMaximized = next;
    this.wb.editorSide.parentElement?.classList.toggle("side-maximized", next);
    try {
      this.side.spec.onDidChangeMaximized?.(next);
    } catch (e) {
      console.error(e);
    }
    this.renderSideActions();
    return next;
  }

  isSideMaximized() {
    return !!this.side && this.sideMaximized;
  }

  closeSide() {
    if (!this.side) return;
    if (this.sideMaximized) {
      this.sideMaximized = false;
      this.wb.editorSide.parentElement?.classList.remove("side-maximized");
    }
    try {
      this.side.disposable?.dispose();
    } catch (e) {
      console.error(e);
    }
    this.side = null;
    this.wb.editorSide.replaceChildren();
    this.wb.editorSide.style.display = "none";
    this.wb.editorSideSash.style.display = "none";
  }

  sideOpen(): string | null {
    return this.side?.spec.title ?? null;
  }

  // ---------- activation & rendering ----------

  activate(doc: Doc, recordHistory = true) {
    // Something opened in the main window (a file from Settings' "Edit as JSON"): the modal makes way.
    if (!this.restoringPage) closeModal();
    if (this.active === doc) return this.show(doc);
    if (this.active?.kind === "text") this.active.viewState = this.editor.saveViewState();
    // Auto Save "when the editor loses focus": the editor being left is saved.
    if (this.autoSave === "onFocusChange" && this.active?.kind === "text") this.autoSaveNow(this.active);
    this.active = doc;
    if (recordHistory) {
      this.history = this.history.slice(0, this.historyIndex + 1).filter((id) => id !== doc.id);
      this.history.push(doc.id);
      this.historyIndex = this.history.length - 1;
    }
    this.show(doc);
    this.onDidChangeActive.fire(this.info(doc));
  }

  /** How a file shows (git letter and color), from the mods' decorations (set by the workbench). */
  decorate: (path: string) => { badge?: string; color?: string } | undefined = () => undefined;

  /** "Enable Preview Editors": a single click opens a file in a tab the next one replaces. */
  previewEnabled = true;
  /** files.autoSave: when files on disk save by themselves. */
  autoSave: "off" | "afterDelay" | "onFocusChange" | "onWindowChange" = "off";
  autoSaveDelay = 1000;
  private autoSaveTimers = new Map<string, number>();

  /** The ··· of the tab bar, as in VS Code. */
  private moreMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const has = (id: string) => commands.has(id);
    const active = this.activeText();
    const items: MenuItem[] = [];
    if (has("git.stageActive") && active?.path) items.push({ label: "Stage Changes", run: () => commands.execute("git.stageActive") }, { label: "Open Changes", run: () => commands.execute("git.openChange") }, { separator: true, label: "" });
    items.push(
      { label: "Show Opened Editors", run: () => commands.execute("editor.showOpened") },
      { separator: true, label: "" },
      { label: "Close All", keybinding: "mod+k w", disabled: !this.docs.length, run: () => commands.execute("editor.closeAll") },
      { label: "Close Saved", keybinding: "mod+k u", disabled: !this.docs.some((d) => d.kind !== "text" || !this.isDirty(d)), run: () => commands.execute("editor.closeSaved") },
      { separator: true, label: "" },
      { label: "Enable Preview Editors", checked: this.previewEnabled, run: () => commands.execute("editor.togglePreview") },
      { separator: true, label: "" },
      { label: "Configure Editors", run: () => commands.execute("preferences.settings") },
    );
    const file = this.activeFile();
    if (this.canReopen(file)) items.push({ label: "Reopen Editor With…", run: () => this.reopenWith() });
    contextMenu(r.right - 220, r.bottom + 4, items, { menu: "editor/title", context: file?.info ?? this.activeInfo() });
  }

  /** Right click on a tab, as in VS Code. */
  private tabMenu(e: MouseEvent, doc: Doc) {
    const idx = this.docs.indexOf(doc);
    const path = doc.kind === "text" ? doc.path : undefined;
    const root = this.breadcrumbRoot();
    const rel = path && root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const copy = async (text: string) => {
      await invoke("clipboard_write", { text });
      notify("info", "Copied to the clipboard.", [], 2000);
    };
    const closeEach = async (list: Doc[]) => {
      for (const d of list) if (!(await this.close(d))) break;
    };
    const items: MenuItem[] = [
      { label: "Close", keybinding: "mod+w", run: () => this.close(doc) },
      { label: "Close Others", disabled: this.docs.length < 2, run: () => closeEach(this.docs.filter((d) => d !== doc)) },
      { label: "Close to the Right", disabled: idx === this.docs.length - 1, run: () => closeEach(this.docs.slice(idx + 1)) },
      { label: "Close Saved", keybinding: "mod+k u", disabled: !this.docs.some((d) => d.kind !== "text" || !this.isDirty(d)), run: () => commands.execute("editor.closeSaved") },
      { label: "Close All", keybinding: "mod+k w", run: () => commands.execute("editor.closeAll") },
    ];
    if (path) {
      items.push(
        { separator: true, label: "" },
        { label: "Copy Path", run: () => copy(path) },
        { label: "Copy Relative Path", run: () => copy(rel ?? path) },
        { separator: true, label: "" },
        { label: isMac ? "Reveal in Finder" : "Reveal in File Explorer", run: () => invoke("fs_reveal", { modId: "core", path }).catch((err) => notify("error", String(err))) },
      );
      if (commands.has("explorer.revealActive")) items.push({ label: "Reveal in Explorer View", run: async () => { await this.activate(doc); commands.execute("explorer.revealActive"); } });
    }
    const file = doc === this.active ? this.activeFile() : null;
    if (this.canReopen(file)) items.push({ separator: true, label: "" }, { label: "Reopen Editor With…", run: () => this.reopenWith() });
    if (doc.preview)
      items.push({ separator: true, label: "" }, { label: "Keep Open", run: () => { doc.preview = false; this.renderTabs(); } });
    if (doc.kind === "text" && this.detachTab) items.push({ separator: true, label: "" }, { label: "Move into New Window", run: () => this.detach(doc) }, { label: "Copy into New Window", run: () => this.detach(doc, undefined, false) });
    const info = this.info(doc);
    contextMenu(e.clientX, e.clientY, items, { menu: "editor/tab", context: doc.kind === "custom" && doc.spec.forPath ? { ...info, path: doc.spec.forPath, editorType: doc.spec.editorType } : info });
  }

  /** Opens a text tab in a window of its own (keeping unsaved text), and closes it here unless `move` is false. */
  async detach(doc: Doc, at?: { x: number; y: number }, move = true) {
    if (doc.kind !== "text" || !this.detachTab) return;
    const pos = doc === this.active ? this.editor.getPosition() : null;
    const dirty = this.isDirty(doc);
    this.detachTab(
      {
        path: doc.path,
        title: doc.title,
        text: dirty || !doc.path ? doc.model.getValue() : undefined,
        language: doc.model.getLanguageId(),
        line: pos?.lineNumber,
        column: pos?.column,
      },
      at,
    );
    if (move) await this.close(doc, true);
  }

  /** Press on a tab and drag: along the tab bar to reorder, out of the window to open it in a new one. */
  private dragTab(down: MouseEvent, doc: Doc) {
    const startX = down.clientX;
    const startY = down.clientY;
    let ghost: HTMLElement | null = null;
    let before: string | null | undefined;
    const bar = this.wb.editorTabs;
    const outside = (e: MouseEvent) => e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
    const mark = (el: Element | null, after = false) => {
      bar.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      el?.classList.add(after ? "drop-after" : "drop-before");
    };
    const move = (e: MouseEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        ghost = h("div", { class: "view-drag-ghost tab-drag-ghost" }, h("span", null, doc.title));
        document.body.append(ghost);
        document.body.classList.add("view-dragging");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      const out = outside(e);
      ghost.classList.toggle("detaching", out && this.dragTabsToWindow && doc.kind === "text");
      const under = out ? null : (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null);
      const tab = under?.closest(".tab[data-doc]") as HTMLElement | null;
      if (tab && bar.contains(tab)) {
        const r = tab.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const ids = this.docs.map((d) => d.id);
        const i = ids.indexOf(tab.dataset.doc!);
        before = after ? ids[i + 1] ?? null : tab.dataset.doc!;
        mark(tab, after);
      } else if (under && bar.contains(under)) {
        before = null;
        mark(bar.lastElementChild, true);
      } else {
        before = undefined;
        mark(null);
      }
    };
    const end = (e: MouseEvent | null) => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", key, true);
      mark(null);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("view-dragging");
      if (!e) return;
      if (outside(e) && this.dragTabsToWindow && doc.kind === "text") {
        void this.detach(doc, { x: e.screenX, y: e.screenY });
        return;
      }
      if (before === undefined || before === doc.id) return;
      const from = this.docs.indexOf(doc);
      this.docs.splice(from, 1);
      const to = before === null ? this.docs.length : this.docs.findIndex((d) => d.id === before);
      this.docs.splice(to < 0 ? this.docs.length : to, 0, doc);
      this.renderTabs();
    };
    const up = (e: MouseEvent) => end(e);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        end(null);
      }
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", key, true);
  }

  private symbolCrumbs: HTMLElement | null = null;
  private symbolsFrame = 0;
  private breadcrumbProviders: BreadcrumbProvider[] = [];

  /** Breadcrumbs for some languages (the JSON & YAML mod's keys, the Markdown mod's headings). The last one registered for a language wins. */
  registerBreadcrumbs(provider: BreadcrumbProvider): Disposable {
    this.breadcrumbProviders.push(provider);
    this.scheduleSymbols();
    return {
      dispose: () => {
        const i = this.breadcrumbProviders.indexOf(provider);
        if (i >= 0) this.breadcrumbProviders.splice(i, 1);
        this.scheduleSymbols();
      },
    };
  }

  /** After the file in the breadcrumbs: where the cursor is, from the mod that knows the language. */
  private paintSymbols() {
    const host = this.symbolCrumbs;
    const doc = this.active;
    if (!host || doc?.kind !== "text" || this.editor.getModel() !== doc.model) return;
    const pos = this.editor.getPosition();
    const lang = doc.model.getLanguageId();
    const provider = [...this.breadcrumbProviders].reverse().find((p) => p.languages.includes(lang));
    let crumbs: BreadcrumbCrumb[] = [];
    if (pos && provider) {
      try {
        crumbs = provider.path(doc.model.getValue(), pos.lineNumber, pos.column) ?? [];
      } catch (e) {
        console.error("breadcrumbs:", e);
      }
    }
    clear(host);
    for (const c of crumbs)
      host.append(
        icon("chevron-right", "sep"),
        h(
          "span",
          {
            class: "crumb symbol",
            title: c.name,
            onclick: () => {
              this.editor.setPosition({ lineNumber: c.line, column: doc.model.getLineFirstNonWhitespaceColumn(c.line) || 1 });
              this.editor.revealLineInCenterIfOutsideViewport(c.line);
              this.editor.focus();
            },
          },
          icon(c.icon ?? "symbol-field", "crumb-icon"),
          h("span", { class: "crumb-label" }, c.name),
        ),
      );
  }

  private scheduleSymbols() {
    cancelAnimationFrame(this.symbolsFrame);
    this.symbolsFrame = requestAnimationFrame(() => this.paintSymbols());
  }

  /** The open folder, so breadcrumbs start there (set by the workbench). */
  breadcrumbRoot: () => string | null = () => null;

  /** The active file's path under the tabs: folders, then the file with its icon. */
  private paintBreadcrumbs(doc: Doc | null) {
    const bar = this.wb.editorBreadcrumbs;
    clear(bar);
    if (doc?.kind !== "text") {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "";
    const root = this.breadcrumbRoot();
    let parts: string[];
    if (!doc.path) parts = [doc.title];
    else if (root && doc.path.startsWith(root + "/")) parts = doc.path.slice(root.length + 1).split("/");
    else parts = doc.path.split("/").filter(Boolean).slice(-3);
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (i > 0) bar.append(icon("chevron-right", "sep"));
      bar.append(h("span", { class: `crumb${last ? " file" : ""}`, title: doc.path ?? doc.title }, last && doc.path ? fileIconEl(part, "crumb-icon") : null, part));
    });
    this.symbolCrumbs = h("span", { class: "crumb-symbols" });
    bar.append(this.symbolCrumbs);
    this.paintSymbols();
    // Like VS Code: when a mod offers another editor for this file, the breadcrumbs end with a picker.
    if (doc.path && this.typesFor(this.info(doc)).length)
      bar.append(h("span", { class: "editor-type", title: "Reopen Editor With…", onclick: () => this.reopenWith() }, "Text Editor", icon("chevron-down")));
  }

  private show(doc: Doc | null) {
    this.paintBreadcrumbs(doc);
    const switched = this.lastShown !== undefined && this.lastShown !== doc;
    this.lastShown = doc;
    // Hidden, never `display: none`: Monaco keeps measuring its host, and a zero-size host would
    // leave it laid out at 5×5 until something resizes the window.
    this.monacoHost.style.visibility = doc?.kind === "text" ? "" : "hidden";
    this.customHost.style.display = doc?.kind === "custom" ? "" : "none";
    this.watermark.style.display = doc ? "none" : "";
    for (const child of Array.from(this.customHost.children) as HTMLElement[]) child.style.display = "none";
    if (doc?.kind === "text") {
      // The host may just have gone from hidden to shown: measure now rather than wait for the
      // resize observer.
      this.editor.layout();
      requestAnimationFrame(() => this.editor.layout());
      if (this.editor.getModel() !== doc.model) {
        this.editor.setModel(doc.model);
        if (doc.viewState) this.editor.restoreViewState(doc.viewState);
      }
      this.updatePlaceholder();
      this.scheduleSymbols();
    } else if (doc?.kind === "custom") {
      if (!doc.el) {
        doc.el = h("div", { style: { position: "absolute", inset: "0", overflow: "auto" } });
        this.customHost.append(doc.el);
        try {
          doc.disposable = doc.spec.render(doc.el);
        } catch (e) {
          doc.el.append(h("div", { class: "notice" }, String(e)));
        }
      }
      doc.el.style.display = "";
    }
    if (switched && this.motionReady) {
      if (doc?.kind === "text") play(this.monacoHost, "content-enter");
      else if (doc?.kind === "custom" && doc.el) play(doc.el, "content-enter");
      else if (!doc) play(this.watermark, "content-enter");
    }
    this.renderTabs();
    this.renderTitleActions();
    this.paintStatus();
    const title = doc ? (doc.kind === "text" && doc.path ? doc.title : doc.title) : "";
    document.title = title ? `${title} — AICode` : "AICode";
  }

  private updatePlaceholder() {
    const doc = this.activeText();
    const hint = doc && doc.path === null && doc.model.getValueLength() === 0 && doc.model.getLanguageId() === "plaintext"
      ? "Start typing, or select a language (⌘K M). Commands: ⇧⌘P · Mods: ⇧⌘X"
      : undefined;
    this.editor.updateOptions({ placeholder: hint });
  }

  /** Repaints the tabs and breadcrumbs (after the icon theme or the open folder changed). */
  refreshTabs() {
    this.renderTabs();
    this.paintBreadcrumbs(this.active);
  }

  private renderTabs() {
    const host = this.wb.editorTabs;
    // Like VS Code: an empty editor area has no tab bar, only the watermark.
    const bar = host.parentElement;
    if (bar) bar.style.display = this.docs.length ? "" : "none";
    clear(host);
    const activeId = this.active?.id ?? null;
    const activeChanged = activeId !== this.lastActiveTab;
    this.lastActiveTab = activeId;
    for (const doc of this.docs) {
      const isNew = !this.knownTabs.has(doc.id);
      this.knownTabs.add(doc.id);
      const dirty = doc.kind === "text" && this.isDirty(doc);
      const tabIcon = doc.kind === "custom" ? doc.spec.icon ?? "file" : doc.path ? fileIcon(doc.path) : "file";
      const tabIconEl = doc.kind === "text" && doc.path ? fileIconEl(basename(doc.path), "tab-icon") : icon(tabIcon, "tab-icon");
      tabIconEl.dataset.part = "tab.icon";
      const deco = doc.kind === "text" && doc.path ? this.decorate(doc.path) : undefined;
      const tab = h(
        "div",
        {
          class: `tab${doc === this.active ? " active" : ""}${dirty ? " dirty" : ""}${doc.preview ? " preview" : ""}${isNew && this.motionReady ? " tab-enter" : ""}${doc === this.active && activeChanged && this.motionReady && !isNew ? " just-active" : ""}`,
          dataset: { doc: doc.id, part: "tab" },
          title: doc.kind === "text" && doc.path ? doc.path : doc.title,
          onmousedown: (e: MouseEvent) => {
            if (e.button === 1) {
              e.preventDefault();
              this.close(doc);
            } else if (e.button === 0) {
              // Double-click keeps a preview tab open, as in VS Code. Detected here, not with
              // `dblclick`: the first press re-renders the tabs, so the second lands on a new element.
              if (e.detail >= 2 && doc.preview) {
                e.preventDefault();
                doc.preview = false;
                this.renderTabs();
                return;
              }
              this.activate(doc);
              this.dragTab(e, doc);
            }
          },
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            this.tabMenu(e, doc);
          },
        },
        h("span", { class: "tab-flare", "aria-hidden": "true" }),
        tabIconEl,
        h("span", { class: "label", style: deco?.color ? { color: `var(--aicode-${deco.color.replace(/\./g, "-")})` } : undefined }, doc.title),
        deco?.badge && deco.badge !== "•" ? h("span", { class: "tab-deco", style: deco.color ? { color: `var(--aicode-${deco.color.replace(/\./g, "-")})` } : undefined }, deco.badge) : null,
        h(
          "div",
          {
            class: "tab-close",
            title: "Close",
            dataset: { part: "tab.close" },
            onmousedown: (e: MouseEvent) => e.stopPropagation(),
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              this.close(doc);
            },
          },
          icon("close"),
        ),
      );
      host.append(tab);
      if (doc === this.active) requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
    this.onDidChangeDocs.fire();
  }

  private paintStatus() {
    const doc = this.activeText();
    const s = this.status;
    if (!doc) {
      for (const k of Object.keys(s) as (keyof typeof s)[]) s[k].update({ text: "" });
      return;
    }
    const pos = this.editor.getPosition();
    const sel = this.editor.getSelection();
    const selected = sel && !sel.isEmpty() ? ` (${doc.model.getValueInRange(sel).length} selected)` : "";
    s.position.update({ text: pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${selected}` : "" });
    const opts = doc.model.getOptions();
    s.indent.update({ text: opts.insertSpaces ? `Spaces: ${opts.indentSize}` : `Tab Size: ${opts.tabSize}` });
    s.encoding.update({ text: doc.bom ? "UTF-8 with BOM" : "UTF-8" });
    s.eol.update({ text: doc.model.getEOL() === "\r\n" ? "CRLF" : "LF" });
    s.language.update({ text: `{ } ${languageName(doc.model.getLanguageId())}` });
  }

  private buildWatermark(): HTMLElement {
    const row = (label: string, command: string) => {
      const kb = commands.keybindingFor(command);
      return [h("dt", null, label), h("dd", null, kb ? commands.prettyKey(kb).map((k) => h("kbd", null, k)) : "")];
    };
    return h(
      "div",
      // Like VS Code: a double click on the empty editor area opens an Untitled file.
      { class: "watermark", ondblclick: () => this.newUntitled() },
      icon("code", "logo"),
      h("dl", null, row("Show All Commands", "workbench.commandPalette"), row("New File", "file.new"), row("Open File", "file.open"), row("Go to File", "workbench.quickOpen"), row("Manage Mods", "mods.manage")),
    );
  }

  // ---------- saving & closing ----------

  /** What the File menu needs to know: which of its items have something to act on. */
  menuContext() {
    const a = this.active;
    const text = a?.kind === "text" ? a : null;
    return { editor: !!a, text: !!text, file: !!text?.path, dirty: this.docs.some((d) => d.kind === "text" && this.isDirty(d)) };
  }

  /** Auto Save "after a delay": each file on disk saves `autoSaveDelay` ms after its last change. */
  private scheduleAutoSave(doc: TextDoc) {
    if (this.autoSave !== "afterDelay" || !doc.path) return;
    clearTimeout(this.autoSaveTimers.get(doc.id));
    this.autoSaveTimers.set(doc.id, window.setTimeout(() => {
      this.autoSaveTimers.delete(doc.id);
      this.autoSaveNow(doc);
    }, this.autoSaveDelay));
  }

  /** Saves a file that is on disk and has changes, if it is still open. Untitled text waits for Save. */
  private autoSaveNow(doc: TextDoc) {
    if (doc.path && this.docs.includes(doc) && this.isDirty(doc)) void this.save(doc);
  }

  /** The window lost focus: Auto Save "when the editor/window loses focus" saves every changed file. */
  autoSaveOnBlur() {
    if (this.autoSave !== "onFocusChange" && this.autoSave !== "onWindowChange") return;
    for (const d of this.docs) if (d.kind === "text") this.autoSaveNow(d);
  }

  async save(doc: TextDoc | null = this.activeText()): Promise<boolean> {
    if (!doc) return false;
    if (!doc.path) return this.saveAs(doc);
    try {
      await invoke("fs_write_text", { modId: "core", path: doc.path, text: doc.model.getValue(), bom: doc.bom });
    } catch (e) {
      notify("error", `Could not save ${doc.title}: ${e}`);
      return false;
    }
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.preview = false;
    this.renderTabs();
    this.onDidSave.fire(this.info(doc));
    return true;
  }

  /** A file or folder was renamed or moved on disk: its open editors follow it (unsaved edits kept). */
  movePath(from: string, to: string) {
    let changed = false;
    for (const doc of this.docs) {
      if (doc.kind !== "text" || !doc.path || (doc.path !== from && !doc.path.startsWith(from + "/"))) continue;
      const target = to + doc.path.slice(from.length);
      const dirty = this.isDirty(doc);
      const old = doc.model;
      const viewState = this.active === doc ? this.editor.saveViewState() : doc.viewState;
      const uri = monaco.Uri.file(target);
      monaco.editor.getModel(uri)?.dispose();
      const detected = detectLanguage(target);
      doc.model = monaco.editor.createModel(old.getValue(), detected === "plaintext" ? old.getLanguageId() : detected, uri);
      doc.model.setEOL(old.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      doc.savedVersion = dirty ? -1 : doc.model.getAlternativeVersionId();
      doc.path = target;
      doc.title = basename(target);
      doc.viewState = viewState;
      if (this.active === doc) {
        this.editor.setModel(doc.model);
        if (viewState) this.editor.restoreViewState(viewState);
      }
      old.dispose();
      changed = true;
    }
    if (changed) {
      this.show(this.active);
      this.onDidChangeDocs.fire();
    }
  }

  async saveAs(doc: TextDoc | null = this.activeText()): Promise<boolean> {
    if (!doc) return false;
    const home = await invoke<string>("home_dir");
    const target = await saveDialog({ defaultPath: doc.path ?? `${home}/${doc.title}${doc.model.getLanguageId() === "plaintext" ? ".txt" : ""}` });
    if (!target) return false;
    const text = doc.model.getValue();
    const language = doc.model.getLanguageId();
    try {
      await invoke("fs_write_text", { modId: "core", path: target, text, bom: doc.bom });
    } catch (e) {
      notify("error", `Could not save: ${e}`);
      return false;
    }
    // The document now lives at a file: give it a file model (so language services see the path).
    const uri = monaco.Uri.file(target);
    monaco.editor.getModel(uri)?.dispose();
    const old = doc.model;
    const detected = detectLanguage(target);
    doc.model = monaco.editor.createModel(text, detected === "plaintext" ? language : detected, uri);
    doc.model.setEOL(old.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.path = target;
    doc.title = basename(target);
    doc.untitled = undefined;
    if (this.active === doc) this.editor.setModel(doc.model);
    old.dispose();
    this.show(this.active);
    this.onDidSave.fire(this.info(doc));
    return true;
  }

  /** Closes every tab, asking about unsaved ones; false when a prompt was cancelled (the rest stay). */
  async closeAll(): Promise<boolean> {
    for (const d of [...this.docs]) if (!(await this.close(d))) return false;
    return true;
  }

  async close(doc: Doc | null = this.active, force = false): Promise<boolean> {
    if (!doc) return false;
    if (doc.kind === "text" && this.isDirty(doc) && !force) {
      const answer = await dialog({
        title: `Do you want to save the changes you made to ${doc.title}?`,
        message: "Your changes will be lost if you don't save them.",
        kind: "warning",
        buttons: [{ label: "Don't Save", value: "discard" }, { label: "Cancel", value: "cancel" }, { label: "Save", value: "save", primary: true }],
        cancelValue: "cancel",
      });
      if (answer === "cancel") return false;
      if (answer === "save" && !(await this.save(doc))) return false;
    }
    if (doc.kind === "custom" && doc.spec.onClose && !force && (await doc.spec.onClose()) === false) return false;
    if (this.motionReady) {
      const tabEl = this.wb.editorTabs.querySelector(`[data-doc="${doc.id}"]`);
      if (tabEl) await leave(tabEl, "tab-leave", 200);
    }
    const i = this.docs.indexOf(doc);
    if (i < 0) return true;
    this.docs.splice(i, 1);
    this.knownTabs.delete(doc.id);
    this.history = this.history.filter((id) => id !== doc.id);
    this.historyIndex = this.history.length - 1;
    if (doc.kind === "text") {
      if (this.editor.getModel() === doc.model) this.editor.setModel(null);
      doc.model.dispose();
    } else {
      doc.disposable?.dispose();
      doc.el?.remove();
    }
    if (this.active === doc) {
      this.active = null;
      const lastId = this.history[this.history.length - 1];
      const next = this.docs.find((d) => d.id === lastId) ?? this.docs[Math.min(i, this.docs.length - 1)] ?? null;
      if (next) this.activate(next, false);
      else {
        this.show(null);
        this.onDidChangeActive.fire(null);
      }
    } else {
      this.renderTabs();
    }
    return true;
  }

  // ---------- changes from outside (agents, mods) ----------

  replaceSelection(text: string) {
    const doc = this.activeText();
    const sel = this.editor.getSelection();
    if (!doc || !sel) return false;
    this.editor.executeEdits("aicode", [{ range: sel, text, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
    return true;
  }

  /**
   * Shows a change side by side with the current text and waits for the user's answer. Accepting
   * applies it to the buffer as one undoable edit (not saved — the user saves).
   */
  async proposeEdit(target: string, proposal: EditProposal, opts: { source?: string; description?: string } = {}): Promise<boolean> {
    let doc = this.find(target);
    if (!doc && target.startsWith("/")) doc = (await this.openFile(target, { background: true })) ?? undefined;
    if (!doc) throw new Error(`${target} is not open and is not a file path`);
    const target_doc = doc;
    const current = target_doc.model.getValue();
    let newText: string;
    if ("newText" in proposal) newText = proposal.newText;
    else {
      const temp = monaco.editor.createModel(current, "plaintext");
      temp.applyEdits(proposal.edits.map((e) => ({ range: new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn), text: e.text })));
      newText = temp.getValue();
      temp.dispose();
    }
    if (newText === current) return true;
    return new Promise<boolean>((resolve) => {
      let answered = false;
      const answer = (accepted: boolean) => {
        if (answered) return;
        answered = true;
        if (accepted) {
          const model = target_doc.model;
          if (!model.isDisposed()) {
            model.pushStackElement();
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: newText }], () => null);
            model.pushStackElement();
          }
          this.activate(target_doc);
        }
        resolve(accepted);
        this.close(tab, true);
      };
      const tab = this.openCustom({
        title: `Proposed: ${target_doc.title}`,
        icon: "diff",
        render: (el) => {
          const diffHost = h("div", { class: "proposal-diff monaco-component" });
          const accept = h("button", { class: "btn", onclick: () => answer(true) }, icon("check"), "Accept");
          const reject = h("button", { class: "btn secondary", onclick: () => answer(false) }, icon("close"), "Reject");
          el.append(
            h(
              "div",
              { class: "proposal" },
              h(
                "div",
                { class: "proposal-bar" },
                icon("sparkle"),
                h("div", { class: "what" }, h("b", null, opts.source ?? "An agent"), " proposes changes to ", h("b", null, target_doc.title), opts.description ? h("span", { class: "muted" }, ` — ${opts.description}`) : ""),
                reject,
                accept,
              ),
              diffHost,
            ),
          );
          const original = monaco.editor.createModel(current, target_doc.model.getLanguageId());
          const modified = monaco.editor.createModel(newText, target_doc.model.getLanguageId());
          const diff = monaco.editor.createDiffEditor(diffHost, { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, fontSize: this.fontSize, minimap: { enabled: false } });
          diff.setModel({ original, modified });
          return toDisposable(() => {
            diff.dispose();
            original.dispose();
            modified.dispose();
          });
        },
        onClose: () => {
          if (!answered) {
            answered = true;
            resolve(false);
          }
          return true;
        },
      });
    });
  }

  // ---------- session ----------

  snapshot() {
    return {
      active: this.active ? this.docs.indexOf(this.active) : -1,
      docs: this.docs
        .map((d) => {
          if (d.kind === "custom") {
            if (d.spec.restore) return { restore: d.spec.restore };
            // A mod's view of a file (an image, a preview) comes back through its editor type.
            return d.spec.forPath && d.spec.editorType ? { path: d.spec.forPath, editorType: d.spec.editorType } : null;
          }
          const dirty = this.isDirty(d);
          return {
            path: d.path,
            untitled: d.untitled,
            language: d.model.getLanguageId(),
            text: d.path === null || dirty ? d.model.getValue() : undefined,
            dirty,
            viewState: d === this.active ? this.editor.saveViewState() : d.viewState,
          };
        })
        .filter(Boolean),
      zoom: this.zoom,
    };
  }

  async restore(snapshot: any) {
    if (!snapshot?.docs) return;
    if (snapshot.zoom && snapshot.zoom !== 1) this.setZoom(snapshot.zoom);
    const restored: (Doc | null)[] = [];
    for (const s of snapshot.docs) {
      try {
        if (s.restore) {
          const fn = this.restorers.get(s.restore);
          // A page that was a tab comes back as a tab, not as a modal over the restored window.
          this.restoringPage = true;
          try {
            if (fn) fn();
          } finally {
            this.restoringPage = false;
          }
          restored.push(this.active);
          continue;
        }
        if (s.path && s.editorType) {
          restored.push(this.openWithType(s.editorType, s.path));
          continue;
        }
        if (s.path) {
          const doc = await this.openFile(s.path, { background: true });
          if (doc && s.dirty && typeof s.text === "string") doc.model.setValue(s.text);
          if (doc) doc.viewState = s.viewState ?? null;
          restored.push(doc);
        } else {
          // An empty Untitled tab is not worth bringing back (VS Code drops them too).
          if (!s.text) {
            restored.push(null as unknown as Doc);
            continue;
          }
          const doc = this.newUntitled(s.text ?? "", s.language ?? "plaintext");
          if (!s.text) doc.savedVersion = doc.model.getAlternativeVersionId();
          doc.viewState = s.viewState ?? null;
          restored.push(doc);
        }
      } catch (e) {
        console.warn("could not restore", s, e);
      }
    }
    const active = restored[snapshot.active] ?? restored[restored.length - 1];
    if (active) this.activate(active);
  }

  get count() {
    return this.docs.length;
  }

  // ---------- zoom ----------

  setFontSize(size: number) {
    const next = Math.max(8, Math.min(40, size));
    if (next === this.fontSize) return;
    this.fontSize = next;
    this.editor.updateOptions({ fontSize: this.fontSize });
    this.onDidChangeFontSize.fire(next);
  }

  async setZoom(level: number) {
    this.zoom = Math.max(0.5, Math.min(2.5, Math.round(level * 10) / 10));
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(this.zoom);
    } catch (e) {
      console.warn(e);
    }
  }

  // ---------- commands ----------

  private registerCommands() {
    const c = (id: string, title: string, run: (...a: any[]) => unknown, category = "File") => commands.register(id, run, { title, category, owner: "core" });
    c("file.new", "New Text File", () => this.newUntitled());
    c("editor.reopenWith", "Reopen Editor With…", () => this.reopenWith(), "View");
    c("editor.closeSide", "Close Editor to the Side", () => this.closeSide(), "View");
    c("file.open", "Open File…", () => this.openWithDialog());
    c("file.save", "Save", () => this.save());
    c("file.saveAs", "Save As…", () => this.saveAs());
    commands.register("file.saveById", async (id: string) => {
      const doc = this.find(id);
      return doc ? this.save(doc) : false;
    }, { title: "Save Editor", owner: "core", hidden: true });
    c("file.saveAll", "Save All", async () => {
      for (const d of this.docs) if (d.kind === "text" && this.isDirty(d) && d.path) await this.save(d);
    });
    c("file.revert", "Revert File", async () => {
      const doc = this.activeText();
      if (!doc?.path) return;
      const file = await invoke<TextFile>("fs_read_text", { modId: "core", path: doc.path });
      doc.model.setValue(file.text);
      doc.savedVersion = doc.model.getAlternativeVersionId();
      this.renderTabs();
    });
    c("editor.close", "Close Editor", () => this.close(), "View");
    c("editor.closeAll", "Close All Editors", () => this.closeAll(), "View");
    c("editor.closeOthers", "Close Other Editors", async () => {
      for (const d of [...this.docs]) if (d !== this.active && !(await this.close(d))) break;
    }, "View");
    c("editor.nextTab", "Open Next Editor", () => this.cycle(1), "View");
    c("editor.previousTab", "Open Previous Editor", () => this.cycle(-1), "View");
    c("editor.navigateBack", "Go Back", () => this.navigate(-1), "Go");
    c("editor.navigateForward", "Go Forward", () => this.navigate(1), "Go");
    c("edit.undo", "Undo", () => this.textOrNative("undo"), "Edit");
    c("edit.redo", "Redo", () => this.textOrNative("redo"), "Edit");
    c("edit.find", "Find", () => this.editor.getAction("actions.find")?.run(), "Edit");
    c("edit.replace", "Replace", () => this.editor.getAction("editor.action.startFindReplaceAction")?.run(), "Edit");
    c("editor.gotoLine", "Go to Line/Column…", () => {
      this.editor.focus();
      this.editor.getAction("editor.action.gotoLine")?.run();
    }, "Go");
    c("editor.changeLanguage", "Change Language Mode", () => this.pickLanguage(), "Editor");
    c("editor.toggleEol", "Change End of Line Sequence", () => {
      const doc = this.activeText();
      if (!doc) return;
      doc.model.pushEOL(doc.model.getEOL() === "\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      this.paintStatus();
    }, "Editor");
    c("editor.indentation", "Change Indentation", async () => {
      const doc = this.activeText();
      if (!doc) return;
      const choice = await pick(
        [2, 4, 8].flatMap((n) => [
          { label: `Indent Using Spaces: ${n}`, spaces: true, n },
          { label: `Indent Using Tabs: ${n}`, spaces: false, n },
        ]),
        { placeholder: "Select indentation" },
      );
      if (choice) {
        doc.model.updateOptions({ insertSpaces: choice.spaces as boolean, tabSize: choice.n as number, indentSize: choice.n as number });
        this.paintStatus();
      }
    }, "Editor");
    c("editor.toggleWordWrap", "Toggle Word Wrap", () => {
      const now = this.editor.getOption(monaco.editor.EditorOption.wordWrap);
      this.editor.updateOptions({ wordWrap: now === "off" ? "on" : "off" });
    }, "View");
    c("editor.toggleMinimap", "Toggle Minimap", () => {
      const now = this.editor.getOption(monaco.editor.EditorOption.minimap).enabled;
      this.editor.updateOptions({ minimap: { enabled: !now } });
    }, "View");
    c("editor.formatDocument", "Format Document", () => this.editor.getAction("editor.action.formatDocument")?.run(), "Editor");
    c("editor.zoomIn", "Zoom In", () => this.setZoom(this.zoom + 0.1), "View");
    c("editor.zoomOut", "Zoom Out", () => this.setZoom(this.zoom - 0.1), "View");
    c("editor.zoomReset", "Reset Zoom", () => this.setZoom(1), "View");
    c("editor.fontBigger", "Increase Editor Font Size", () => this.setFontSize(this.fontSize + 1), "View");
    c("editor.fontSmaller", "Decrease Editor Font Size", () => this.setFontSize(this.fontSize - 1), "View");
    commands.bind("mod+k m", "editor.changeLanguage");
    commands.bind("ctrl+tab", "editor.nextTab");
    commands.bind("ctrl+shift+tab", "editor.previousTab");
    commands.bind("mod+alt+right", "editor.nextTab");
    commands.bind("mod+alt+left", "editor.previousTab");
    commands.bind("ctrl+-", "editor.navigateBack");
    commands.bind("ctrl+shift+-", "editor.navigateForward");
    commands.bind("ctrl+g", "editor.gotoLine");
    commands.bind("alt+z", "editor.toggleWordWrap");
    commands.bind("mod+k w", "editor.closeAll");
    commands.bind("mod+k u", "editor.closeSaved");
    c("editor.closeSaved", "Close Saved Editors", async () => {
      for (const d of [...this.docs]) if (d.kind !== "text" || !this.isDirty(d)) await this.close(d);
    }, "View");
    c("editor.showOpened", "Show All Opened Editors…", async () => {
      const choice = await pick(
        this.docs.map((d) => ({ label: d.title, description: d.kind === "text" && d.path ? d.path : "", fileIcon: d.kind === "text" && d.path ? d.title : undefined, icon: d.kind === "custom" ? d.spec.icon ?? "file" : "file", id: d.id })),
        { placeholder: "Select an editor to show" },
      );
      if (choice) this.activateById(choice.id as string);
    }, "View");
    c("editor.togglePreview", "Toggle Preview Editors", async () => {
      this.previewEnabled = !this.previewEnabled;
      if (!this.previewEnabled) for (const d of this.docs) d.preview = false;
      this.renderTabs();
      await import("./config").then(({ config }) => config.update("core", "workbench.previewEditors", this.previewEnabled)).catch(() => {});
    }, "View");
  }

  private textOrNative(which: "undo" | "redo") {
    const active = document.activeElement;
    if (this.activeText() && (this.editor.hasTextFocus() || !active || active === document.body)) {
      this.editor.trigger("menu", which, null);
    } else {
      document.execCommand(which);
    }
  }

  private cycle(step: number) {
    if (!this.docs.length || !this.active) return;
    const i = this.docs.indexOf(this.active);
    this.activate(this.docs[(i + step + this.docs.length) % this.docs.length]);
  }

  private navigate(step: number) {
    const next = this.historyIndex + step;
    if (next < 0 || next >= this.history.length) return;
    const doc = this.docs.find((d) => d.id === this.history[next]);
    if (!doc) return;
    this.historyIndex = next;
    this.activate(doc, false);
  }

  async pickLanguage() {
    const doc = this.activeText();
    if (!doc) return;
    const current = doc.model.getLanguageId();
    const items = monaco.languages
      .getLanguages()
      .map((l) => ({ label: l.aliases?.[0] ?? l.id, description: l.id === current ? `(${l.id}) — current` : `(${l.id})`, id: l.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (doc.path) items.unshift({ label: "Auto Detect", description: `from the file name: ${detectLanguage(doc.path)}`, id: "__auto" });
    const choice = await pick(items, { placeholder: "Select Language Mode" });
    if (!choice) return;
    monaco.editor.setModelLanguage(doc.model, choice.id === "__auto" && doc.path ? detectLanguage(doc.path) : (choice.id as string));
    this.paintStatus();
    this.updatePlaceholder();
    this.onDidChangeActive.fire(this.info(doc));
  }

  dirname = dirname;

  dispose(): Disposable {
    return toDisposable(() => this.editor.dispose());
  }
}
