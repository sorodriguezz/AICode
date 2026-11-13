// Terminal: xterm.js in the panel, a real PTY in Rust. Works like VS Code's: several terminals in a
// tab list, split side by side, a shell picker, ⌘-click on file paths and URLs, the usual macOS
// keys (⌘K clears, ⌘← / ⌘→ / ⌘⌫ edit the line). Ships its own copy of xterm (vendor/), so the core
// stays free of it until this mod is used.

import { Terminal } from "./vendor/xterm.mjs";
import { FitAddon } from "./vendor/addon-fit.mjs";

const isMac = navigator.platform.toLowerCase().includes("mac");

const STYLE = `
.term-root { position: absolute; inset: 0; display: flex; }
.term-stage { flex: 1 1 auto; min-width: 0; position: relative; }
.term-group { position: absolute; inset: 0; display: none; }
.term-group.active { display: flex; }
.term-pane { position: relative; flex: 1 1 0; min-width: 60px; }
.term-pane + .term-pane { border-left: 1px solid var(--aicode-terminal-border, var(--aicode-panel-border)); }
.term-pane .xterm-host { position: absolute; inset: 4px 0 0 16px; }
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

  // ---------- links: ⌘-click (Ctrl-click) on URLs and file paths ----------

  const URL_RE = /\bhttps?:\/\/[^\s"'<>()\[\]{}]+[^\s"'<>()\[\]{}.,;:!?]/g;
  const PATH_RE = /(?:^|[\s('"`=:])((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,12})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))?/g;
  const resolvePath = (t, p) => {
    if (p.startsWith("/")) return p;
    if (p.startsWith("~/")) return null;
    const base = t.cwd ?? ctx.workspace.folder();
    if (!base) return null;
    const parts = [...base.split("/"), ...p.split("/")];
    const out = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    return "/" + out.join("/");
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
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      allowTransparency: true,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const shellName = opts.command ? basename(opts.command) : basename(shells.default ?? "zsh");
    const isShell = (c) => /(?:^|\/)(?:zsh|bash|fish|sh|ksh|tcsh|nu|pwsh|powershell|cmd)(?:\.exe)?$/.test(c ?? "");
    const t = { id: ++counter, shellCommand: opts.shellCommand ?? (isShell(opts.command) ? opts.command : undefined), name: opts.name ?? shellName, title: null, term, fit, el, pane, pty: null, exited: false, cwd: opts.cwd ?? ctx.workspace.folder() ?? null, group };
    pane.addEventListener("mousedown", () => focusTerm(t), true);
    pane.addEventListener("contextmenu", (e) => termMenu(e, t));
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
    const g = { id: ++counter, terms: [], active: null, el: h("div", { class: "term-group" }) };
    stage.append(g.el);
    groups.push(g);
    const t = await newTerm(opts, g);
    g.terms.push(t);
    g.active = t;
    g.el.append(t.pane);
    showGroup(g);
    await startPty(t, opts);
    focusTerm(t);
    creating = false;
    return t;
  };

  /** Another terminal next to the active one, in the same tab. */
  const split = async (opts = {}) => {
    await ensureView();
    const g = activeGroup;
    if (!g) return create(opts);
    const from = g.active;
    const t = await newTerm({ cwd: from?.cwd ?? undefined, command: from?.shellCommand, ...opts }, g);
    const i = g.terms.indexOf(from);
    g.terms.splice(i + 1, 0, t);
    from?.pane.after(t.pane) ?? g.el.append(t.pane);
    g.el.classList.add("split");
    g.active = t;
    requestAnimationFrame(fitAll);
    await startPty(t, opts);
    focusTerm(t);
    paintTabs();
    return t;
  };

  const showGroup = (g) => {
    activeGroup = g;
    for (const x of groups) x.el.classList.toggle("active", x === g);
    requestAnimationFrame(() => {
      fitAll();
      g.active?.term.focus();
    });
    paintTabs();
  };

  const focusTerm = (t) => {
    if (!t) return;
    if (activeGroup !== t.group) showGroup(t.group);
    t.group.active = t;
    for (const x of t.group.terms) x.pane.classList.toggle("focused", x === t);
    t.term.focus();
    paintTabs();
  };

  const kill = (t = active(), { quiet = false } = {}) => {
    if (!t) return;
    if (!t.exited) t.pty?.kill();
    t.exited = true;
    t.term.dispose();
    t.pane.remove();
    const g = t.group;
    g.terms.splice(g.terms.indexOf(t), 1);
    g.el.classList.toggle("split", g.terms.length > 1);
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

  // ---------- menus and the tab list ----------

  const pickShell = async () => {
    const list = shells.shells.length ? shells.shells : [shells.default ?? "/bin/zsh"];
    const choice = await ctx.window.showQuickPick(
      list.map((p) => ({ label: basename(p), description: p + (p === shells.default ? " (default)" : ""), path: p })),
      { placeholder: "Select the terminal profile to create" },
    );
    if (choice) create({ command: choice.path, shellCommand: choice.path });
  };

  const newMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const list = shells.shells.length ? shells.shells : [];
    ctx.window.contextMenu(r.left, r.bottom + 2, [
      ...list.map((p) => ({ label: basename(p) + (p === shells.default ? " (default)" : ""), run: () => create({ command: p }) })),
      { separator: true, label: "" },
      { label: "Split Terminal", keybinding: isMac ? "mod+\\" : "ctrl+shift+5", run: () => split() },
      { separator: true, label: "" },
      { label: "Select Default Profile…", disabled: true },
    ].filter((x, i, all) => !(x.label === "Select Default Profile…") && !(x.separator && i === all.length - 2)));
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
      { label: "New Terminal", keybinding: "ctrl+shift+`", run: () => create() },
      { separator: true, label: "" },
      { label: "Kill Terminal", run: () => kill(t) },
    ]);
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
              title: `${label(t)}${t.cwd ? `\n${t.cwd}` : ""}`,
              onclick: () => focusTerm(t),
              ondblclick: () => startRename(t),
              oncontextmenu: (e) => tabMenu(e, t),
            },
            h("span", { class: "branch" }, branch),
            icon("terminal"),
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
      { icon: "split-horizontal", title: `Split Terminal (${isMac ? "⌘\\" : "Ctrl+Shift+5"})`, run: () => split() },
      { icon: "trash", title: "Kill Terminal", run: () => kill() },
      {
        icon: "ellipsis",
        title: "Views and More Actions…",
        run: (e) => {
          const r = e?.currentTarget?.getBoundingClientRect?.() ?? { left: 200, bottom: 60 };
          ctx.window.contextMenu(r.left - 160, r.bottom + 4, [
            { label: "Clear Terminal", run: () => clearTerm() },
            { label: "Rename…", disabled: !active(), run: () => active() && startRename(active()) },
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
      new ResizeObserver(() => fitAll()).observe(stage);
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
  ctx.commands.register("terminal.split", () => split());
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
  new MutationObserver(() => allTerms().forEach((t) => (t.term.options.theme = theme()))).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  /** For other mods: open a terminal running a command (an agent CLI, a script). */
  return { open: (opts) => create({ keepOpen: true, ...opts }), split: (opts) => split(opts), sendText };
}
