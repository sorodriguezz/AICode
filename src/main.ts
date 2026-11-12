import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import { invoke, prepareStreams, streamCounts } from "./core/ipc";
import * as commands from "./core/commands";
import { Workbench } from "./core/workbench";
import { EditorService, DEFAULT_FONT_SIZE } from "./core/editor";
import { Workspace } from "./core/workspace";
import { ModHost, decorations } from "./core/mods";
import { registerModManager } from "./core/modManager";
import { applyTheme, BUILTIN_DARK, BUILTIN_LIGHT, ThemeEntry } from "./core/theme";
import { configureFileIcons } from "./core/fileIcons";
import { quickInput, fuzzyScore, highlight, pick, notify, QuickItem, dialog } from "./core/widgets";
import { basename, h, icon } from "./core/ui";
import { motionEnabled, setMotion } from "./core/motion";
import { openProfiles, openSettings, switchProfile, createProfile, importProfile, exportProfile, ProfileView } from "./core/profiles";

// Errors and warnings also go to the terminal that started AICode (see `core_log`).
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    invoke("core_log", { level, message: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ") }).catch(() => {});
  };
}
window.addEventListener("error", (e) => {
  // Browsers report this when an element is resized again in the same frame (Monaco and the
  // terminal re-measure while a panel animates). Nothing is lost; it is not an error.
  if (e.message?.includes("ResizeObserver loop")) return;
  console.error(`uncaught: ${e.message} at ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => console.error(`unhandled rejection: ${e.reason?.stack ?? e.reason}`));

async function boot() {
  await prepareStreams();
  const wb = new Workbench(document.getElementById("app")!);
  const workspace = new Workspace();
  const editors = new EditorService(wb);
  editors.breadcrumbRoot = () => workspace.folder;
  editors.decorate = (path) => decorations.get(path);
  decorations.onDidChange.event(() => editors.refreshTabs());
  workspace.onDidChange.event(() => editors.refreshTabs());
  const host = new ModHost(wb, editors, workspace);
  registerModManager(host, editors);

  const session = await invoke<string | null>("session_load").then((s) => (s ? JSON.parse(s) : null)).catch(() => null);
  const coreSettings = await invoke<Record<string, any>>("settings_get", { modId: "core" });

  const profile = await invoke<ProfileView>("profile_get");
  // Where the user dragged views to (before mods put their views on screen).
  wb.setPlacement(coreSettings["workbench.viewPlacement"]);
  wb.onDidChangePlacement.event((placement) => {
    invoke("settings_set", { modId: "core", key: "workbench.viewPlacement", value: Object.keys(placement).length ? placement : null }).catch(() => {});
  });
  // Customize Layout's choices (side bar position, panel alignment, density…), kept by the profile.
  wb.setOptions(coreSettings["workbench.layout"] ?? {}, false);
  wb.onDidChangeOptions.event((o) => {
    invoke("settings_set", { modId: "core", key: "workbench.layout", value: o }).catch(() => {});
  });
  // Theme first, so nothing flashes in the wrong colors.
  applyTheme(BUILTIN_DARK, await BUILTIN_DARK.load());
  await host.load();
  const allThemes = (): ThemeEntry[] => [BUILTIN_DARK, BUILTIN_LIGHT, ...host.themes];
  // The profile's own settings for the editor and the workbench (see the Settings page).
  const applyCore = async (s: Record<string, any>, changed = "*") => {
    const get = <T>(key: string, fallback: T): T => (key in s && s[key] !== null ? s[key] : fallback);
    editors.setFontSize(Number(get("editor.fontSize", DEFAULT_FONT_SIZE)));
    editors.editor.updateOptions({
      fontFamily: get("editor.fontFamily", "") || DEFAULT_FONT,
      lineHeight: Number(get("editor.lineHeight", 0)),
      wordWrap: get("editor.wordWrap", "off"),
      minimap: { enabled: get("editor.minimap", true) },
      lineNumbers: get("editor.lineNumbers", "on"),
      renderWhitespace: get("editor.renderWhitespace", "selection"),
      cursorStyle: get("editor.cursorStyle", "line"),
      stickyScroll: { enabled: get("editor.stickyScroll", true) },
      bracketPairColorization: { enabled: get("editor.bracketPairColorization", true) },
    });
    document.documentElement.dataset.iconSize = get("workbench.iconSize", "normal");
    editors.previewEnabled = get<boolean>("workbench.previewEditors", true) !== false;
    editors.useModal = get<string>("workbench.editor.useModal", "some") !== "off";
    if (changed === "*" || changed === "workbench.iconTheme") {
      configureFileIcons({ enabled: get<string>("workbench.iconTheme", "seti") !== "none" });
      if (changed !== "*") {
        editors.refreshTabs();
        decorations.onDidChange.fire(); // lists that show files repaint
      }
    }
    setMotion(get<boolean>("animations", true) !== false);
    if (changed === "theme") {
      const entry = allThemes().find((t) => t.id === s.theme);
      if (entry) await setTheme(entry, false);
    }
  };
  await applyCore(coreSettings);
  editors.onDidChangeFontSize.event((size) => {
    invoke("settings_set", { modId: "core", key: "editor.fontSize", value: size }).catch(() => {});
  });
  const setTheme = async (entry: ThemeEntry, persist = true) => {
    try {
      applyTheme(entry, await entry.load());
      configureFileIcons({ light: entry.uiTheme === "vs" });
      editors.refreshTabs();
      if (persist) await invoke("settings_set", { modId: "core", key: "theme", value: entry.id });
    } catch (e) {
      notify("error", `Could not load the theme ${entry.label}: ${e}`);
    }
  };
  const savedTheme = allThemes().find((t) => t.id === coreSettings.theme);
  if (savedTheme && savedTheme !== BUILTIN_DARK) await setTheme(savedTheme, false);

  // The profile's keyboard shortcuts go over the mods' (a shortcut set for a command replaces its default).
  const userBindings: { dispose: () => void }[] = [];
  const applyUserKeybindings = (list: ProfileView["keybindings"]) => {
    for (const d of userBindings.splice(0)) d.dispose();
    for (const kb of list ?? []) {
      if (!kb || typeof kb.command !== "string" || typeof kb.key !== "string") continue;
      const removed = commands.unbindCommand(kb.command, "user");
      const bound = kb.key ? commands.bind(kb.key, kb.command, "user", kb.args) : null;
      userBindings.push({ dispose: () => { bound?.dispose(); commands.rebind(removed); } });
    }
  };
  applyUserKeybindings(profile.keybindings);

  registerWorkbenchCommands(wb, editors, workspace, host, allThemes, setTheme, applyCore, applyUserKeybindings);
  commands.installKeyHandler();

  // Which profile this is, when there is more than one.
  if (profile.available.length > 1 || profile.name !== "default") {
    wb.addStatus({ id: "profile", icon: profile.icon || "account", text: profile.name, tooltip: `Profile: ${profile.name}${profile.description ? ` — ${profile.description}` : ""}\nClick to manage profiles`, command: "profiles.manage", align: "left", priority: 1000 });
  }

  // Saving profile.json or a mod's mod.json by hand: say how to apply it.
  editors.onDidSave.event(async (info) => {
    if (!info.path) return;
    if (info.path === profile.path) {
      try {
        await invoke("profile_reload");
        notify("info", "Profile saved. Reload the window to apply every change.", [{ label: "Reload Window", run: () => location.reload() }]);
      } catch (e) {
        notify("error", `profile.json was not applied: ${e}`);
      }
    } else if (info.path.endsWith("/mod.json")) {
      const mods = await invoke<{ dir: string }[]>("mods_list");
      if (mods.some((m) => info.path === `${m.dir}/mod.json`)) notify("info", "Mod saved. Reload the window to try your changes.", [{ label: "Reload Window", run: () => location.reload() }]);
    }
  });

  // Native menu items arrive as commands.
  await listen<string>("menu", (e) => commands.runOnce(e.payload));

  // Layout and session.
  wb.restore(session?.layout);
  if (session?.folder) workspace.set(session.folder);
  const updateTitle = () => wb.setTitle(workspace.name ?? (editors.activeInfo()?.title ?? "Search"));
  workspace.onDidChange.event(updateTitle);
  editors.onDidChangeActive.event(updateTitle);
  await editors.restore(session?.editors);
  // Paths this window was opened with (command line, Dock, "Open Folder in New Window"). Asking
  // marks the window ready, so the listener for later ones goes first and queues until we can open.
  let openLater: ((paths: string[]) => void) | null = null;
  const queued: string[][] = [];
  await listen<string[]>("open-paths", (e) => (openLater ? openLater(e.payload) : queued.push(e.payload)));
  const pending = await invoke<string[]>("window_take_pending");
  // Opened with nothing to show: a blank file, as a notepad does. Opened with a file: just that.
  if (!editors.count && !pending.length) editors.newUntitled();
  updateTitle();

  host.fire("onStartup");
  await wb.revealVisible();
  // The window is put together: from here on, opening and closing things animates.
  requestAnimationFrame(() => {
    wb.enableMotion();
    editors.motionReady = true;
  });

  // ---------- opening files and folders from outside ----------
  const openPaths = async (paths: string[]) => {
    const folders: string[] = [];
    for (const path of paths) {
      const st = await invoke<{ exists: boolean; is_dir: boolean }>("fs_stat", { modId: "core", path }).catch(() => null);
      if (!st?.exists) {
        notify("warning", `${path} does not exist.`);
        continue;
      }
      if (st.is_dir) folders.push(path);
      else await editors.openFile(path);
    }
    if (folders.length) {
      // The first folder becomes this window's; any others get windows of their own, as in VS Code.
      workspace.set(folders[0]);
      for (const extra of folders.slice(1)) invoke("window_new", { paths: [extra] });
      if (wb.hasView("explorer")) wb.showView("explorer", false);
      else
        notify("info", `Opened ${basename(folders[0])}. Turn on the Explorer mod to browse it (⌘P already finds its files).`, [
          { label: "Open Mods", run: () => commands.execute("mods.manage") },
        ]);
    }
  };
  if (pending.length) await openPaths(pending);
  for (const paths of queued.splice(0)) await openPaths(paths);
  openLater = (paths) => openPaths(paths);
  if (!editors.count) editors.newUntitled();

  // Drag and drop of files and folders from Finder (or anywhere) onto the window.
  const dropHint = h("div", { class: "drop-overlay" }, h("div", { class: "drop-card" }, icon("files"), h("span", null, "Drop to open")));
  document.body.append(dropHint);
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") dropHint.classList.add("visible");
    else dropHint.classList.remove("visible");
    if (p.type === "drop" && p.paths.length) openPaths(p.paths);
  });

  // Hot exit: the session (unsaved text included) is written as you type, so quitting, a crash or
  // a reload never loses anything and never asks.
  let timer: number | undefined;
  let closing = false;
  const persist = () => {
    if (closing) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const data = JSON.stringify({ layout: wb.snapshot(), folder: workspace.folder, editors: editors.snapshot() });
      invoke("session_save", { data }).catch((e) => console.warn("session", e));
    }, 600);
  };
  editors.onDidChangeContent.event(persist);
  editors.onDidChangeDocs.event(persist);
  wb.onDidChangeLayout.event(persist);
  workspace.onDidChange.event(persist);
  // Switching profiles: every window saves now, then closes.
  await listen("session-flush", async () => {
    clearTimeout(timer);
    closing = true;
    await invoke("session_save", { data: JSON.stringify({ layout: wb.snapshot(), folder: workspace.folder, editors: editors.snapshot() }) }).catch(() => {});
  });
  window.addEventListener("beforeunload", () => {
    if (closing) return;
    invoke("session_save", { data: JSON.stringify({ layout: wb.snapshot(), folder: workspace.folder, editors: editors.snapshot() }) });
  });

  // A focused text field costs WebKit a repaint per caret blink (measured: ~3% CPU and ~55 MB of
  // GPU memory at idle, for any field, Monaco or not). When the window is in the background
  // nobody sees the caret: let go of the focus, and give it back on return.
  let focusedBeforeBlur: HTMLElement | null = null;
  window.addEventListener("blur", () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body) {
      focusedBeforeBlur = el;
      el.blur();
    }
  });
  window.addEventListener("focus", () => {
    if (focusedBeforeBlur?.isConnected && (!document.activeElement || document.activeElement === document.body)) focusedBeforeBlur.focus();
    focusedBeforeBlur = null;
  });

  // Closing one window of several forgets it, so unsaved text has to be saved or given up first.
  // The last window just closes: its session (unsaved text included) is kept, as on quit.
  await getCurrentWindow().onCloseRequested(async (event) => {
    const others = (await invoke<number>("window_count")) > 1;
    if (!others) {
      clearTimeout(timer);
      await invoke("session_save", { data: JSON.stringify({ layout: wb.snapshot(), folder: workspace.folder, editors: editors.snapshot() }) });
      return;
    }
    const dirty = editors.list().filter((d) => d.dirty);
    if (dirty.length) {
      const answer = await dialog({
        title: dirty.length === 1 ? `Do you want to save the changes you made to ${dirty[0].title}?` : `Do you want to save the changes to ${dirty.length} files?`,
        message: "This window is closing; your changes will be lost if you don't save them.",
        kind: "warning",
        buttons: [{ label: "Don't Save", value: "discard" }, { label: "Cancel", value: "cancel" }, { label: dirty.length === 1 ? "Save" : "Save All", value: "save", primary: true }],
        cancelValue: "cancel",
      });
      if (answer === "cancel") return event.preventDefault();
      if (answer === "save") {
        for (const d of dirty) {
          const ok = d.path ? await commands.execute("file.saveById", d.id) : (editors.activateById(d.id), await editors.saveAs());
          if (!ok) return event.preventDefault();
        }
      }
    }
    closing = true;
    clearTimeout(timer);
  });

  editors.editor.focus();
  // Started behind another window (from a terminal, at login): same as being sent to the back.
  if (!document.hasFocus()) {
    focusedBeforeBlur = document.activeElement as HTMLElement | null;
    focusedBeforeBlur?.blur();
  }
  const info = await invoke<{ diag: boolean; diagRun: string }>("core_info");
  if (info.diag) {
    getCurrentWindow().setFocus().catch(() => {});
    setTimeout(async () => {
      for (const line of info.diagRun.split(",").map((x) => x.trim()).filter(Boolean)) {
        const [id, ...args] = line.split(" ");
        if (id === "@drag") {
          await dragSelfTest(args[0], args[1]);
          continue;
        }
        if (id === "@repl") {
          void diagRepl(host, args[0]);
          continue;
        }
        const t0 = performance.now();
        try {
          await Promise.race([commands.execute(id, ...args), new Promise((r) => setTimeout(r, 3000))]);
          invoke("core_log", { level: "diag", message: `ran ${id} in ${Math.round(performance.now() - t0)} ms` });
        } catch (e) {
          invoke("core_log", { level: "diag", message: `ran ${id}: ERROR ${e}` });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      diagnostics();
    }, 4000);
  }
  (window as any).aicode = { wb, editors, workspace, host, commands };
}

const DEFAULT_FONT = "Menlo, 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace";

function registerWorkbenchCommands(
  wb: Workbench,
  editors: EditorService,
  workspace: Workspace,
  host: ModHost,
  themes: () => ThemeEntry[],
  setTheme: (t: ThemeEntry) => Promise<void>,
  applyCore: (s: Record<string, any>, changed?: string) => Promise<void>,
  applyUserKeybindings: (list: ProfileView["keybindings"]) => void,
) {
  const reg = (id: string, title: string, run: (...a: any[]) => unknown, category = "View") => commands.register(id, run, { title, category, owner: "core" });
  const recent: string[] = [];

  const commandPalette = async (initial = ">") => {
    const all = commands.all();
    const result = await quickInput<QuickItem & { id: string }>({
      placeholder: "Type the name of a command to run.",
      value: initial,
      noMatch: "No matching commands",
      onValue: (v) => {
        if (!v.startsWith(">")) {
          quickOpen(v);
          return true;
        }
        return false;
      },
      items: (q) => {
        const query = q.replace(/^>\s*/, "");
        const items = all
          .map((c) => {
            const label = `${c.category ? c.category + ": " : ""}${c.title}`;
            const m = fuzzyScore(query, label);
            if (!m) return null;
            const r = recent.indexOf(c.id);
            return { item: { label, _label: highlight(label, m.ranges), id: c.id, keybinding: commands.keybindingFor(c.id), description: r >= 0 && !query ? "recently used" : undefined }, score: m.score + (r >= 0 ? 50 - r : 0) };
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
          .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
        return items.map((x) => x.item);
      },
    });
    if (result && typeof result !== "string") {
      const i = recent.indexOf(result.id);
      if (i >= 0) recent.splice(i, 1);
      recent.unshift(result.id);
      commands.execute(result.id).catch((e) => notify("error", String(e)));
    }
  };

  let fileCache: { folder: string; files: string[]; at: number } | null = null;
  const quickOpen = async (initial = "") => {
    const folder = workspace.folder;
    if (folder && (!fileCache || fileCache.folder !== folder || Date.now() - fileCache.at > 15000)) {
      invoke<string[]>("fs_list_files", { modId: "core", root: folder, limit: 50000 }).then((files) => (fileCache = { folder, files, at: Date.now() }));
    }
    const result = await quickInput<QuickItem & { path?: string; docId?: string }>({
      placeholder: folder ? "Search files by name (append : to go to a line, or start with > for commands)" : "Open editors — or > for commands. Open a folder to search its files.",
      value: initial,
      noMatch: "No matching results",
      onValue: (v) => {
        if (v.startsWith(">")) {
          commandPalette(v);
          return true;
        }
        return false;
      },
      items: async (q) => {
        if (q.startsWith(":")) {
          return [{ label: `Go to line ${q.slice(1) || "…"}`, icon: "go-to-file", docId: "__line" }];
        }
        const open = editors.list().map((e) => ({ label: e.title, description: e.path ?? "", icon: "files", docId: e.id }));
        const files = fileCache && fileCache.folder === folder ? fileCache.files : [];
        const scored: { item: any; score: number }[] = [];
        for (const e of open) {
          const m = fuzzyScore(q, e.label);
          if (m) scored.push({ item: { ...e, _label: highlight(e.label, m.ranges), description: "open editor" }, score: m.score + 100 });
        }
        if (q) {
          for (const rel of files) {
            const name = basename(rel);
            const m = fuzzyScore(q, name) ?? (fuzzyScore(q, rel) ? { score: -50, ranges: [] as [number, number][] } : null);
            if (m) scored.push({ item: { label: name, _label: highlight(name, m.ranges), description: rel, fileIcon: name, path: `${folder}/${rel}` }, score: m.score });
            if (scored.length > 4000) break;
          }
        } else {
          for (const rel of files.slice(0, 30)) scored.push({ item: { label: basename(rel), description: rel, fileIcon: basename(rel), path: `${folder}/${rel}` }, score: 0 });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 200).map((s) => s.item);
      },
    });
    if (!result || typeof result === "string") return;
    if (result.docId === "__line") return;
    if (result.docId) {
      editors.activateById(result.docId);
    } else if (result.path) editors.openFile(result.path);
  };

  reg("workbench.commandPalette", "Show All Commands", () => commandPalette());
  reg("workbench.quickOpen", "Go to File…", () => quickOpen());
  reg("workbench.toggleSidebar", "Toggle Primary Side Bar Visibility", () => wb.toggle("sidebar"));
  reg("workbench.togglePanel", "Toggle Panel Visibility", () => wb.toggle("panel"));
  reg("workbench.customizeLayout", "Customize Layout…", () => wb.customizeLayout());
  reg("workbench.toggleActivityBar", "Toggle Activity Bar Visibility", () => wb.setOptions({ activityBar: !wb.options.activityBar }));
  reg("workbench.toggleStatusBar", "Toggle Status Bar Visibility", () => wb.setOptions({ statusBar: !wb.options.statusBar }));
  reg("workbench.toggleSidebarPosition", "Toggle Primary Side Bar Position", () => wb.setOptions({ sidebarSide: wb.options.sidebarSide === "left" ? "right" : "left" }));
  reg("workbench.toggleMaximizedPanel", "Toggle Maximized Panel", () => wb.toggleMaximized("panel"));
  reg("workbench.toggleMaximizedSecondary", "Maximize Secondary Side Bar", () => wb.toggleMaximized("secondary"));
  const win = getCurrentWindow();
  reg("workbench.toggleFullScreen", "Toggle Full Screen", async () => win.setFullscreen(!(await win.isFullscreen())));
  // Zen Mode: only the editor, full screen; the same command (or Escape twice) brings everything back.
  let zen: { sidebar: boolean; secondary: boolean; panel: boolean; options: typeof wb.options; full: boolean } | null = null;
  let lastEscape = 0;
  const toggleZen = async () => {
    if (zen) {
      const z = zen;
      zen = null;
      wb.setOptions({ activityBar: z.options.activityBar, statusBar: z.options.statusBar }, false);
      for (const loc of ["sidebar", "secondary", "panel"] as const) if (z[loc] !== wb.state[loc].visible) wb.toggle(loc);
      if (!z.full) await win.setFullscreen(false).catch(() => {});
      document.documentElement.classList.remove("zen");
      return;
    }
    zen = { sidebar: wb.state.sidebar.visible, secondary: wb.state.secondary.visible, panel: wb.state.panel.visible, options: { ...wb.options }, full: await win.isFullscreen().catch(() => false) };
    for (const loc of ["sidebar", "secondary", "panel"] as const) if (wb.state[loc].visible) wb.toggle(loc);
    wb.setOptions({ activityBar: false, statusBar: false }, false);
    document.documentElement.classList.add("zen");
    await win.setFullscreen(true).catch(() => {});
  };
  reg("workbench.toggleZenMode", "Toggle Zen Mode", toggleZen);
  window.addEventListener("keydown", (e) => {
    if (!zen || e.key !== "Escape") return;
    const now = performance.now();
    if (now - lastEscape < 600) toggleZen();
    lastEscape = now;
  });
  commands.bind("ctrl+mod+f", "workbench.toggleFullScreen");
  commands.bind("mod+k z", "workbench.toggleZenMode");
  reg("workbench.toggleSecondary", "Toggle Secondary Side Bar Visibility", () => wb.toggle("secondary"));
  reg("workbench.reload", "Reload Window", () => location.reload(), "Developer");
  reg("workbench.newWindow", "New Window", () => invoke("window_new", {}), "File");
  reg("workbench.openFolderNewWindow", "Open Folder in New Window…", async () => {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder === "string") await invoke("window_new", { paths: [folder] });
  }, "File");
  reg("window.close", "Close Window", () => getCurrentWindow().close(), "Window");
  reg("window.toggleMaximize", "Toggle Maximize", () => getCurrentWindow().toggleMaximize(), "Window");
  reg("preferences.theme", "Color Theme", async () => {
    const choice = await pick(themes().map((t) => ({ label: t.label, description: t.source === "core" ? "built in" : `from ${t.source}`, id: t.id })), { placeholder: "Select Color Theme" });
    const entry = themes().find((t) => t.id === choice?.id);
    if (entry) await setTheme(entry);
  }, "Preferences");
  reg("profiles.switch", "Switch Profile…", async (target?: string) => {
    if (typeof target === "string" && target) return switchProfile(target);
    const prof = await invoke<ProfileView>("profile_get");
    const choice = await pick(
      [
        ...prof.available.map((p) => ({ label: p, description: p === prof.name ? "current" : "", icon: p === prof.name ? "check" : "account", value: p })),
        { label: "New Profile…", description: "empty, or a copy of one", value: "__new", icon: "add" },
        { label: "Manage Profiles", description: "rename, export, import, delete", value: "__manage", icon: "settings-gear" },
      ],
      { placeholder: "Profiles keep their own mods, settings, shortcuts and windows" },
    );
    if (!choice) return;
    if (choice.value === "__manage") return openProfiles(editors);
    const name = choice.value === "__new" ? await createProfile() : (choice.value as string);
    if (name && name !== prof.name) await switchProfile(name);
  }, "Preferences");
  reg("profiles.manage", "Profiles", () => openProfiles(editors), "Preferences");
  reg("profiles.create", "New Profile…", () => createProfile(), "Preferences");
  reg("profiles.import", "Import Profile…", (path?: string) => importProfile(typeof path === "string" ? path : undefined), "Preferences");
  reg("profiles.export", "Export Profile…", async (name?: string, path?: string) => exportProfile(typeof name === "string" && name ? name : (await invoke<ProfileView>("profile_get")).name, path), "Preferences");
  reg("workbench.resetViewLocations", "Reset View Locations", () => wb.resetPlacement());
  reg("workbench.moveView", "Move View…", async () => {
    const all = (["sidebar", "secondary", "panel"] as const).flatMap((loc) => wb.viewsAt(loc));
    const view = await pick(all.map((d) => ({ label: d.title, description: d.location, icon: d.icon, id: d.id })), { placeholder: "Select a view to move" });
    if (!view) return;
    const names = { sidebar: "Primary Side Bar", secondary: "Secondary Side Bar", panel: "Panel" } as const;
    const to = await pick((Object.keys(names) as (keyof typeof names)[]).filter((l) => l !== view.description).map((l) => ({ label: names[l], loc: l })), { placeholder: `Move ${view.label} to…` });
    if (to) wb.moveView(view.id as string, to.loc as any);
  });
  editors.restorers.set("profiles", () => openProfiles(editors));
  const settingsPage = () => openSettings({ host, editors, themes, applyCore });
  reg("preferences.settings", "Settings", settingsPage, "Preferences");
  editors.restorers.set("settings", settingsPage);
  reg("preferences.openProfileJson", "Open Profile Settings (JSON)", async () => {
    const prof = await invoke<ProfileView>("profile_get");
    await editors.openFile(prof.path);
  }, "Preferences");
  reg("preferences.toggleAnimations", "Toggle Animations", async () => {
    const on = !motionEnabled();
    setMotion(on);
    void applyCore;
    await invoke("settings_set", { modId: "core", key: "animations", value: on });
    notify("info", !on ? "Animations are off." : motionEnabled() ? "Animations are on." : "Animations stay off while macOS Reduce motion is on.");
  }, "Preferences");
  reg("workbench.keybindings", "Keyboard Shortcuts", () => {
    editors.openPage({
      title: "Keyboard Shortcuts",
      icon: "record-keys",
      key: "keybindings",
      restore: "keybindings",
      render: (el) => {
        const page = h("div", { class: "mods-page" });
        el.append(page);
        let filter = "";
        let recording: { command: string; stop: () => void } | null = null;

        const save = async (change: (list: ProfileView["keybindings"]) => ProfileView["keybindings"]) => {
          const prof = await invoke<ProfileView>("profile_get");
          const list = change(prof.keybindings ?? []);
          await invoke("profile_set_keybindings", { keybindings: list });
          applyUserKeybindings(list);
          render();
        };
        const record = (command: string, cell: HTMLElement) => {
          recording?.stop();
          cell.replaceChildren(h("span", { class: "recording" }, "Press the keys… (Esc cancels, ⌫ removes the shortcut)"));
          commands.suspendKeys(true);
          let first: string | null = null;
          let timer: number | undefined;
          const finish = (key: string | null) => {
            stop();
            if (key === null) return render();
            save((list) => [...list.filter((k) => k.command !== command), { key, command }]);
          };
          const onKey = (e: KeyboardEvent) => {
            if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            const chord = commands.eventChord(e);
            if (!first && chord === "escape") return finish(null);
            if (!first && chord === "backspace") return finish("");
            if (first) return finish(`${first} ${chord}`);
            first = chord;
            cell.replaceChildren(h("span", { class: "recording" }, commands.prettyKey(chord).join(" "), " … (press a second key for a chord, or wait)"));
            // A single key unless a second one follows quickly (a chord like ⌘K ⌘T).
            timer = window.setTimeout(() => finish(first), 900);
          };
          const stop = () => {
            clearTimeout(timer);
            window.removeEventListener("keydown", onKey, true);
            commands.suspendKeys(false);
            recording = null;
          };
          window.addEventListener("keydown", onKey, true);
          recording = { command, stop };
        };

        const render = () => {
          const q = filter.toLowerCase();
          const rows = commands
            .all()
            .map((c) => ({ c, key: commands.keybindingFor(c.id), owner: commands.keybindingOwner(c.id) }))
            .filter(({ c, key }) => !q || `${c.category ?? ""}: ${c.title} ${c.id} ${key ?? ""}`.toLowerCase().includes(q))
            .sort((a, b) => (a.c.category ?? "").localeCompare(b.c.category ?? "") || a.c.title.localeCompare(b.c.title));
          const search = h("input", { class: "input", placeholder: "Search commands and keys", value: filter, oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value; render(); (page.querySelector(".mods-toolbar input") as HTMLInputElement)?.focus(); } });
          page.replaceChildren(
            h("h1", null, "Keyboard Shortcuts"),
            h("p", { class: "muted" }, "Click a shortcut to change it. Yours are kept in the current profile and replace the default of that command; mods declare their own defaults in mod.json."),
            h("div", { class: "mods-toolbar" }, search),
            h(
              "table",
              { class: "res-table keys-table" },
              h("thead", null, h("tr", null, h("th", null, "Command"), h("th", null, "Keybinding"), h("th", null, "Source"), h("th", null, ""))),
              h(
                "tbody",
                null,
                rows.map(({ c, key, owner }) => {
                  const cell = h("td", { class: "key-cell", title: "Click to change", onclick: () => record(c.id, cell) }, key ? commands.prettyKey(key).map((k) => h("kbd", null, k)) : h("span", { class: "muted" }, owner === "user" ? "none" : "—"));
                  return h(
                    "tr",
                    null,
                    h("td", null, `${c.category ? c.category + ": " : ""}${c.title}`, h("div", { class: "muted", style: { fontSize: "11px" } }, c.id)),
                    cell,
                    h("td", { class: "muted" }, owner === "user" ? "you (profile)" : owner ?? (key ? "menu" : c.owner)),
                    h("td", null, owner === "user" ? h("button", { class: "icon-button", title: "Back to the default", onclick: () => save((list) => list.filter((k) => k.command !== c.id)) }, icon("discard")) : null),
                  );
                }),
              ),
            ),
          );
        };
        render();
        return { dispose: () => recording?.stop() };
      },
    });
  }, "Preferences");
  editors.restorers.set("keybindings", () => commands.execute("workbench.keybindings"));
  reg("developer.showRunning", "Show Running Mods", () => {
    const lines = host.list().map((m) => `${m.name}: ${m.state}${m.loadMs != null ? ` (${m.loadMs} ms)` : ""}`);
    notify("info", lines.length ? lines.join("\n") : "No mods enabled.");
  }, "Developer");
  reg("help.about", "About AICode", async () => {
    const info = await invoke<{ version: string; modApi: number; dataDir: string }>("core_info");
    notify("info", `AICode ${info.version} · mod API ${info.modApi}\nData: ${info.dataDir}`);
  }, "Help");

  void icon;
}

/**
 * AICODE_DIAG_RUN="@repl <mod id>": drives the app from outside. Each time the enabled mod's
 * `in.txt` changes to a new <seq>, imports its `q/<seq>.js` (CSP allows only aimod: scripts),
 * awaits its default export and writes the result to the mod's `out.json`.
 */
async function diagRepl(host: ModHost, modId: string) {
  const dir = host.list().find((m) => m.id === modId)?.dir;
  if (!dir) return invoke("core_log", { level: "diag", message: `repl: no mod ${modId}` });
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    let seq: string;
    try {
      seq = (await invoke<{ text: string }>("fs_read_text", { modId: "core", path: `${dir}/in.txt` })).text.trim();
    } catch {
      continue;
    }
    if (!seq || seq === last) continue;
    last = seq;
    let out: unknown;
    try {
      const m = await import(/* @vite-ignore */ host.url(modId, `q/${seq}.js`));
      out = { ok: await m.default() };
    } catch (e) {
      out = { error: `${e}\n${(e as Error)?.stack ?? ""}` };
    }
    let json: string;
    try {
      json = JSON.stringify({ seq, ...(out as object) }, null, 1);
    } catch (e) {
      json = JSON.stringify({ seq, error: "unserializable: " + e });
    }
    await invoke("fs_write_text", { modId: "core", path: `${dir}/out.json`, text: json }).catch(() => {});
  }
}

/** AICODE_DIAG=1: a text picture of the window, written to the terminal (for checks without a screen). */
function diagnostics() {
  const box = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return `${sel}: missing`;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return `${sel}: ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} display=${st.display} bg=${st.backgroundColor}`;
  };
  const text = (sel: string, max = 300) => Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ").slice(0, max);
  const lines = [
    `window ${getCurrentWindow().label} ${innerWidth}x${innerHeight} folder=${(window as any).aicode?.workspace.folder}`,
    ...[".titlebar", ".activitybar", ".part.sidebar", ".center", ".editor-group", ".part.panel", ".part.secondary", ".statusbar", ".editor-body", ".monaco-host", ".monaco-editor", ".xterm", ".xterm-screen"].map((s) => box(s)),
    `activity items: ${document.querySelectorAll(".activity-item").length}`,
    `tabs: ${text(".tab .label")}`,
    `sidebar header: ${text(".part.sidebar .part-header")}`,
    `sidebar view: ${text(".part.sidebar .view-host:not([style*='none'])", 400)}`,
    `secondary header: ${text(".part.secondary .part-header")}`,
    `secondary view: ${text(".part.secondary .view-host:not([style*='none'])", 400)}`,
    `panel header: ${text(".part.panel .part-header")}`,
    `terminal: ${text(".xterm-rows", 300)} rows=${document.querySelector(".xterm-rows")?.children.length ?? "none"} streams=${JSON.stringify(streamCounts)}`,
    `status: ${text(".statusbar .status-item")}`,
    `monaco: model lines=${(window as any).aicode?.editors.editor.getModel()?.getLineCount()} rendered=${document.querySelectorAll(".view-line").length} first="${(document.querySelector(".view-line") as HTMLElement | null)?.textContent?.slice(0, 80) ?? ""}"`,
    `editor bg: ${getComputedStyle(document.documentElement).getPropertyValue("--aicode-editor-background")} language: ${(window as any).aicode?.editors.editor.getModel()?.getLanguageId()}`,
    `tokens: ${(() => {
      const model = (window as any).aicode?.editors.editor.getModel();
      if (!model) return "";
      const line = model.getLinesContent().find((l: string) => l.trim().length > 20) ?? "";
      return monaco.editor
        .tokenize(line, model.getLanguageId())[0]
        .map((t) => t.type)
        .filter(Boolean)
        .slice(0, 8)
        .join(" | ");
    })()}`,
    `font: ${getComputedStyle(document.body).fontFamily.slice(0, 60)} codicon loaded: ${document.fonts.check("16px codicon")}`,
    `icons: activity=${getComputedStyle(document.querySelector(".activity-item .codicon") ?? document.body).fontSize} bar=${(document.querySelector(".activitybar") as HTMLElement | null)?.offsetWidth} list=${getComputedStyle(document.documentElement).getPropertyValue("--list-icon")}`,
    `views: ${(["sidebar", "secondary", "panel"] as const).map((l) => `${l}=[${(window as any).aicode?.wb.viewsAt(l).map((d: any) => d.id).join(",")}]`).join(" ")}`,
    `status: ${text(".statusbar .status-item", 400)}`,
    `toasts: ${text(".toast .msg", 600)}`,
    `custom tab: ${text(".custom-host", 500)}`,
    `editor text: ${JSON.stringify(((window as any).aicode?.editors.editor.getModel()?.getValue() ?? "").slice(0, 200))}`,
  ];
  invoke("core_log", { level: "diag", message: "\n" + lines.join("\n") });
  motionSelfTest();
}

/** AICODE_DIAG_RUN="@drag <view> <sidebar|secondary|panel|before:<view>>": drags a view with mouse events. */
async function dragSelfTest(viewId: string, where: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wb = (window as any).aicode?.wb;
  const source = (document.querySelector(`.activity-item[data-before="${viewId}"], .part-tab[data-before="${viewId}"]`) as HTMLElement | null) ?? null;
  if (!source) return invoke("core_log", { level: "diag", message: `drag test: no handle for ${viewId}` });
  const center = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const target = where.startsWith("before:")
    ? document.querySelector(`[data-before="${where.slice(7)}"]`)
    : document.querySelector(`.view-drop-zones .zone[data-drop="${where}"]`);
  const a = center(source);
  source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: a.x, clientY: a.y }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: a.x + 20, clientY: a.y + 20 }));
  await wait(50);
  if (!target) return invoke("core_log", { level: "diag", message: `drag test: no target ${where}` });
  const b = center(target);
  const r = (target as HTMLElement).getBoundingClientRect();
  const bx = where.startsWith("before:") ? r.left + 3 : b.x;
  const by = where.startsWith("before:") ? r.top + 3 : b.y;
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: bx, clientY: by }));
  await wait(50);
  const highlighted = document.querySelector(".drop-target, .drop-before, .drop-after")?.className ?? "none";
  const ghost = !!document.querySelector(".view-drag-ghost");
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: bx, clientY: by }));
  await wait(400);
  const views = (["sidebar", "secondary", "panel"] as const).map((l) => `${l}=[${wb.viewsAt(l).map((d: any) => d.id).join(",")}]`).join(" ");
  invoke("core_log", { level: "diag", message: `drag test ${viewId} → ${where}: ghost=${ghost} highlighted="${highlighted}" now ${views} visible=${wb.isVisible(viewId)} host-in=${document.querySelector(`.view-host[data-view="${viewId}"]`)?.closest(".part")?.className}` });
}

/** AICODE_DIAG: closes and reopens the primary side bar, sampling its width as it animates. */
async function motionSelfTest() {
  const wb = (window as any).aicode?.wb;
  const el = document.querySelector(".part.sidebar") as HTMLElement | null;
  if (!wb || !el || el.style.display === "none") return;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const width = () => `${Math.round(el.getBoundingClientRect().width)}px/${getComputedStyle(el).display}`;
  const out: string[] = [`motion=${document.documentElement.classList.contains("no-motion") ? "off" : "on"}`];
  wb.toggle("sidebar");
  await wait(70);
  out.push(`closing@70ms=${width()}`);
  await wait(400);
  out.push(`closed=${width()}`);
  wb.toggle("sidebar");
  await wait(70);
  out.push(`opening@70ms=${width()}`);
  await wait(400);
  out.push(`open=${width()}`);
  invoke("core_log", { level: "diag", message: `motion test: ${out.join(" ")}` });
}

boot().catch((e) => {
  console.error(e);
  document.body.append(Object.assign(document.createElement("pre"), { textContent: `AICode failed to start:\n${e?.stack ?? e}`, style: "color:#f85149;padding:20px;white-space:pre-wrap" }));
});
