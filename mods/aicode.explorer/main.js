// Explorer: the open folder as a tree, and the open editors. Works the way VS Code's does —
// keyboard navigation, multi-select, new/rename right in the tree, delete to the Trash, cut/copy/
// paste, drag to move (⌥ to copy), git colors from other mods, and it follows the disk as files
// change. Opening a folder here is what gives the rest of AICode a workspace.

const isMac = navigator.platform.toLowerCase().includes("mac");
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const PAD = 12; // left padding of a top-level row
const INDENT = 8; // per level, like VS Code
const TWISTIE = 16;
const DEFAULT_EXCLUDE = [".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"];

const STYLE = `
.explorer { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; }
.explorer .ex-section { display: flex; flex-direction: column; min-height: 0; }
.explorer .ex-section.grow { flex: 1 1 auto; }
.explorer .ex-section > .section-header { flex: 0 0 auto; }
.explorer .ex-section + .ex-section > .section-header { box-shadow: 0 -1px 0 var(--aicode-sideBarSectionHeader-border, transparent); }
.explorer .ex-section > .section-header .actions { display: none; }
.explorer .ex-section:hover > .section-header .actions, .explorer .ex-section:focus-within > .section-header .actions { display: flex; }
.explorer .ex-body { overflow: auto; min-height: 0; flex: 1 1 auto; position: relative; }
.explorer .ex-tree { outline: none; padding-bottom: 12px; min-height: 100%; box-sizing: border-box; }
.explorer .ex-open-editors .ex-body { max-height: 40vh; flex: 0 1 auto; }
.explorer .tree-row { position: relative; gap: 0; padding-right: 10px; }
.explorer .tree-row .twistie { width: ${TWISTIE}px; flex: 0 0 ${TWISTIE}px; display: inline-flex; justify-content: center; }
body .explorer .tree-row .twistie .codicon { font-size: 16px; }
.explorer .tree-row .twistie .ficon { margin: 0; }
.explorer .tree-row .name, .explorer .tree-row .tree-input { margin-left: 6px; }
.explorer .tree-row .name { flex: 0 1 auto; }
.explorer .tree-row .deco { margin-left: auto; padding-left: 8px; font-size: 12px; flex: 0 0 auto; }
.explorer .tree-row .deco.dot { font-size: 18px; line-height: 0; opacity: .8; }
.explorer .tree-row.faded .name, .explorer .tree-row.faded .ficon { opacity: .55; }
.explorer .tree-row.cut .name, .explorer .tree-row.cut .ficon { opacity: .5; }
.explorer .guide { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px solid transparent; pointer-events: none; transition: border-color var(--motion-fast) ease; }
.explorer .ex-tree:hover .guide, .explorer .ex-tree:focus .guide { border-color: var(--aicode-tree-inactiveIndentGuidesStroke); }
.explorer .ex-tree:hover .guide.active, .explorer .ex-tree:focus .guide.active { border-color: var(--aicode-tree-indentGuidesStroke); }
.explorer .list-row.selected { background: var(--aicode-list-inactiveSelectionBackground); }
.explorer .ex-tree:focus .list-row.selected { background: var(--aicode-list-activeSelectionBackground); color: var(--aicode-list-activeSelectionForeground, inherit); }
.explorer .ex-tree:focus .list-row.focused { outline: 1px solid var(--aicode-list-focusOutline); outline-offset: -1px; }
.explorer .list-row.focused:not(.selected) { background: transparent; }
.explorer .list-row.focused:not(.selected):hover { background: var(--aicode-list-hoverBackground); }
.explorer .ex-tree:not(:focus) .list-row.focused { outline: none; }
.explorer .tree-row.drop-target, .explorer .tree-row.in-drop { background: var(--aicode-list-dropBackground); }
.explorer .ex-tree.drop-root { background: var(--aicode-list-dropBackground); }
.explorer .tree-input { flex: 1 1 auto; min-width: 40px; height: 20px; box-sizing: border-box; margin-right: 0; padding: 0 3px; font: inherit; color: var(--aicode-input-foreground); background: var(--aicode-input-background); border: 1px solid var(--aicode-focusBorder); outline: none; border-radius: 0; user-select: text; -webkit-user-select: text; }
.explorer .tree-input.invalid { border-color: var(--aicode-inputValidation-errorBorder, #be1100); }
.explorer .tree-input.warn { border-color: var(--aicode-inputValidation-warningBorder, #b89500); }
.explorer .tree-msg { position: absolute; z-index: 5; left: var(--msg-left); right: 10px; top: 100%; padding: 4px 6px; font-size: 12px; line-height: 1.4; white-space: normal; border: 1px solid var(--aicode-inputValidation-errorBorder, #be1100); background: var(--aicode-inputValidation-errorBackground, #5a1d1d); color: var(--aicode-foreground); }
.explorer .tree-msg.warn { border-color: var(--aicode-inputValidation-warningBorder, #b89500); background: var(--aicode-inputValidation-warningBackground, #352a05); }
.explorer .ex-empty { padding: 10px 20px; display: flex; flex-direction: column; gap: 12px; }
.explorer .oe-row .twistie { visibility: hidden; }
.explorer .oe-row:hover .twistie, .explorer .oe-row.dirty .twistie { visibility: visible; }
.explorer .oe-row.dirty:hover .twistie .codicon-circle-filled::before { content: "\\ea76"; }
.explorer .oe-row .hint { margin-left: 6px; }
.ex-drag-ghost { position: fixed; z-index: 300; pointer-events: none; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: var(--aicode-list-activeSelectionBackground); color: var(--aicode-list-activeSelectionForeground, var(--aicode-foreground)); box-shadow: 0 2px 8px var(--aicode-widget-shadow); white-space: nowrap; }
`;

export async function activate(ctx) {
  const { h, icon, iconButton, clear, basename, dirname, joinPath, fileIcon, fileIconColor, fileIconEl } = ctx.ui;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  ctx.subscriptions.push({ dispose: () => style.remove() });

  const setting = (key, fallback) => ctx.settings.get(key, fallback);
  const children = new Map(); // folder path → sorted entries
  const expanded = new Set();
  const watches = new Map(); // folder path → disposable
  let selection = new Set();
  let focused = null;
  let anchor = null;
  let editing = null; // { kind: "file" | "folder" | "rename", dir, path?, value, message?, level? }
  let clipboard = null; // { paths, cut }
  let openEditorsCollapsed = await setting("openEditorsCollapsed", false);
  // Like VS Code: Open Editors is off until turned on from the view's ··· menu.
  let showOpenEditors = await setting("showOpenEditors", false);
  let folderCollapsed = false;
  let root, treeEl, treeBody, editorsBody, folderHeader;
  let rows = []; // what the tree shows, top to bottom: { entry, depth } | { edit: true, depth, dir }
  let typed = { text: "", at: 0 };

  const folder = () => ctx.workspace.folder();
  const rel = (p) => (folder() && p.startsWith(folder() + "/") ? p.slice(folder().length + 1) : p);
  const entryOf = (path) => {
    if (path === folder()) return { name: basename(path), path, is_dir: true };
    for (const list of children.values()) {
      const e = list.find((x) => x.path === path);
      if (e) return e;
    }
    return null;
  };
  const isUnder = (p, dir) => p === dir || p.startsWith(dir + "/");

  // ---------- disk ----------

  const sortEntries = (list) => list.sort((a, b) => (a.is_dir === b.is_dir ? collator.compare(a.name, b.name) : a.is_dir ? -1 : 1));

  const parseExclude = (v) => new Set((Array.isArray(v) ? v : String(v).split(",")).map((x) => x.trim()).filter(Boolean));
  let exclude = parseExclude(await setting("exclude", DEFAULT_EXCLUDE));
  const loadDir = async (dir) => {
    try {
      children.set(dir, sortEntries((await ctx.fs.readDir(dir)).filter((e) => !exclude.has(e.name))));
    } catch (e) {
      children.set(dir, []);
      if (dir === folder()) ctx.window.showError(String(e));
    }
    watch(dir);
    return children.get(dir);
  };

  const changed = new Set();
  let changeTimer = null;
  const watch = (dir) => {
    if (watches.has(dir)) return;
    watches.set(dir, ctx.fs.watch(dir, () => {
      changed.add(dir);
      clearTimeout(changeTimer);
      changeTimer = setTimeout(reloadChanged, 120);
    }));
  };
  const unwatchUnused = () => {
    for (const [dir, d] of watches) {
      if (dir !== folder() && !expanded.has(dir)) {
        d.dispose();
        watches.delete(dir);
        children.delete(dir);
      }
    }
  };
  const reloadChanged = async () => {
    const dirs = [...changed].filter((d) => children.has(d));
    changed.clear();
    if (!dirs.length) return;
    await Promise.all(dirs.map(loadDir));
    // Folders that vanished take their expanded state (and watchers) with them.
    for (const p of [...expanded]) if (!entryOf(p)) expanded.delete(p);
    for (const p of [...selection]) if (!entryOf(p)) selection.delete(p);
    if (focused && !entryOf(focused)) focused = null;
    unwatchUnused();
    render();
  };

  const gitSoon = () => ctx.commands.exists("git.refresh") && ctx.commands.execute("git.refresh").catch(() => {});

  const remember = () => {
    if (!folder()) return;
    try {
      localStorage.setItem(`aicode.explorer.expanded:${folder()}`, JSON.stringify([...expanded].slice(0, 300)));
    } catch {}
  };
  const restore = async () => {
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(`aicode.explorer.expanded:${folder()}`) || "[]");
    } catch {}
    list.sort((a, b) => a.length - b.length);
    for (const p of list) {
      if (!children.has(dirname(p))) continue;
      if (!(children.get(dirname(p)) ?? []).some((e) => e.path === p && e.is_dir)) continue;
      expanded.add(p);
      await loadDir(p);
    }
  };

  // ---------- tree model ----------

  const computeRows = () => {
    const out = [];
    const walk = (dir, depth) => {
      const list = children.get(dir) ?? [];
      const newHere = editing && editing.kind !== "rename" && editing.dir === dir;
      let placed = false;
      if (newHere && editing.kind === "folder") {
        out.push({ edit: true, depth, dir });
        placed = true;
      }
      for (const e of list) {
        if (newHere && !placed && !e.is_dir) {
          out.push({ edit: true, depth, dir });
          placed = true;
        }
        out.push({ entry: e, depth });
        if (e.is_dir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
      if (newHere && !placed) out.push({ edit: true, depth, dir });
    };
    if (folder()) walk(folder(), 0);
    return out;
  };

  const visiblePaths = () => rows.filter((r) => r.entry).map((r) => r.entry.path);

  const setFocus = (path, { select = true, extend = false, toggle = false } = {}) => {
    focused = path;
    if (extend && anchor) {
      const list = visiblePaths();
      const [a, b] = [list.indexOf(anchor), list.indexOf(path)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) selection = new Set(list.slice(a, b + 1));
    } else if (toggle) {
      if (selection.has(path)) selection.delete(path);
      else selection.add(path);
      anchor = path;
    } else if (select) {
      selection = new Set(path ? [path] : []);
      anchor = path;
    }
  };

  /** What the actions work on: the selection when the focused row is in it, else that row. */
  const targets = (path = focused) => (path && selection.has(path) ? [...selection] : path ? [path] : []);
  /** The folder new files and pastes go into. */
  const targetDir = (path = focused) => {
    if (!path) return folder();
    const e = entryOf(path);
    return e?.is_dir ? path : dirname(path);
  };

  const toggleDir = async (path, open = !expanded.has(path)) => {
    if (open) {
      expanded.add(path);
      if (!children.has(path)) await loadDir(path);
      render(path);
    } else {
      expanded.delete(path);
      for (const p of [...expanded]) if (p.startsWith(path + "/")) expanded.delete(p);
      unwatchUnused();
      render();
    }
    remember();
  };

  const revealPath = async (path, { focus = false, select = true } = {}) => {
    if (!folder() || !path || !isUnder(path, folder()) || path === folder()) return;
    const chain = [];
    for (let d = dirname(path); d.length > folder().length; d = dirname(d)) chain.unshift(d);
    if (!children.has(folder())) await loadDir(folder());
    for (const d of chain) {
      expanded.add(d);
      if (!children.has(d)) await loadDir(d);
    }
    if (select) setFocus(path);
    else focused = path;
    folderCollapsed = false;
    render();
    remember();
    treeEl?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
    if (focus) treeEl?.focus();
  };

  // ---------- actions ----------

  const openFile = (path, preview = true) => ctx.editor.open(path, { preview });

  const validate = (value, dir, self) => {
    const name = value;
    if (!name || !name.trim()) return { message: "A file or folder name must be provided.", level: "error" };
    if (name.startsWith("/") || name.includes("\\")) return { message: "The name is not valid as a file or folder name. Please choose a different name.", level: "error" };
    const parts = name.split("/").filter(Boolean);
    if (parts.some((p) => p === "." || p === "..")) return { message: "The name is not valid as a file or folder name. Please choose a different name.", level: "error" };
    const first = parts[0];
    const clash = (children.get(dir) ?? []).find((e) => e.path !== self && e.name.toLowerCase() === first.toLowerCase() && (parts.length === 1 || !e.is_dir));
    if (clash && !(self && clash.name === first && self === clash.path)) return { message: `A file or folder ${first} already exists at this location. Please choose a different name.`, level: "error" };
    if (/^\s|\s$/.test(name)) return { message: "Leading or trailing whitespace detected in file or folder name.", level: "warn" };
    return null;
  };

  const startNew = async (kind, dir = targetDir()) => {
    if (!folder()) return ctx.window.showInfo("Open a folder first.", { label: "Open Folder", run: () => openFolder() });
    folderCollapsed = false;
    if (dir !== folder()) {
      await revealPath(dir, { select: false });
      expanded.add(dir);
      if (!children.has(dir)) await loadDir(dir);
    }
    editing = { kind, dir, value: "" };
    render();
  };

  const startRename = (path = focused) => {
    if (!path || path === folder()) return;
    const e = entryOf(path);
    if (!e) return;
    editing = { kind: "rename", dir: dirname(path), path, value: e.name };
    render();
  };

  const commitEdit = async () => {
    const ed = editing;
    if (!ed || ed.committing) return;
    const value = ed.value;
    if (ed.kind === "rename" && value === entryOf(ed.path)?.name) return cancelEdit();
    if (!value.trim()) return cancelEdit();
    const problem = validate(value, ed.dir, ed.path);
    if (problem?.level === "error") return;
    ed.committing = true;
    const trimmed = value.replace(/\/+$/, "");
    const target = joinPath(ed.dir, trimmed);
    try {
      if (ed.kind === "rename") {
        await ctx.fs.rename(ed.path, target);
        for (const p of [...expanded]) if (isUnder(p, ed.path)) { expanded.delete(p); expanded.add(target + p.slice(ed.path.length)); }
        editing = null;
        await loadDir(ed.dir);
        for (const p of [...expanded]) if (isUnder(p, target) && !children.has(p)) await loadDir(p);
        setFocus(target);
      } else {
        await ctx.fs.create(target, ed.kind === "folder");
        editing = null;
        await loadDir(ed.dir);
        // a/b/c.txt made folders on the way: show them open.
        const parts = trimmed.split("/");
        let d = ed.dir;
        for (const part of parts.slice(0, -1)) {
          d = joinPath(d, part);
          expanded.add(d);
          await loadDir(d);
        }
        setFocus(target);
        if (ed.kind === "file") openFile(target, false);
      }
    } catch (e) {
      ed.committing = false;
      ctx.window.showError(String(e));
      return;
    }
    remember();
    render();
    gitSoon();
    if (ed.kind !== "file") treeEl?.focus();
    treeEl?.querySelector(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const cancelEdit = () => {
    editing = null;
    render();
    treeEl?.focus();
  };

  const remove = async (paths = targets()) => {
    paths = paths.filter((p) => p !== folder());
    // Inside a selected folder already: goes with it.
    paths = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + "/")));
    if (!paths.length) return;
    const names = paths.map((p) => basename(p));
    const single = paths.length === 1;
    const isDir = single && entryOf(paths[0])?.is_dir;
    if (await setting("confirmDelete", true)) {
      const ok = await ctx.window.confirm(
        single ? `Are you sure you want to delete '${names[0]}'${isDir ? " and its contents" : ""}?` : `Are you sure you want to delete the following ${paths.length} files/folders?`,
        (single ? "" : names.slice(0, 10).join("\n") + (names.length > 10 ? `\n…and ${names.length - 10} more` : "") + "\n\n") + `You can restore ${single ? (isDir ? "this folder" : "this file") : "them"} from the ${isMac ? "Trash" : "Recycle Bin"}.`,
        isMac ? "Move to Trash" : "Move to Recycle Bin",
      );
      if (!ok) return;
    }
    // Focus moves to the row after the last deleted one (or before, at the end).
    const list = visiblePaths();
    const last = Math.max(...paths.map((p) => list.indexOf(p)));
    const next = list.slice(last + 1).find((p) => !paths.some((q) => isUnder(p, q))) ?? list.slice(0, last).reverse().find((p) => !paths.some((q) => isUnder(p, q)));
    for (const p of paths) {
      try {
        await ctx.fs.delete(p);
      } catch (e) {
        ctx.window.showError(String(e));
      }
      for (const x of [...expanded]) if (isUnder(x, p)) expanded.delete(x);
    }
    await Promise.all([...new Set(paths.map(dirname))].filter((d) => children.has(d)).map(loadDir));
    unwatchUnused();
    setFocus(next ?? null);
    remember();
    render();
    gitSoon();
    treeEl?.focus();
  };

  /** "a.txt" → "a copy.txt" → "a copy 2.txt", like Finder and VS Code. */
  const freeName = (dir, name, isDir) => {
    const taken = new Set((children.get(dir) ?? []).map((e) => e.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = isDir || name.lastIndexOf(".") <= 0 ? -1 : name.lastIndexOf(".");
    const stem = dot < 0 ? name : name.slice(0, dot);
    const ext = dot < 0 ? "" : name.slice(dot);
    const base = stem.replace(/ copy( \d+)?$/, "");
    for (let n = 1; ; n++) {
      const candidate = `${base} copy${n > 1 ? ` ${n}` : ""}${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  };

  const setClipboard = (cut) => {
    const paths = targets().filter((p) => p !== folder());
    if (!paths.length) return;
    clipboard = { paths, cut };
    render();
  };

  /** Moves (or copies) paths into a folder. */
  const transfer = async (paths, dir, copy) => {
    paths = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + "/")));
    const done = [];
    if (!children.has(dir)) await loadDir(dir);
    for (const p of paths) {
      if (isUnder(dir, p)) {
        ctx.window.showWarning(`Cannot ${copy ? "copy" : "move"} '${basename(p)}' into itself.`);
        continue;
      }
      if (!copy && dirname(p) === dir) continue;
      const e = entryOf(p);
      const name = copy ? freeName(dir, basename(p), e?.is_dir) : basename(p);
      const to = joinPath(dir, name);
      try {
        if (copy) await ctx.fs.copy(p, to);
        else {
          if ((children.get(dir) ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase())) {
            const ok = await ctx.window.confirm(`A file or folder with the name '${name}' already exists in the destination folder. Do you want to replace it?`, "This action is irreversible!", "Replace");
            if (!ok) continue;
            await ctx.fs.delete(to);
          }
          await ctx.fs.rename(p, to);
          for (const x of [...expanded]) if (isUnder(x, p)) { expanded.delete(x); expanded.add(to + x.slice(p.length)); }
        }
        done.push(to);
        // Keep the listing current so the next free name sees this one.
        await loadDir(dir);
      } catch (err) {
        ctx.window.showError(String(err));
      }
    }
    await Promise.all([...new Set([dir, ...paths.map(dirname)])].filter((d) => children.has(d) || d === dir).map(loadDir));
    for (const x of [...expanded]) if (!children.has(x)) await loadDir(x);
    if (dir !== folder()) expanded.add(dir);
    unwatchUnused();
    if (done.length) {
      selection = new Set(done);
      focused = done[done.length - 1];
      anchor = focused;
    }
    remember();
    render();
    gitSoon();
    return done;
  };

  const paste = async (dir = targetDir()) => {
    if (!clipboard || !dir) return;
    const { paths, cut } = clipboard;
    const done = await transfer(paths, dir, !cut);
    if (cut) clipboard = null;
    if (done.length === 1 && !entryOf(done[0])?.is_dir && !cut) openFile(done[0]);
    render();
  };

  const copyPaths = (relative) => {
    const list = targets(focused ?? folder());
    if (!list.length) return;
    ctx.window.copy(list.map((p) => (relative ? rel(p) || "." : p)).join("\n"));
  };

  const openInTerminal = (path = targetDir()) => ctx.commands.execute("terminal.new", { cwd: path });

  const openFolder = async (path) => {
    const picked = typeof path === "string" ? path : await ctx.window.pickFolder();
    if (!picked) return;
    ctx.workspace.setFolder(picked);
    ctx.views.reveal("explorer", false);
  };

  const collapseAll = () => {
    expanded.clear();
    unwatchUnused();
    remember();
    render();
  };

  const refresh = async () => {
    if (!folder()) return render();
    await Promise.all([folder(), ...expanded].map(loadDir));
    render();
  };

  // ---------- menus ----------

  const k = (mac, other) => (isMac ? mac : other);
  const menuFor = (path) => {
    const list = path ? targets(path) : [];
    const e = path ? entryOf(path) : null;
    const multi = list.length > 1;
    const isDir = !e || e.is_dir;
    const dir = path ? targetDir(path) : folder();
    const hasTerminal = ctx.commands.exists("terminal.new");
    const hasSearch = ctx.commands.exists("search.inFolder");
    const hasChat = ctx.commands.exists("agents.attachFile");
    const items = [];
    if (e && !e.is_dir) items.push({ label: "Open", run: () => list.forEach((p) => !entryOf(p)?.is_dir && openFile(p, false)) });
    if (isDir && !multi) items.push({ label: "New File…", run: () => startNew("file", dir) }, { label: "New Folder…", run: () => startNew("folder", dir) });
    items.push({ label: isMac ? "Reveal in Finder" : "Reveal in File Explorer", keybinding: "alt+mod+r", run: () => ctx.fs.reveal(path ?? folder()) });
    if (hasTerminal && !multi) items.push({ label: "Open in Integrated Terminal", run: () => openInTerminal(dir) });
    items.push({ separator: true, label: "" });
    if (hasSearch && isDir && !multi) items.push({ label: "Find in Folder…", run: () => ctx.commands.execute("search.inFolder", dir) }, { separator: true, label: "" });
    if (hasChat && e && !e.is_dir) items.push({ label: multi ? "Add Files to Chat" : "Add File to Chat", run: () => list.forEach((p) => !entryOf(p)?.is_dir && ctx.commands.execute("agents.attachFile", p)) }, { separator: true, label: "" });
    if (path && path !== folder()) items.push({ label: "Cut", keybinding: "mod+x", run: () => setClipboard(true) }, { label: "Copy", keybinding: "mod+c", run: () => setClipboard(false) });
    if (isDir) items.push({ label: "Paste", keybinding: "mod+v", disabled: !clipboard, run: () => paste(dir) });
    items.push({ separator: true, label: "" });
    items.push({ label: "Copy Path", keybinding: "alt+mod+c", run: () => copyPaths(false) }, { label: "Copy Relative Path", keybinding: "shift+alt+mod+c", run: () => copyPaths(true) });
    if (path && path !== folder()) {
      items.push({ separator: true, label: "" });
      if (!multi) items.push({ label: "Rename…", keybinding: k("enter", "f2"), run: () => startRename(path) });
      items.push({ label: "Delete", keybinding: k("mod+backspace", "delete"), run: () => remove(list) });
    }
    return items;
  };

  const showMenu = (ev, path) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (path && !selection.has(path)) setFocus(path);
    else if (path) focused = path;
    else setFocus(null);
    render();
    treeEl?.focus();
    ctx.window.contextMenu(ev.clientX, ev.clientY, menuFor(path));
  };

  // ---------- drag and drop (pointer events: the OS owns HTML drag and drop here) ----------

  let drag = null;
  let swallowClick = false;
  const dropTargetAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !treeEl?.contains(el)) return null;
    const row = el.closest(".tree-row");
    if (!row?.dataset.path) return folder();
    const e = entryOf(row.dataset.path);
    return e?.is_dir ? e.path : dirname(row.dataset.path);
  };
  const paintDrop = (dir) => {
    treeEl.classList.toggle("drop-root", dir === folder());
    for (const r of treeEl.querySelectorAll(".tree-row")) {
      const p = r.dataset.path;
      r.classList.toggle("drop-target", !!dir && dir !== folder() && p === dir);
      r.classList.toggle("in-drop", !!dir && dir !== folder() && !!p && p.startsWith(dir + "/"));
    }
  };
  const startPointer = (ev, path) => {
    if (ev.button !== 0 || editing) return;
    const start = { x: ev.clientX, y: ev.clientY };
    const move = (e) => {
      if (!drag) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
        const paths = selection.has(path) ? [...selection] : [path];
        drag = { paths, ghost: h("div", { class: "ex-drag-ghost" }, paths.length === 1 ? basename(paths[0]) : `${paths.length} items`), target: null };
        document.body.append(drag.ghost);
      }
      drag.ghost.style.left = `${e.clientX + 12}px`;
      drag.ghost.style.top = `${e.clientY + 8}px`;
      let dir = dropTargetAt(e.clientX, e.clientY);
      if (dir && drag.paths.some((p) => isUnder(dir, p) || (!e.altKey && dirname(p) === dir && drag.paths.length === 1))) dir = null;
      drag.target = dir;
      drag.copy = e.altKey;
      paintDrop(dir);
      // Hovering a closed folder opens it, as in VS Code.
      clearTimeout(drag.openTimer);
      if (dir && dir !== folder() && !expanded.has(dir)) drag.openTimer = setTimeout(() => drag && toggleDir(dir, true).then(() => paintDrop(drag?.target)), 600);
      // Near the edges, scroll.
      const r = treeBody.getBoundingClientRect();
      if (e.clientY < r.top + 20) treeBody.scrollTop -= 8;
      else if (e.clientY > r.bottom - 20) treeBody.scrollTop += 8;
    };
    const up = async (e) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("keydown", esc, true);
      if (!drag) return;
      const d = drag;
      drag = null;
      clearTimeout(d.openTimer);
      d.ghost.remove();
      paintDrop(null);
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
      if (!d.target || e.type !== "pointerup") return;
      const copy = d.copy;
      if (!copy && (await setting("confirmDragAndDrop", true))) {
        const what = d.paths.length === 1 ? `'${basename(d.paths[0])}'` : `these ${d.paths.length} items`;
        const ok = await ctx.window.confirm(`Are you sure you want to move ${what} into '${basename(d.target)}'?`, "You can turn this question off in Settings → Explorer.", "Move");
        if (!ok) return;
      }
      await transfer(d.paths, d.target, copy);
    };
    const esc = (e) => {
      if (e.key !== "Escape" || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      up({ type: "cancel" });
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("keydown", esc, true);
  };

  // ---------- keyboard ----------

  const onTreeKey = (e) => {
    if (editing || e.isComposing) return;
    const list = visiblePaths();
    const i = focused ? list.indexOf(focused) : -1;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const go = (n) => {
      const p = list[Math.max(0, Math.min(list.length - 1, n))];
      if (!p) return;
      setFocus(p, { extend: e.shiftKey, select: !e.shiftKey });
      render();
      treeEl.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const fe = focused ? entryOf(focused) : null;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowDown" && mod && fe && !fe.is_dir) { handled(); openFile(focused, false); return; }
    switch (e.key) {
      case "ArrowDown": handled(); go(i + 1); return;
      case "ArrowUp": handled(); go(i < 0 ? 0 : i - 1); return;
      case "Home": handled(); go(0); return;
      case "End": handled(); go(list.length - 1); return;
      case "PageDown": handled(); go(i + Math.floor(treeBody.clientHeight / 22)); return;
      case "PageUp": handled(); go(i - Math.floor(treeBody.clientHeight / 22)); return;
      case "ArrowRight":
        handled();
        if (fe?.is_dir) {
          if (!expanded.has(focused)) toggleDir(focused, true);
          else go(i + 1);
        }
        return;
      case "ArrowLeft":
        handled();
        if (fe?.is_dir && expanded.has(focused)) toggleDir(focused, false);
        else if (focused && dirname(focused) !== folder()) {
          setFocus(dirname(focused));
          render();
        }
        return;
      case " ":
        handled();
        if (fe?.is_dir) toggleDir(focused);
        else if (fe) openFile(focused, true);
        return;
      case "Enter":
        handled();
        if (isMac && !mod) startRename();
        else if (fe?.is_dir) toggleDir(focused);
        else if (fe) openFile(focused, false);
        return;
      case "F2": handled(); startRename(); return;
      case "Escape":
        handled();
        if (clipboard) clipboard = null;
        setFocus(focused);
        render();
        return;
      case "Delete": handled(); remove(); return;
      case "Backspace": if (mod) { handled(); remove(); } return;
    }
    if (mod && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === "c") { handled(); clipAt = performance.now(); setClipboard(false); return; }
      if (key === "x") { handled(); clipAt = performance.now(); setClipboard(true); return; }
      if (key === "v") { handled(); clipAt = performance.now(); paste(); return; }
      if (key === "a") { handled(); selection = new Set(list); render(); return; }
    }
    if (mod && e.altKey && e.key.toLowerCase() === "c") { handled(); copyPaths(e.shiftKey); return; }
    if (mod && e.altKey && e.key.toLowerCase() === "r") { handled(); ctx.fs.reveal(focused ?? folder()); return; }
    // Type to jump to a name.
    if (e.key.length === 1 && !mod && !e.ctrlKey && !e.altKey) {
      handled();
      const now = performance.now();
      typed = { text: now - typed.at < 800 ? typed.text + e.key.toLowerCase() : e.key.toLowerCase(), at: now };
      const order = [...list.slice(i + (typed.text.length > 1 ? 0 : 1)), ...list.slice(0, i + 1)];
      const hit = order.find((p) => basename(p).toLowerCase().startsWith(typed.text));
      if (hit) go(list.indexOf(hit));
    }
  };
  // The app menu's Edit ▸ Copy / Cut / Paste may get the key first: same actions, once.
  let clipAt = 0;
  const onClipboardEvent = (kind) => (e) => {
    if (editing || document.activeElement !== treeEl) return;
    e.preventDefault();
    if (performance.now() - clipAt < 300) return;
    if (kind === "paste") paste();
    else setClipboard(kind === "cut");
  };

  // ---------- rendering ----------

  const fileGlyph = (name) => {
    if (fileIconEl) return fileIconEl(name);
    const el = icon(fileIcon(name));
    el.classList.add("ficon");
    const c = fileIconColor?.(name);
    if (c) el.style.color = c;
    return el;
  };

  const guides = (path, depth, activeDir) => {
    const out = [];
    const parts = rel(path).split("/");
    for (let level = 0; level < depth; level++) {
      const ancestor = joinPath(folder(), parts.slice(0, level + 1).join("/"));
      out.push(h("span", { class: `guide${ancestor === activeDir ? " active" : ""}`, style: { left: `${PAD + level * INDENT + TWISTIE / 2}px` } }));
    }
    return out;
  };

  const editInput = (depth) => {
    const ed = editing;
    const input = h("input", { class: "tree-input", value: ed.value, spellcheck: "false", autocapitalize: "off", autocomplete: "off" });
    const msg = h("div", { class: "tree-msg", style: { display: "none", "--msg-left": `${PAD + depth * INDENT + TWISTIE + 6}px` } });
    let glyph = null;
    const update = () => {
      ed.value = input.value;
      const problem = validate(input.value, ed.dir, ed.path);
      input.classList.toggle("invalid", problem?.level === "error");
      input.classList.toggle("warn", problem?.level === "warn");
      if (problem && input.value) {
        msg.textContent = problem.message;
        msg.className = `tree-msg${problem.level === "warn" ? " warn" : ""}`;
        msg.style.display = "";
      } else msg.style.display = "none";
      if (glyph && ed.kind !== "folder" && !(ed.kind === "rename" && entryOf(ed.path)?.is_dir)) {
        const next = fileGlyph(input.value || "file");
        glyph.replaceWith(next);
        glyph = next;
      }
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    });
    const keepSel = () => (ed.sel = [input.selectionStart, input.selectionEnd]);
    input.addEventListener("select", keepSel);
    input.addEventListener("keyup", keepSel);
    input.addEventListener("pointerup", keepSel);
    input.addEventListener("blur", () => !rendering && setTimeout(() => editing === ed && !rendering && (validate(ed.value, ed.dir, ed.path)?.level === "error" || !ed.value.trim() ? cancelEdit() : commitEdit()), 0));
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
    requestAnimationFrame(() => {
      input.focus();
      if (ed.sel) input.setSelectionRange(ed.sel[0], ed.sel[1]);
      else if (ed.kind === "rename") {
        const dot = entryOf(ed.path)?.is_dir ? -1 : ed.value.lastIndexOf(".");
        input.setSelectionRange(0, dot > 0 ? dot : ed.value.length);
      }
      update();
      ed.sel ??= [input.selectionStart, input.selectionEnd];
    });
    return { input, msg, setGlyph: (g) => (glyph = g) };
  };

  const rowEl = (r, activeDir, enterDir, enterIndex) => {
    if (r.edit) {
      const isFolder = editing.kind === "folder";
      const { input, msg, setGlyph } = editInput(r.depth);
      const glyph = isFolder ? null : fileGlyph("file");
      setGlyph(glyph);
      return h(
        "div",
        { class: "list-row tree-row editing", style: { paddingLeft: `${PAD + r.depth * INDENT}px` } },
        folder() ? guides(joinPath(r.dir, "x"), r.depth, activeDir) : null,
        h("span", { class: "twistie" }, isFolder ? icon("chevron-right") : glyph),
        input,
        msg,
      );
    }
    const e = r.entry;
    const path = e.path;
    const open = e.is_dir && expanded.has(path);
    const dec = ctx.decorations.get(path);
    const renaming = editing?.kind === "rename" && editing.path === path;
    const cls = ["list-row", "tree-row"];
    if (selection.has(path)) cls.push("selected");
    if (focused === path) cls.push("focused");
    if (dec?.faded) cls.push("faded");
    if (clipboard?.cut && clipboard.paths.includes(path)) cls.push("cut");
    const color = dec?.color ? `var(--aicode-${dec.color.replace(/\./g, "-")})` : null;
    let nameEl;
    let extra = null;
    if (renaming) {
      const { input, msg, setGlyph } = editInput(r.depth);
      nameEl = input;
      extra = msg;
      r.setGlyph = setGlyph;
    } else nameEl = h("span", { class: "name", style: color ? { color } : null }, e.name);
    const glyph = e.is_dir ? null : fileGlyph(e.name);
    if (renaming) r.setGlyph(glyph);
    const badge = dec?.badge && !renaming ? h("span", { class: `deco${e.is_dir ? " dot" : ""}`, style: color ? { color } : null }, e.is_dir ? "•" : dec.badge) : null;
    const el = h(
      "div",
      {
        class: cls.join(" "),
        dataset: { path },
        style: { paddingLeft: `${PAD + r.depth * INDENT}px` },
        title: [rel(path), dec?.tooltip].filter(Boolean).join(" • "),
        role: "treeitem",
        "aria-expanded": e.is_dir ? String(open) : null,
        "aria-selected": String(selection.has(path)),
        onpointerdown: (ev) => startPointer(ev, path),
        onclick: (ev) => {
          if (swallowClick || renaming) return;
          const mod = isMac ? ev.metaKey : ev.ctrlKey;
          if (ev.shiftKey) setFocus(path, { extend: true });
          else if (mod) setFocus(path, { toggle: true });
          else setFocus(path);
          treeEl.focus({ preventScroll: true });
          if (ev.shiftKey || mod) return render();
          if (e.is_dir) toggleDir(path);
          else {
            render();
            openFile(path, true);
          }
        },
        ondblclick: (ev) => {
          if (!e.is_dir && !renaming && !ev.shiftKey) openFile(path, false);
        },
        oncontextmenu: (ev) => showMenu(ev, path),
      },
      guides(path, r.depth, activeDir),
      // Like VS Code with an icon theme that has no folder icons: a file's icon sits where a
      // folder's arrow would, so files and folders of one level line up.
      h("span", { class: "twistie" }, e.is_dir ? icon(open ? "chevron-down" : "chevron-right") : glyph),
      nameEl,
      e.is_symlink && !renaming ? h("span", { class: "hint", style: { marginLeft: "6px" } }, icon("arrow-small-right")) : null,
      badge,
      extra,
    );
    if (enterDir && dirname(path) === enterDir) {
      el.classList.add("row-enter");
      el.style.animationDelay = `${Math.min(enterIndex.n++, 14) * 14}ms`;
    }
    return el;
  };

  const header = (title, collapsed, onToggle, actions) =>
    h(
      "div",
      { class: "section-header", onclick: onToggle, role: "button", "aria-expanded": String(!collapsed) },
      icon(collapsed ? "chevron-right" : "chevron-down"),
      h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, title),
      actions.length ? h("div", { class: "actions", onclick: (e) => e.stopPropagation() }, actions) : null,
    );

  const renderOpenEditors = () => {
    const editors = ctx.editor.all();
    const body = h(
      "div",
      { class: "ex-body" },
      editors.map((e) => {
        const dec = e.path ? ctx.decorations.get(e.path) : null;
        const color = dec?.color ? `var(--aicode-${dec.color.replace(/\./g, "-")})` : null;
        return h(
          "div",
          {
            class: `list-row oe-row${e.active ? " selected" : ""}${e.dirty ? " dirty" : ""}`,
            style: { paddingLeft: "12px" },
            title: e.path ?? e.title,
            onclick: () => ctx.editor.focus(e.id),
            onauxclick: (ev) => ev.button === 1 && ctx.editor.close(e.id),
          },
          h("span", { class: "twistie", title: "Close", onclick: (ev) => { ev.stopPropagation(); ctx.editor.close(e.id); } }, icon(e.dirty ? "circle-filled" : "close")),
          e.path ? fileGlyph(e.title) : icon(e.language ? "file" : "preview"),
          h("span", { class: "name", style: { marginLeft: "6px", ...(color ? { color } : {}) } }, e.title),
          e.path ? h("span", { class: "hint" }, rel(dirname(e.path)) === dirname(e.path) ? dirname(e.path).split("/").pop() : rel(dirname(e.path)) || "") : null,
        );
      }),
    );
    return h(
      "div",
      { class: "ex-section ex-open-editors" },
      header(
        "Open Editors",
        openEditorsCollapsed,
        () => {
          openEditorsCollapsed = !openEditorsCollapsed;
          ctx.settings.set("openEditorsCollapsed", openEditorsCollapsed);
          render();
        },
        [iconButton("save-all", "Save All", () => ctx.commands.execute("file.saveAll")), iconButton("close-all", "Close All Editors", () => ctx.commands.execute("editor.closeAll"))],
      ),
      openEditorsCollapsed ? null : body,
    );
  };

  let lastScroll = 0;
  let rendering = false;
  const render = (enterDir = null) => {
    if (!root) return;
    rendering = true;
    try {
      paint(enterDir);
    } finally {
      // Blur from the old input (now gone) fires synchronously during the swap; let it pass first.
      setTimeout(() => (rendering = false), 0);
    }
  };
  const paint = (enterDir) => {
    rows = computeRows();
    if (treeBody) lastScroll = treeBody.scrollTop;
    const hadFocus = treeEl && document.activeElement === treeEl;
    clear(root);
    const sections = [];
    if (showOpenEditors) sections.push(renderOpenEditors());
    if (folder()) {
      const fe = focused ? entryOf(focused) : null;
      const activeDir = fe ? (fe.is_dir && expanded.has(focused) ? focused : dirname(focused)) : null;
      const enterIndex = { n: 0 };
      treeEl = h(
        "div",
        {
          class: "ex-tree",
          tabindex: "0",
          role: "tree",
          onkeydown: onTreeKey,
          oncopy: onClipboardEvent("copy"),
          oncut: onClipboardEvent("cut"),
          onpaste: onClipboardEvent("paste"),
          oncontextmenu: (ev) => showMenu(ev, null),
          onclick: (ev) => {
            if (ev.target === treeEl && !swallowClick) {
              setFocus(null);
              render();
              treeEl.focus();
            }
          },
        },
        rows.map((r) => rowEl(r, activeDir, enterDir, enterIndex)),
      );
      treeBody = h("div", { class: "ex-body" }, treeEl);
      folderHeader = header(
        basename(folder()),
        folderCollapsed,
        () => {
          folderCollapsed = !folderCollapsed;
          render();
        },
        [
          iconButton("new-file", "New File…", () => startNew("file")),
          iconButton("new-folder", "New Folder…", () => startNew("folder")),
          iconButton("refresh", "Refresh Explorer", refresh),
          iconButton("collapse-all", "Collapse Folders in Explorer", collapseAll),
        ],
      );
      folderHeader.title = folder();
      folderHeader.addEventListener("contextmenu", (ev) => showMenu(ev, null));
      sections.push(h("div", { class: "ex-section grow" }, folderHeader, folderCollapsed ? null : treeBody));
    } else {
      treeEl = treeBody = null;
      sections.push(
        h(
          "div",
          { class: "ex-section grow" },
          header("No Folder Opened", false, () => {}, []),
          h(
            "div",
            { class: "ex-empty" },
            h("div", null, "You have not yet opened a folder."),
            h("button", { class: "btn block", onclick: () => openFolder() }, "Open Folder"),
            h("div", { class: "muted" }, "Files you open without a folder still work: AICode is a full editor on its own."),
          ),
        ),
      );
    }
    root.append(h("div", { class: "explorer" }, sections));
    if (treeBody) treeBody.scrollTop = lastScroll;
    if (hadFocus && !editing) treeEl?.focus({ preventScroll: true });
  };

  // ---------- wiring ----------

  ctx.views.provide("explorer", {
    actions: [
      { icon: "folder-opened", title: "Open Folder…", run: () => openFolder() },
      {
        icon: "ellipsis",
        title: "Views and More Actions…",
        run: (e) => {
          const r = e?.currentTarget?.getBoundingClientRect?.();
          const toggleOpen = () => {
            showOpenEditors = !showOpenEditors;
            ctx.settings.set("showOpenEditors", showOpenEditors);
            render();
          };
          const items = [
            { label: "Open Editors", checked: showOpenEditors, run: toggleOpen },
            { label: "Folders", checked: true, disabled: true },
          ];
          if (r) ctx.window.contextMenu(r.right - 180, r.bottom + 4, items);
          else toggleOpen();
        },
      },
    ],
    render: async (el) => {
      root = el;
      if (folder()) {
        await loadDir(folder());
        await restore();
      }
      render();
      if (await setting("autoReveal", true)) {
        const p = ctx.editor.active()?.path;
        if (p) revealPath(p);
      }
    },
    onShow: () => render(),
  });

  ctx.commands.register("explorer.openFolder", (path) => openFolder(path));
  ctx.commands.register("explorer.closeFolder", () => ctx.workspace.setFolder(null));
  ctx.commands.register("explorer.newFile", () => startNew("file"));
  ctx.commands.register("explorer.newFolder", () => startNew("folder"));
  ctx.commands.register("explorer.refresh", refresh);
  ctx.commands.register("explorer.collapseAll", collapseAll);
  ctx.commands.register("explorer.toggleOpenEditors", async () => {
    showOpenEditors = !showOpenEditors;
    await ctx.settings.set("showOpenEditors", showOpenEditors);
    render();
  });
  ctx.commands.register("explorer.revealActive", async () => {
    await ctx.views.reveal("explorer", false);
    await revealPath(ctx.editor.active()?.path, { focus: true });
  });
  ctx.commands.register("explorer.focus", async () => {
    await ctx.views.reveal("explorer", false);
    if (!focused && rows[0]?.entry) setFocus(rows[0].entry.path);
    render();
    treeEl?.focus();
  });
  ctx.commands.register("explorer.rename", () => startRename());
  ctx.commands.register("explorer.delete", () => remove());
  const copyActive = (relative) => {
    if (treeEl && document.activeElement === treeEl) return copyPaths(relative);
    const p = ctx.editor.active()?.path;
    if (p) ctx.window.copy(relative ? rel(p) : p);
  };
  ctx.commands.register("explorer.copyPath", () => copyActive(false));
  ctx.commands.register("explorer.copyRelativePath", () => copyActive(true));
  ctx.commands.register("explorer.revealInOS", () => {
    const p = ctx.editor.active()?.path ?? focused ?? folder();
    if (p) ctx.fs.reveal(p);
  });

  ctx.workspace.onDidChangeFolder(async (f) => {
    for (const d of watches.values()) d.dispose();
    watches.clear();
    expanded.clear();
    children.clear();
    selection = new Set();
    focused = anchor = null;
    editing = null;
    if (f) {
      await loadDir(f);
      await restore();
    }
    render(f);
  });
  ctx.editor.onDidChangeEditors(() => render());
  ctx.editor.onDidChangeActive(async (info) => {
    if (info?.path && folder() && isUnder(info.path, folder()) && (await setting("autoReveal", true))) {
      if (info.path === focused && selection.has(info.path)) return render();
      // Like VS Code: select it, but do not take the keyboard from the editor.
      await revealPath(info.path, { focus: false });
    } else render();
  });
  ctx.editor.onDidSave(async (info) => {
    const dir = info.path && dirname(info.path);
    if (dir && children.has(dir) && !children.get(dir).some((e) => e.path === info.path)) {
      await loadDir(dir);
      render();
    }
  });
  ctx.decorations.onDidChange(() => {
    clearTimeout(decoTimer);
    decoTimer = setTimeout(() => render(), 30);
  });
  let decoTimer = null;

  return { openFolder, reveal: (p) => revealPath(p) };
}
