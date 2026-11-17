// Terminal: xterm.js in the panel, a real PTY in Rust. Works like VS Code's: several terminals in a
// tab list, nested rows and columns, a shell picker, ⌘-click on file paths and URLs, the usual macOS
// keys (⌘K clears, ⌘← / ⌘→ / ⌘⌫ edit the line). Ships its own copy of xterm (vendor/), so the core
// stays free of it until this mod is used.

import { Terminal } from "./vendor/xterm.mjs";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { fileReferences, resizePair } from "./interaction.js";
import { insertPane, removePane, layoutTerms, arrangeLayout } from "./layout.js";

const isMac = navigator.platform.toLowerCase().includes("mac");

const STYLE = `
.term-root { position: absolute; inset: 0; display: flex; }
.term-stage { flex: 1 1 auto; min-width: 0; position: relative; }
.term-group { position: absolute; inset: 0; display: none; }
.term-group.active { display: flex; }
.term-split { position: relative; display: flex; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden; }
.term-split.column { flex-direction: column; }
.term-pane { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden; }
.term-pane::after { content: ""; position: absolute; inset: 0; z-index: 3; border: 1px solid transparent; pointer-events: none; }
.term-pane.focused::after { border-color: color-mix(in srgb, var(--aicode-focusBorder) 45%, transparent); }
.term-pane:focus-within::after { border-color: color-mix(in srgb, var(--aicode-focusBorder) 75%, transparent); }
.term-pane.file-drop-target::after { border: 2px dashed var(--aicode-focusBorder); background: color-mix(in srgb, var(--aicode-focusBorder) 8%, transparent); }
.term-pane .xterm-host { position: absolute; inset: 4px 2px 2px 16px; }
.term-sash { flex: 0 0 5px; position: relative; z-index: 4; cursor: col-resize; touch-action: none; outline: none; }
.term-sash::after { content: ""; position: absolute; inset: 0 2px; background: var(--aicode-terminal-border, var(--aicode-panel-border)); }
.term-sash:hover::after, .term-sash:focus-visible::after, .term-sash.dragging::after { inset: 0 1px; background: var(--aicode-focusBorder); }
.term-sash.column { cursor: row-resize; }
.term-sash.column::after { inset: 2px 0; }
.term-sash.column:hover::after, .term-sash.column:focus-visible::after, .term-sash.column.dragging::after { inset: 1px 0; }
.term-root.resizing, .term-root.resizing * { cursor: col-resize !important; user-select: none !important; }
.term-root.resizing[data-resize-axis="column"], .term-root.resizing[data-resize-axis="column"] * { cursor: row-resize !important; }
.term-root.moving-pane, .term-root.moving-pane * { user-select: none !important; }
.term-layout-preview { position: absolute; z-index: 8; pointer-events: none; border: 2px solid var(--aicode-focusBorder); background: color-mix(in srgb, var(--aicode-focusBorder) 15%, transparent); box-sizing: border-box; }
.term-drag-ghost { position: fixed; z-index: 500; pointer-events: none; padding: 5px 10px; border: 1px solid var(--aicode-focusBorder); border-radius: 4px; background: var(--aicode-editorWidget-background); color: var(--aicode-foreground); font-size: 12px; }
.term-group.split .term-pane .xterm-host { left: 10px; }
.term-group.split .term-pane:not(.focused) { opacity: .82; }
.term-tabs { flex: 0 0 auto; width: var(--term-tabs-w, 170px); border-left: 1px solid var(--aicode-panel-border); overflow-y: auto; padding-top: 2px; display: none; }
.term-root.many .term-tabs { display: block; }
.term-tab { height: 22px; display: flex; align-items: center; gap: 4px; padding: 0 6px 0 8px; cursor: pointer; white-space: nowrap; font-size: 13px; position: relative; }
.term-tab:hover { background: var(--aicode-list-hoverBackground); }
.term-tab.active { background: var(--aicode-list-inactiveSelectionBackground); }
.term-root:focus-within .term-tab.active { background: var(--aicode-list-activeSelectionBackground); }
.term-tab .branch { width: 10px; color: var(--aicode-descriptionForeground); font-family: var(--font-mono); font-size: 12px; text-align: center; flex: 0 0 auto; }
.term-tab .tname { overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; }
.term-tab .tname.exited { color: var(--aicode-descriptionForeground); font-style: italic; }
.term-tab .tactions { display: none; gap: 0; }
.term-tab:hover .tactions, .term-tab.active .tactions { display: flex; }
.term-tab .tactions .icon-button { width: 18px; height: 18px; }
body .term-tab .codicon { font-size: 14px; }
.term-tab input { flex: 1; min-width: 0; height: 18px; font: inherit; color: var(--aicode-input-foreground); background: var(--aicode-input-background); border: 1px solid var(--aicode-focusBorder); outline: none; padding: 0 3px; user-select: text; -webkit-user-select: text; }
.term-msg { position: absolute; left: 16px; right: 16px; bottom: 8px; font-size: 12px; color: var(--aicode-descriptionForeground); }
.xterm .xterm-viewport { scrollbar-width: thin; }
/* xterm.css paints the viewport black: the panel shows through instead. */
.term-root .xterm, .term-root .xterm-viewport, .term-root .xterm-screen, .term-root .xterm-scrollable-element { background-color: transparent !important; }
`;

export async function activate(ctx) {
  const { h, icon, iconButton, clear, basename } = ctx.ui;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = ctx.asset("vendor/xterm.css");
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(css, style);
  ctx.subscriptions.push({ dispose: () => { css.remove(); style.remove(); } });

  let shells = { default: null, shells: [] };
  ctx.pty.shells().then((s) => (shells = s)).catch(() => {});

  /** groups: [{ id, terms: [t], active: t }]; t: { id, name, title, term, fit, el, pane, pty, exited, cwd } */
  const groups = [];
  let activeGroup = null;
  let host, rootEl, stage, tabsEl;
  let counter = 0;
  let renaming = null;
  let stopResize = null;
  let stopPaneDrag = null;
  let swallowTabClick = false;

  const color = (key, fallback) => getComputedStyle(document.documentElement).getPropertyValue(`--aicode-${key.replace(/\./g, "-")}`).trim() || fallback;
  const theme = () => ({
    // Transparent: the terminal is part of the panel, not a box set into it. Whatever the panel
    // paints (its color, a gradient, the acrylic tint) shows through, so the two are one surface.
    background: "#00000000",
    // The glyph under the block cursor (and inverse text) needs a real color, not the transparent one.
    cursorAccent: color("panel.background", color("terminal.background", "#181818")),
    foreground: color("terminal.foreground", "#cccccc"),
    cursor: color("terminalCursor.foreground", "#cccccc"),
    selectionBackground: color("terminal.selectionBackground", "#264f78"),
    black: color("terminal.ansiBlack", "#000000"),
    red: color("terminal.ansiRed", "#cd3131"),
    green: color("terminal.ansiGreen", "#0dbc79"),
    yellow: color("terminal.ansiYellow", "#e5e510"),
    blue: color("terminal.ansiBlue", "#2472c8"),
    magenta: color("terminal.ansiMagenta", "#bc3fbc"),
    cyan: color("terminal.ansiCyan", "#11a8cd"),
    white: color("terminal.ansiWhite", "#e5e5e5"),
    brightBlack: color("terminal.ansiBrightBlack", "#666666"),
    brightRed: color("terminal.ansiBrightRed", "#f14c4c"),
    brightGreen: color("terminal.ansiBrightGreen", "#23d18b"),
    brightYellow: color("terminal.ansiBrightYellow", "#f5f543"),
    brightBlue: color("terminal.ansiBrightBlue", "#3b8eea"),
    brightMagenta: color("terminal.ansiBrightMagenta", "#d670d6"),
    brightCyan: color("terminal.ansiBrightCyan", "#29b8db"),
    brightWhite: color("terminal.ansiBrightWhite", "#e5e5e5"),
  });

  const allTerms = () => groups.flatMap((g) => g.terms);
  const active = () => activeGroup?.active ?? null;
  const label = (t) => t.customName ?? t.title ?? t.name;

  const fitAll = () => {
    for (const t of activeGroup?.terms ?? []) {
      try { t.fit.fit(); } catch {}
    }
  };

  const applyRatio = (node, first, second) => {
    first.style.flexGrow = String(node.ratio * 100);
    second.style.flexGrow = String((1 - node.ratio) * 100);
  };

  const resizeSash = (e, node, first, second, sash) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stopResize?.();
    const vertical = node.axis === "column";
    const x = vertical ? e.clientY : e.clientX;
    const dimension = vertical ? "height" : "width";
    const lw = first.getBoundingClientRect()[dimension];
    const rw = second.getBoundingClientRect()[dimension];
    const weights = [node.ratio, 1 - node.ratio];
    if (!lw || !rw) return;
    const move = (event) => {
      const [a, b] = resizePair(...weights, lw, rw, (vertical ? event.clientY : event.clientX) - x, vertical ? 60 : 80);
      node.ratio = a / (a + b);
      applyRatio(node, first, second);
      fitAll();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      sash.classList.remove("dragging");
      rootEl.classList.remove("resizing");
      delete rootEl.dataset.resizeAxis;
      stopResize = null;
      fitAll();
    };
    stopResize = end;
    sash.classList.add("dragging");
    rootEl.classList.add("resizing");
    rootEl.dataset.resizeAxis = node.axis;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
  };

  const layoutGroup = (g) => {
    stopResize?.();
    g.terms = layoutTerms(g.layout);
    g.el.classList.toggle("split", g.terms.length > 1);
    const draw = (node) => {
      if (node.term) return node.term.pane;
      const first = draw(node.first);
      const second = draw(node.second);
      const vertical = node.axis === "column";
      const reset = () => {
        node.ratio = 0.5;
        applyRatio(node, first, second);
        fitAll();
      };
      const sash = h("div", {
        class: `term-sash ${node.axis}`, role: "separator", tabindex: "0", "aria-orientation": vertical ? "horizontal" : "vertical",
        "aria-label": "Resize terminal panes", title: "Drag to resize · Double-click to equalize this split",
        onpointerdown: (e) => resizeSash(e, node, first, second, sash),
        ondblclick: reset,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === "Home") { e.preventDefault(); reset(); return; }
          const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
          if (!keys.includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const dimension = vertical ? "height" : "width";
          const [a, b] = resizePair(node.ratio, 1 - node.ratio, first.getBoundingClientRect()[dimension], second.getBoundingClientRect()[dimension], (e.key === keys[0] ? -1 : 1) * (e.shiftKey ? 40 : 10), vertical ? 60 : 80);
          node.ratio = a / (a + b);
          applyRatio(node, first, second);
          fitAll();
        },
      });
      applyRatio(node, first, second);
      return h("div", { class: `term-split ${node.axis}` }, first, sash, second);
    };
    clear(g.el);
    if (g.layout) {
      const tree = draw(g.layout);
      tree.style.flexGrow = "1";
      g.el.append(tree);
    }
    requestAnimationFrame(fitAll);
  };

  // ---------- links: ⌘-click (Ctrl-click) on URLs and file paths ----------

  const URL_RE = /\bhttps?:\/\/[^\s"'<>()\[\]{}]+[^\s"'<>()\[\]{}.,;:!?]/g;
  // Paths with `/` or `\` (Windows tools print `src\a.ts(10,5)` and `C:\x\a.ts:3`).
  const PATH_RE = /(?:^|[\s('"`=:])((?:[A-Za-z]:[\\/]|~|\.{1,2})?[\\/]?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,12})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))?/g;
  const resolvePath = (t, p) => {
    p = p.replace(/\\/g, "/");
    if (p.startsWith("~/")) return null;
    const absolute = ctx.ui.isAbsolute(p);
    const base = absolute ? "" : t.cwd ?? ctx.workspace.folder();
    if (!absolute && !base) return null;
    const full = absolute ? p : `${base}/${p}`;
    const root = ctx.ui.pathRoot(full) || "/";
    const out = [];
    for (const part of full.slice(root.length).split("/")) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    return root + out.join("/");
  };
  const followKey = (e) => (isMac ? e.metaKey : e.ctrlKey);
  const linkProvider = (t) => ({
    provideLinks: (y, callback) => {
      const line = t.term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links = [];
      const range = (start, len) => ({ start: { x: start + 1, y }, end: { x: start + len, y } });
      for (const m of text.matchAll(URL_RE)) {
        links.push({ range: range(m.index, m[0].length), text: m[0], decorations: { underline: true, pointerCursor: true }, activate: (e, url) => followKey(e) && ctx.external.open(url) });
      }
      const candidates = [];
      for (const m of text.matchAll(PATH_RE)) {
        const start = m.index + m[0].indexOf(m[1]);
        if (links.some((l) => start + 1 >= l.range.start.x && start + 1 <= l.range.end.x)) continue;
        const full = m[0].slice(m[0].indexOf(m[1]));
        candidates.push({ start, full, path: resolvePath(t, m[1]), line: Number(m[2] ?? m[4]) || undefined, column: Number(m[3] ?? m[5]) || undefined });
      }
      if (!candidates.length || !ctx.fs?.stat) return callback(links.length ? links : undefined);
      Promise.all(candidates.map((c) => (c.path ? ctx.fs.stat(c.path).then((s) => (s.exists ? { ...c, isDir: s.is_dir } : null)).catch(() => null) : null))).then((found) => {
        for (const c of found.filter(Boolean)) {
          links.push({
            range: range(c.start, c.full.length),
            text: c.full,
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => {
              if (!followKey(e)) return;
              if (c.isDir) ctx.commands.exists("explorer.revealActive") && ctx.mods.get("aicode.explorer").then((x) => x?.reveal?.(c.path));
              else ctx.editor.open(c.path, { line: c.line, column: c.column });
            },
          });
        }
        callback(links.length ? links : undefined);
      });
    },
  });

  // ---------- terminals ----------

  const newTerm = async (opts, group) => {
    const pane = h("div", { class: "term-pane" });
    const el = h("div", { class: "xterm-host" });
    pane.append(el);
    const term = new Terminal({
      fontFamily: "Menlo, 'SF Mono', Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: (await ctx.settings.get("fontSize", 12)) || 12,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      // Let the keyboard layout produce @, |, brackets and accents with Option.
      // Option+arrows are handled below for shell word navigation.
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      allowTransparency: true,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const shellName = opts.command ? basename(opts.command) : basename(shells.default ?? "zsh");
    const isShell = (c) => /(?:^|[\\/])(?:zsh|bash|fish|sh|ksh|tcsh|nu|pwsh|powershell|cmd)(?:\.exe)?$/.test(c ?? "");
    const t = { id: ++counter, shellCommand: opts.shellCommand ?? (isShell(opts.command) ? opts.command : undefined), name: opts.name ?? shellName, icon: opts.icon ?? "terminal", title: null, term, fit, el, pane, pty: null, exited: false, cwd: opts.cwd ?? ctx.workspace.folder() ?? null, group };
    pane.addEventListener("mousedown", () => focusTerm(t), true);
    pane.addEventListener("focusin", () => selectTerm(t));
    pane.addEventListener("contextmenu", (e) => termMenu(e, t));
    t.fileDrop = ctx.workbench.addFileDropTarget(pane, {
      label: "Drop to paste file references into terminal",
      drop: (paths) => {
        if (!t.pty || t.exited) {
          ctx.window.showInfo("This terminal is not running. Open a terminal or agent before dropping files.");
          return;
        }
        const text = fileReferences(paths, t.shellCommand ?? shells.default ?? "");
        focusTerm(t);
        t.term.paste(text);
      },
    });
    term.open(el);
    term.registerLinkProvider(linkProvider(t));
    term.onTitleChange((title) => {
      // Shells often report "user@host:~/dir"; keep it short, as the tab list does in VS Code.
      const clean = title.replace(/^[^@\s]+@[^:\s]+:\s*/, "").trim();
      t.title = clean || null;
      paintTabs();
    });
    // macOS line editing the way VS Code sends it; ⌘K clears.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = isMac ? e.metaKey : e.ctrlKey && e.shiftKey;
      if (isMac && e.metaKey && !e.altKey && !e.ctrlKey) {
        const seq = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" }[e.key];
        if (seq) {
          t.pty?.write(seq);
          e.preventDefault();
          return false;
        }
        if (e.key.toLowerCase() === "k" && !e.shiftKey) {
          clearTerm(t);
          e.preventDefault();
          return false;
        }
        if (e.key === "\\" && !e.shiftKey) {
          split();
          e.preventDefault();
          return false;
        }
      }
      if (!isMac && e.ctrlKey && e.shiftKey && e.code === "Digit5") {
        split();
        e.preventDefault();
        return false;
      }
      if (isMac && e.altKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        t.pty?.write(e.key === "ArrowLeft" ? "\x1bb" : "\x1bf");
        e.preventDefault();
        return false;
      }
      // Copy with a selection; otherwise ⌘C / Ctrl+Shift+C does nothing (Ctrl+C still interrupts).
      if (mod && e.key.toLowerCase() === "c" && term.hasSelection()) {
        ctx.window.copy(term.getSelection());
        e.preventDefault();
        return false;
      }
      // Keys the workbench owns (⌘P, ⌘B, ⌘J, ⌃`…) go to it, not to the shell.
      if ((isMac ? e.metaKey : e.ctrlKey && e.shiftKey) && !["c", "v", "a"].includes(e.key.toLowerCase())) return false;
      if (e.ctrlKey && e.key === "`") return false;
      return true;
    });
    return t;
  };

  const startPty = async (t, opts) => {
    try { t.fit.fit(); } catch {}
    try {
      t.pty = await ctx.pty.spawn({
        cwd: t.cwd ?? undefined,
        command: opts.command,
        args: opts.args ?? (opts.command && /(?:^|\/)(?:zsh|bash|fish|sh|ksh|tcsh|nu)$/.test(opts.command) ? ["-l"] : undefined),
        cols: t.term.cols,
        rows: t.term.rows,
        onData: (data) => t.term.write(data),
        onExit: (code) => {
          t.exited = true;
          // A shell that ended cleanly (exit, ⌃D) closes its terminal, as in VS Code; otherwise
          // the output stays to be read, and any key closes it.
          if ((code === 0 || code == null) && !opts.keepOpen && !opts.command) return kill(t, { quiet: true });
          t.term.write(`\r\n\x1b[2m${code ? `The terminal process exited with code ${code}.` : "The process exited."} Press any key to close the terminal.\x1b[0m\r\n`);
          const sub = t.term.onKey(() => {
            sub.dispose();
            kill(t, { quiet: true });
          });
          paintTabs();
        },
      });
    } catch (e) {
      t.term.write(`\x1b[31m${e}\x1b[0m\r\n`);
      t.exited = true;
    }
    t.term.onData((data) => t.pty && !t.exited && t.pty.write(data));
    t.term.onResize(({ cols, rows }) => t.pty && !t.exited && t.pty.resize(cols, rows));
    if (opts.input) setTimeout(() => t.pty?.write(opts.input), 300);
  };

  const ensureView = async () => {
    if (!ctx.views.isVisible("terminal")) await ctx.views.reveal("terminal", false);
    for (let i = 0; i < 50 && !stage; i++) await new Promise((r) => setTimeout(r, 20));
  };

  let creating = false;
  /** A new terminal in a group of its own (a new tab). */
  const create = async (opts = {}) => {
    creating = true;
    await ensureView();
    const g = { id: ++counter, terms: [], layout: null, active: null, el: h("div", { class: "term-group" }) };
    stage.append(g.el);
    groups.push(g);
    const t = await newTerm(opts, g);
    g.layout = insertPane(null, null, t);
    layoutGroup(g);
    g.active = t;
    showGroup(g);
    await startPty(t, opts);
    focusTerm(t);
    creating = false;
    return t;
  };

  /** Split a pane, or the whole group, in any direction without restarting existing sessions. */
  const split = async (opts = {}) => {
    await ensureView();
    const g = activeGroup;
    if (!g) return create(opts);
    const from = g.active;
    const options = { cwd: from?.cwd ?? undefined, command: from?.shellCommand, ...opts };
    const t = await newTerm(options, g);
    g.layout = insertPane(g.layout, opts.scope === "group" ? null : from, t, opts.direction ?? "right");
    layoutGroup(g);
    g.active = t;
    requestAnimationFrame(fitAll);
    await startPty(t, options);
    focusTerm(t);
    paintTabs();
    return t;
  };

  const showGroup = (g) => {
    activeGroup = g;
    for (const x of groups) x.el.classList.toggle("active", x === g);
    requestAnimationFrame(() => {
      if (activeGroup !== g || !groups.includes(g)) return;
      fitAll();
      focusTerm(g.active);
    });
    paintTabs();
  };

  const selectTerm = (t) => {
    if (!t) return;
    if (activeGroup !== t.group) showGroup(t.group);
    const changed = t.group.active !== t || !t.pane.classList.contains("focused");
    t.group.active = t;
    for (const x of t.group.terms) x.pane.classList.toggle("focused", x === t);
    if (changed) paintTabs();
  };

  const focusTerm = (t) => {
    if (!t) return;
    selectTerm(t);
    t.term.focus();
  };

  const kill = (t = active(), { quiet = false } = {}) => {
    if (!t) return;
    if (!t.exited) t.pty?.kill();
    t.exited = true;
    t.fileDrop.dispose();
    t.term.dispose();
    t.pane.remove();
    const g = t.group;
    g.layout = removePane(g.layout, t);
    layoutGroup(g);
    if (!g.terms.length) {
      g.el.remove();
      const gi = groups.indexOf(g);
      groups.splice(gi, 1);
      if (activeGroup === g) activeGroup = groups[Math.min(gi, groups.length - 1)] ?? null;
    } else if (g.active === t) g.active = g.terms[0];
    if (activeGroup) showGroup(activeGroup);
    paintTabs();
    // The last terminal closed: the panel closes too (unless the user is opening another).
    if (!groups.length && !creating && ctx.views.isVisible("terminal")) {
      ctx.commands.execute("workbench.togglePanel").catch(() => {});
      if (!quiet) ctx.editor.monacoEditor()?.focus();
    }
  };

  const killGroup = (g = activeGroup) => g && [...g.terms].forEach((t) => kill(t));

  const clearTerm = (t = active()) => {
    if (!t) return;
    t.term.clear();
  };

  const moveTerm = (t, destination, target, direction) => {
    if (!t || target === t || !groups.includes(destination)) return;
    const source = t.group;
    if (!source.terms.includes(t) || (target && !destination.terms.includes(target))) return;
    if (source === destination && source.terms.length === 1) return;
    source.layout = removePane(source.layout, t);
    destination.layout = insertPane(destination.layout, target, t, direction);
    t.group = destination;
    if (source !== destination) {
      layoutGroup(source);
      if (source.active === t) source.active = source.terms[0] ?? null;
      if (!source.terms.length) {
        source.el.remove();
        groups.splice(groups.indexOf(source), 1);
      }
    }
    layoutGroup(destination);
    destination.active = t;
    showGroup(destination);
    focusTerm(t);
  };

  const movePane = async (t = active()) => {
    if (!t) return;
    const choice = await ctx.window.showQuickPick([
      { label: "Below Entire Group", direction: "below", scope: "group" },
      { label: "Above Entire Group", direction: "above", scope: "group" },
      { label: "Left of Entire Group", direction: "left", scope: "group" },
      { label: "Right of Entire Group", direction: "right", scope: "group" },
      { label: "Below Another Pane…", direction: "below" },
      { label: "Above Another Pane…", direction: "above" },
      { label: "Left of Another Pane…", direction: "left" },
      { label: "Right of Another Pane…", direction: "right" },
    ], { placeholder: `Move ${label(t)} without restarting it` });
    if (!choice) return;
    if (choice.scope === "group") return moveTerm(t, t.group, null, choice.direction);
    const target = await ctx.window.showQuickPick(allTerms().filter((other) => other !== t).map((other) => ({ label: label(other), description: other.cwd ?? "", term: other })), { placeholder: "Choose the destination pane" });
    if (target) moveTerm(t, target.term.group, target.term, choice.direction);
  };

  const arrangePanes = async () => {
    const g = activeGroup;
    if (!g || g.terms.length < 2) return ctx.window.showInfo("Split a terminal first to arrange its panes.");
    const count = g.terms.length - 1;
    const choice = await ctx.window.showQuickPick([
      { label: "Equal Columns", preset: "columns" },
      { label: "Equal Rows", preset: "rows" },
      { label: "Grid", preset: "grid" },
      { label: `${count} Above + 1 Wide Below`, preset: "bottom" },
      { label: `${count} on the Left + 1 Tall on the Right`, preset: "right" },
    ], { placeholder: "Arrange the existing terminals without restarting them" });
    if (!choice || !groups.includes(g)) return;
    g.layout = arrangeLayout(g.terms, choice.preset);
    layoutGroup(g);
    showGroup(g);
  };

  /** Drag a terminal from the tab list onto a pane edge, or an outer edge of the whole group. */
  const startPaneDrag = (down, t) => {
    if (down.button !== 0 || renaming || down.target.closest(".tactions, input")) return;
    stopPaneDrag?.();
    const start = { x: down.clientX, y: down.clientY };
    let ghost, preview, destination;
    const findDestination = (e) => {
      const g = activeGroup;
      if (!g) return null;
      const r = g.el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
      const edges = [
        ["left", e.clientX - r.left], ["right", r.right - e.clientX],
        ["above", e.clientY - r.top], ["below", r.bottom - e.clientY],
      ].sort((a, b) => a[1] - b[1]);
      if (edges[0][1] < 22) return { group: g, target: null, direction: edges[0][0], rect: r };
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(".term-pane");
      const target = g.terms.find((other) => other.pane === under);
      if (!target || target === t) return null;
      const pane = target.pane.getBoundingClientRect();
      const x = (e.clientX - pane.left) / pane.width;
      const y = (e.clientY - pane.top) / pane.height;
      const direction = [["left", x], ["right", 1 - x], ["above", y], ["below", 1 - y]].sort((a, b) => a[1] - b[1])[0][0];
      return { group: g, target, direction, rect: pane };
    };
    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
        ghost = h("div", { class: "term-drag-ghost" }, label(t));
        preview = h("div", { class: "term-layout-preview" });
        document.body.append(ghost);
        stage.append(preview);
        rootEl.classList.add("moving-pane");
      }
      e.preventDefault();
      ghost.style.left = `${e.clientX + 12}px`;
      ghost.style.top = `${e.clientY + 12}px`;
      destination = findDestination(e);
      preview.style.display = destination ? "block" : "none";
      if (!destination) return;
      const { rect: r, direction } = destination;
      const stageRect = stage.getBoundingClientRect();
      const row = direction === "left" || direction === "right";
      Object.assign(preview.style, {
        left: `${r.left - stageRect.left + (direction === "right" ? r.width / 2 : 0)}px`,
        top: `${r.top - stageRect.top + (direction === "below" ? r.height / 2 : 0)}px`,
        width: `${row ? r.width / 2 : r.width}px`, height: `${row ? r.height : r.height / 2}px`,
      });
    };
    const end = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", end);
      stopPaneDrag = null;
      if (!ghost) return;
      // Recheck the release position so a last movement outside the group cancels the move.
      const drop = e?.type === "pointerup" ? findDestination(e) : null;
      ghost.remove();
      preview.remove();
      rootEl.classList.remove("moving-pane");
      swallowTabClick = true;
      setTimeout(() => { swallowTabClick = false; }, 0);
      if (drop) moveTerm(t, drop.group, drop.target, drop.direction);
    };
    const escape = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      end();
    };
    stopPaneDrag = () => end();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", end);
  };

  const splitMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    ctx.window.contextMenu(r.left, r.bottom + 2, [
      { label: "Split Right", run: () => split() },
      { label: "Split Down", run: () => split({ direction: "below" }) },
      { label: "Split Left", run: () => split({ direction: "left" }) },
      { label: "Split Up", run: () => split({ direction: "above" }) },
      { separator: true, label: "" },
      { label: "New Terminal Below Entire Group", run: () => split({ direction: "below", scope: "group" }) },
      { label: "New Terminal Above Entire Group", run: () => split({ direction: "above", scope: "group" }) },
      { label: "Move Active Pane…", run: () => movePane() },
      { label: "Arrange Panes…", run: () => arrangePanes() },
    ]);
  };

  // ---------- menus and the tab list ----------

  const pickShell = async () => {
    const list = shells.shells.length ? shells.shells : [shells.default ?? "/bin/zsh"];
    const choice = await ctx.window.showQuickPick(
      list.map((p) => ({ label: basename(p), description: p + (p === shells.default ? " (default)" : ""), path: p })),
      { placeholder: "Select the terminal profile to create" },
    );
    if (choice) create({ command: choice.path, shellCommand: choice.path });
  };

  const addAgentProfile = async () => {
    const name = await ctx.window.showInputBox({ prompt: "Agent name", placeholder: "My agent" });
    if (!name?.trim()) return;
    const command = await ctx.window.showInputBox({ prompt: "Agent executable (name on PATH or full path)", placeholder: "aider" });
    if (!command?.trim()) return;
    const profiles = await ctx.settings.get("agentProfiles", []);
    await ctx.settings.set("agentProfiles", [...profiles, { name: name.trim(), command: command.trim(), args: [] }]);
    ctx.window.showInfo(`${name.trim()} added to the terminal agent picker. Optional launch arguments are in Terminal settings.`);
  };

  /** Reuse the agent mods' CLI setup; no second set of credentials or providers. */
  const pickAgent = async (inSplit = false, placement = {}) => {
    const owners = [...new Set(ctx.mods.contributions("chatAgents").filter((c) => ctx.mods.isEnabled(c.mod)).map((c) => c.mod))];
    const items = [];
    for (const owner of owners) {
      try {
        const exported = await ctx.mods.get(owner);
        for (const agent of Object.values(exported?.chatAgents ?? {})) {
          if (!agent?.terminal) continue;
          const status = await agent.status(true);
          if (!status.terminal && !status.modes?.includes("cli")) continue;
          items.push({ label: agent.name, description: status.detail, agent, status, icon: agent.icon ?? "robot" });
        }
      } catch (error) {
        console.warn(`Terminal: could not load ${owner}`, error);
      }
    }
    for (const profile of await ctx.settings.get("agentProfiles", [])) {
      if (!profile?.name || typeof profile.command !== "string" || !profile.command.trim()) continue;
      items.push({ label: profile.name, description: profile.command, profile });
    }
    const choice = await ctx.window.showQuickPick([
      ...items,
      { label: "Add Agent Profile…", description: "Run another agent CLI", add: true },
      { label: "Manage Agent Mods…", description: "Enable or install agent integrations", manage: true },
    ], { placeholder: inSplit ? "Open an agent in a split terminal" : "Open an agent in a new terminal" });
    if (!choice) return;
    if (choice.add) return addAgentProfile();
    if (choice.manage) return ctx.commands.execute("mods.manage");
    let line;
    if (choice.profile) {
      const { command, args } = choice.profile;
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
        return ctx.window.showInfo("This agent profile's args must be a list of strings. Update it in Terminal settings.");
      }
      line = { command, args: args ?? [] };
    } else {
      const agent = choice.agent;
      let status = choice.status;
      if (!status.terminal || !status.ready) {
        await agent.configure?.();
        status = await agent.status(true);
      }
      if (!status.terminal || !status.ready) return ctx.window.showInfo(status.detail || `Configure ${agent.name}'s CLI before opening it in a terminal.`);
      line = await agent.terminal(status.defaultModel ?? "");
    }
    if (!line?.command) return;
    const opts = { ...line, name: choice.label, icon: choice.icon ?? "robot", keepOpen: true, cwd: (inSplit ? active()?.cwd : null) ?? ctx.workspace.folder() ?? undefined };
    return inSplit ? split({ ...opts, ...placement }) : create(opts);
  };

  const newMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const list = shells.shells.length ? shells.shells : [];
    ctx.window.contextMenu(r.left, r.bottom + 2, [
      ...list.map((p) => ({ label: basename(p) + (p === shells.default ? " (default)" : ""), run: () => create({ command: p }) })),
      { separator: true, label: "" },
      { label: "Split Terminal", keybinding: isMac ? "mod+\\" : "ctrl+shift+5", run: () => split() },
      { label: "Split Down", run: () => split({ direction: "below" }) },
      { label: "New Terminal Below Entire Group", run: () => split({ direction: "below", scope: "group" }) },
      { separator: true, label: "" },
      { label: "Open Agent…", run: () => pickAgent() },
      { label: "Open Agent in Split…", run: () => pickAgent(true) },
      { label: "Open Agent Below Entire Group…", run: () => pickAgent(true, { direction: "below", scope: "group" }) },
    ]);
  };

  const termMenu = (e, t) => {
    e.preventDefault();
    e.stopPropagation();
    focusTerm(t);
    const sel = t.term.hasSelection();
    ctx.window.contextMenu(e.clientX, e.clientY, [
      { label: "Copy", keybinding: "mod+c", disabled: !sel, run: () => ctx.window.copy(t.term.getSelection()) },
      { label: "Paste", keybinding: "mod+v", run: () => pasteInto(t) },
      { label: "Select All", keybinding: "mod+a", run: () => t.term.selectAll() },
      { separator: true, label: "" },
      { label: "Clear Terminal", keybinding: isMac ? "mod+k" : undefined, run: () => clearTerm(t) },
      { separator: true, label: "" },
      { label: "Split Terminal", keybinding: isMac ? "mod+\\" : "ctrl+shift+5", run: () => split() },
      { label: "Split Down", run: () => split({ direction: "below" }) },
      { label: "Split Up", run: () => split({ direction: "above" }) },
      { label: "Split Left", run: () => split({ direction: "left" }) },
      { label: "New Terminal Below Entire Group", run: () => split({ direction: "below", scope: "group" }) },
      { label: "Move Pane…", run: () => movePane(t) },
      { label: "New Terminal", keybinding: "ctrl+shift+`", run: () => create() },
      { label: "Open Agent in Split…", run: () => pickAgent(true) },
      { separator: true, label: "" },
      { label: "Kill Terminal", run: () => kill(t) },
    ], { menu: "terminal/context", context: { id: t.id, selection: sel ? t.term.getSelection() : "" } });
  };

  const pasteInto = async (t) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) t.term.paste(text);
    } catch {
      ctx.window.showInfo(`Use ${isMac ? "⌘V" : "Ctrl+Shift+V"} to paste into the terminal.`);
    }
  };

  const startRename = (t) => {
    renaming = t;
    paintTabs();
  };

  const tabMenu = (e, t) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.window.contextMenu(e.clientX, e.clientY, [
      { label: "Rename…", run: () => startRename(t) },
      { label: "Split Terminal", run: () => { focusTerm(t); split(); } },
      { label: "Split Down", run: () => { focusTerm(t); split({ direction: "below" }); } },
      { label: "Move Pane…", run: () => movePane(t) },
      { label: "Move Below Entire Group", disabled: t.group.terms.length < 2, run: () => moveTerm(t, t.group, null, "below") },
      { separator: true, label: "" },
      { label: "Clear Terminal", run: () => clearTerm(t) },
      { label: "Kill Terminal", run: () => kill(t) },
    ]);
  };

  const paintTabs = () => {
    if (!tabsEl) return;
    clear(tabsEl);
    rootEl.classList.toggle("many", allTerms().length > 1);
    for (const g of groups) {
      g.terms.forEach((t, i) => {
        const branch = g.terms.length > 1 ? (i === 0 ? "┌" : i === g.terms.length - 1 ? "└" : "├") : "";
        let nameEl;
        if (renaming === t) {
          nameEl = h("input", {
            value: label(t),
            onkeydown: (e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                t.customName = e.target.value.trim() || null;
                renaming = null;
                paintTabs();
                t.term.focus();
              } else if (e.key === "Escape") {
                renaming = null;
                paintTabs();
                t.term.focus();
              }
            },
            onblur: (e) => {
              if (renaming !== t) return;
              t.customName = e.target.value.trim() || null;
              renaming = null;
              paintTabs();
            },
          });
          requestAnimationFrame(() => {
            nameEl.focus();
            nameEl.select();
          });
        } else nameEl = h("span", { class: `tname${t.exited ? " exited" : ""}` }, label(t));
        tabsEl.append(
          h(
            "div",
            {
              class: `term-tab${t === active() ? " active" : ""}`,
              title: `${label(t)}${t.cwd ? `\n${t.cwd}` : ""}\nDrag onto a pane or group edge to rearrange`,
              onpointerdown: (e) => startPaneDrag(e, t),
              onclick: () => { if (!swallowTabClick) focusTerm(t); },
              ondblclick: () => startRename(t),
              oncontextmenu: (e) => tabMenu(e, t),
            },
            h("span", { class: "branch" }, branch),
            icon(t.icon),
            nameEl,
            h(
              "span",
              { class: "tactions", onclick: (e) => e.stopPropagation() },
              iconButton("split-horizontal", "Split Terminal", () => { focusTerm(t); split(); }),
              iconButton("trash", "Kill Terminal", () => kill(t)),
            ),
          ),
        );
      });
    }
    ctx.views.refreshActions?.();
  };

  ctx.views.provide("terminal", {
    actions: [
      { icon: "add", title: "New Terminal (⌃⇧`)", run: () => create(), dropdownTitle: "Launch Profile…", dropdown: (e) => newMenu(e) },
      { icon: "split-horizontal", title: `Split Right (${isMac ? "⌘\\" : "Ctrl+Shift+5"})`, run: () => split(), dropdownTitle: "Split Direction and Layout…", dropdown: splitMenu },
      { icon: "robot", title: "Open Agent…", run: () => pickAgent() },
      { icon: "trash", title: "Kill Terminal", run: () => kill() },
      {
        icon: "ellipsis",
        title: "Views and More Actions…",
        run: (e) => {
          const r = e?.currentTarget?.getBoundingClientRect?.() ?? { left: 200, bottom: 60 };
          ctx.window.contextMenu(r.left - 160, r.bottom + 4, [
            { label: "Clear Terminal", run: () => clearTerm() },
            { label: "Rename…", disabled: !active(), run: () => active() && startRename(active()) },
            { label: "Arrange Panes…", disabled: (activeGroup?.terms.length ?? 0) < 2, run: () => arrangePanes() },
            { separator: true, label: "" },
            { label: "Kill All Terminals", disabled: !groups.length, run: () => [...groups].forEach(killGroup) },
          ]);
        },
      },
    ],
    render: (el) => {
      host = el;
      stage = h("div", { class: "term-stage" });
      tabsEl = h("div", { class: "term-tabs", role: "list" });
      rootEl = h("div", { class: "term-root", dataset: { ownKeys: isMac ? "mod+k mod+\\ mod+backspace mod+left mod+right" : "ctrl+shift+5" } }, stage, tabsEl);
      host.append(rootEl);
      const observer = new ResizeObserver(() => fitAll());
      observer.observe(stage);
      ctx.subscriptions.push({ dispose: () => observer.disconnect() });
      if (!groups.length && !creating) create();
    },
    onShow: () => {
      if (activeGroup) showGroup(activeGroup);
      else if (stage && !creating) create();
    },
  });

  const toggle = async () => {
    if (ctx.views.isVisible("terminal") && host?.contains(document.activeElement)) {
      await ctx.commands.execute("workbench.togglePanel");
      ctx.editor.monacoEditor().focus();
    } else {
      await ctx.views.reveal("terminal");
      if (!groups.length && !creating) await create();
      active()?.term.focus();
    }
  };

  ctx.commands.register("terminal.new", (opts) => create(opts && typeof opts === "object" ? opts : {}));
  ctx.commands.register("terminal.newWithProfile", pickShell);
  ctx.commands.register("terminal.newAgent", () => pickAgent());
  ctx.commands.register("terminal.splitAgent", () => pickAgent(true));
  ctx.commands.register("terminal.addAgentProfile", addAgentProfile);
  ctx.commands.register("terminal.split", () => split());
  ctx.commands.register("terminal.splitDown", () => split({ direction: "below" }));
  ctx.commands.register("terminal.splitUp", () => split({ direction: "above" }));
  ctx.commands.register("terminal.splitLeft", () => split({ direction: "left" }));
  ctx.commands.register("terminal.splitGroupDown", () => split({ direction: "below", scope: "group" }));
  ctx.commands.register("terminal.movePane", () => movePane());
  ctx.commands.register("terminal.arrange", arrangePanes);
  ctx.commands.register("terminal.toggle", toggle);
  ctx.commands.register("terminal.focus", async () => {
    await ctx.views.reveal("terminal");
    active()?.term.focus();
  });
  ctx.commands.register("terminal.kill", () => kill());
  ctx.commands.register("terminal.killAll", () => [...groups].forEach(killGroup));
  ctx.commands.register("terminal.clear", () => clearTerm());
  ctx.commands.register("terminal.rename", () => active() && startRename(active()));
  ctx.commands.register("terminal.focusNext", () => {
    const list = allTerms();
    focusTerm(list[(list.indexOf(active()) + 1) % list.length]);
  });
  ctx.commands.register("terminal.focusPrevious", () => {
    const list = allTerms();
    focusTerm(list[(list.indexOf(active()) - 1 + list.length) % list.length]);
  });
  /** Types text into the active terminal (a new one if there is none) and runs it. */
  const sendText = async (text, { run = true } = {}) => {
    if (typeof text !== "string" || !text) return;
    const t = active() && !active().exited ? active() : await create();
    await ctx.views.reveal("terminal", false);
    const body = text.replace(/\r?\n$/, "");
    // Several lines go in as a paste, so the shell does not run them one keystroke at a time.
    if (body.includes("\n")) t.term.paste(body);
    else t.pty?.write(body);
    if (run) t.pty?.write("\r");
    t.term.focus();
  };
  ctx.commands.register("terminal.sendText", (text, opts) => sendText(text, opts));
  ctx.commands.register("terminal.runSelection", async () => {
    const sel = ctx.editor.getSelection();
    const text = sel?.text || (sel ? ctx.editor.getText()?.split("\n")[sel.startLine - 1] : "");
    if (!text) return;
    const t = active() && !active().exited ? active() : await create();
    await ctx.views.reveal("terminal", false);
    t.pty?.write(text.endsWith("\n") ? text : text + "\r");
  });

  // Repaint terminals when the theme changes.
  const themeObserver = new MutationObserver(() => allTerms().forEach((t) => (t.term.options.theme = theme())));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  ctx.subscriptions.push({ dispose: () => {
    stopResize?.();
    stopPaneDrag?.();
    themeObserver.disconnect();
    for (const t of allTerms()) { t.fileDrop.dispose(); t.pty?.kill(); t.term.dispose(); }
  } });

  /** For other mods: open a terminal running a command (an agent CLI, a script). */
  return { open: (opts) => create({ keepOpen: true, ...opts }), split: (opts) => split(opts), sendText };
}
