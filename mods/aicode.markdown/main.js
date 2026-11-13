// Markdown Preview: what VS Code's built-in Markdown extension puts in the tab bar of a .md file —
// "Open Preview to the Side" (⌘K V) and "Open as Preview" (⇧⌘V) — plus "Reopen Editor With… →
// Markdown Preview" and, on a preview, "Open Source". The preview follows the text as it is typed
// and scrolls with the editor; the breadcrumbs show the headings above the cursor. The preview to the side can be maximized over the editor ("Maximize
// Preview", like VS Code's Maximize Editor Group) and uses the whole width of its pane.

import { renderMarkdown } from "./render.js";

const STYLE = `
.md-preview { --md-sep: color-mix(in srgb, var(--aicode-foreground) 18%, transparent); --md-th: color-mix(in srgb, var(--aicode-foreground) 69%, transparent); box-sizing: border-box; padding: 0 26px 26px; font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif; font-size: 14px; line-height: 22px; color: var(--aicode-foreground); word-wrap: break-word; user-select: text; -webkit-user-select: text; cursor: auto; }
.md-preview > :first-child { margin-top: 0; padding-top: 14px; }
.md-preview h1, .md-preview h2, .md-preview h3, .md-preview h4, .md-preview h5, .md-preview h6 { font-weight: 600; margin-top: 24px; margin-bottom: 16px; line-height: 1.25; }
.md-preview h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid var(--md-sep); }
.md-preview h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid var(--md-sep); }
.md-preview h3 { font-size: 1.25em; }
.md-preview h4 { font-size: 1em; }
.md-preview h5 { font-size: .875em; }
.md-preview h6 { font-size: .85em; color: var(--aicode-descriptionForeground); }
.md-preview p, .md-preview blockquote, .md-preview ul, .md-preview ol, .md-preview table, .md-preview pre { margin-top: 0; margin-bottom: 16px; }
.md-preview ul, .md-preview ol { padding-left: 2em; }
.md-preview li > ul, .md-preview li > ol { margin-bottom: 0; }
.md-preview li + li { margin-top: .25em; }
.md-preview li > p { margin-bottom: .5em; }
.md-preview .task-list-item { list-style: none; }
.md-preview .task-list-item > input { margin: 0 .35em .25em -1.6em; vertical-align: middle; }
.md-preview a { color: var(--aicode-textLink-foreground, #4daafc); text-decoration: none; cursor: pointer; }
.md-preview a:hover { color: var(--aicode-textLink-activeForeground, var(--aicode-textLink-foreground)); text-decoration: underline; }
.md-preview code { font-family: var(--aicode-editor-font-family, Menlo, Monaco, "Courier New", monospace); font-size: 1em; line-height: 1.357em; color: var(--aicode-textPreformat-foreground); background: var(--aicode-textPreformat-background, rgba(255,255,255,.08)); padding: 1px 3px; border-radius: 4px; }
.md-preview pre { background: var(--aicode-textCodeBlock-background, rgba(255,255,255,.06)); padding: 16px; border-radius: 3px; overflow: auto; }
.md-preview pre code { color: var(--aicode-editor-foreground); background: none; padding: 0; border-radius: 0; white-space: pre; tab-size: 4; }
.md-preview blockquote { margin-left: 0; padding: 0 16px 0 10px; border-left: 5px solid var(--aicode-textBlockQuote-border, rgba(255,255,255,.2)); background: var(--aicode-textBlockQuote-background, transparent); }
.md-preview blockquote > :last-child { margin-bottom: 0; }
.md-preview hr { border: 0; height: 1px; border-bottom: 1px solid var(--md-sep); margin: 24px 0; }
.md-preview table { border-collapse: collapse; }
.md-preview th { text-align: left; border-bottom: 1px solid var(--md-th); }
.md-preview th, .md-preview td { padding: 5px 10px; }
.md-preview table > tbody > tr + tr > td { border-top: 1px solid var(--md-sep); }
.md-preview .md-image { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 4px; border: 1px dashed var(--aicode-widget-border); color: var(--aicode-descriptionForeground); font-size: 12px; }
.md-preview .md-empty { color: var(--aicode-descriptionForeground); font-style: italic; padding-top: 14px; }
`;

const isMd = (info) => info?.language === "markdown";

/** The headings above the cursor, outermost first (fenced code is skipped): the breadcrumbs. */
function headingPath(text, line) {
  if (text.length > 2e6) return [];
  const lines = text.split(/\r?\n/);
  const stack = [];
  let fence = null;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const t = lines[i];
    const f = /^\s*(```|~~~)/.exec(t);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
    if (!m) continue;
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, crumb: { name: m[2], line: i + 1, icon: "symbol-string" } });
  }
  return stack.map((s) => s.crumb);
}
const base = (p) => p.split(/[\\/]/).pop();
const dir = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));

export async function activate(ctx) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  ctx.subscriptions.push({ dispose: () => style.remove() });
  ctx.editor.registerBreadcrumbs({ languages: ["markdown"], path: (text, line) => headingPath(text, line) });

  /** Renders the file into `el` and keeps it current; returns what stops it. */
  const mount = (el, source) => {
    const page = document.createElement("div");
    page.className = "md-preview";
    el.append(page);
    let pending = 0;
    const paint = () => {
      pending = 0;
      const text = ctx.editor.getText(source.id) ?? ctx.editor.getText(source.path) ?? source.text ?? "";
      page.innerHTML = text.trim() ? renderMarkdown(text) : `<div class="md-empty">This file is empty.</div>`;
    };
    paint();
    // Links: web links open in the browser, links to files open them, #anchors scroll.
    page.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[data-href]");
      if (!a) return;
      e.preventDefault();
      const href = a.dataset.href;
      if (!href) return;
      if (href.startsWith("#")) {
        page.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: "start" });
      } else if (/^(https?|mailto):/i.test(href)) {
        ctx.external.open(href).catch((err) => ctx.window.showError(String(err)));
      } else if (source.path) {
        const [file, line] = href.split("#");
        const target = ctx.ui.isAbsolute(file) ? file : normalize(`${dir(source.path)}/${decodeURIComponent(file)}`, ctx.ui.pathRoot(source.path));
        const m = line?.match(/^L(\d+)/);
        ctx.editor.open(target, m ? { line: Number(m[1]) } : {});
      }
    });
    const subs = [
      ctx.editor.onDidChangeContent((info) => {
        if (info.id === source.id || (source.path && info.path === source.path)) pending ||= requestAnimationFrame(paint);
      }),
    ];
    // Scroll with the editor while it shows this file.
    const editor = ctx.editor.monacoEditor();
    const onScroll = editor.onDidScrollChange?.((e) => {
      if (!e.scrollTopChanged) return;
      const active = ctx.editor.active();
      if (!active || (active.id !== source.id && active.path !== source.path)) return;
      const top = (editor.getVisibleRanges()[0]?.startLineNumber ?? 1) - 1;
      let best = null;
      for (const b of page.querySelectorAll("[data-line]")) {
        if (Number(b.dataset.line) <= top) best = b;
        else break;
      }
      const scroller = el.closest(".editor-side-body") ?? el;
      if (e.scrollTop === 0 || !best) scroller.scrollTop = 0;
      else scroller.scrollTop = best.offsetTop - 8;
    });
    return { dispose: () => { subs.forEach((s) => s.dispose()); onScroll?.dispose(); if (pending) cancelAnimationFrame(pending); } };
  };

  const sourceOf = (info) => ({ id: info.id, path: info.path, text: ctx.editor.getText(info.id) });

  /** Whether the pane to the side is this mod's preview (another mod may have replaced it). */
  let sideShown = false;
  const toSide = (info = ctx.editor.active()) => {
    if (!isMd(info)) return ctx.window.showInfo("Open a Markdown file to preview it.");
    const source = sourceOf(info);
    const maximize = { id: "maximize", icon: "screen-full", title: "Maximize Preview", run: () => ctx.editor.maximizeSide() };
    ctx.editor.openSide({
      title: `Preview ${info.title}`,
      icon: "open-preview",
      actions: [maximize],
      onDidChangeMaximized: (on) => Object.assign(maximize, on ? { icon: "screen-normal", title: "Restore Preview" } : { icon: "screen-full", title: "Maximize Preview" }),
      render: (el) => {
        const view = mount(el, source);
        sideShown = true;
        return { dispose: () => { sideShown = false; view.dispose(); } };
      },
    });
  };
  const asTab = (info = ctx.editor.active()) => {
    if (!isMd(info)) return ctx.window.showInfo("Open a Markdown file to preview it.");
    if (!info.path) return toSide(info);
    const source = sourceOf(info);
    ctx.editor.openCustom({
      title: `Preview ${base(info.path)}`,
      icon: "open-preview",
      key: `markdown-preview:${info.path}`,
      forPath: info.path,
      editorType: "markdown.preview",
      render: (el) => {
        const view = mount(el, source);
        sideShown = true;
        return { dispose: () => { sideShown = false; view.dispose(); } };
      },
    });
  };

  ctx.commands.register("markdown.showPreviewToSide", () => toSide());
  ctx.commands.register("markdown.showPreview", () => asTab());
  ctx.commands.register("markdown.togglePreviewMaximized", () => {
    if (!sideShown) {
      if (!isMd(ctx.editor.active())) return ctx.window.showInfo("Open a Markdown file to preview it.");
      toSide();
    }
    ctx.editor.maximizeSide();
  });
  ctx.commands.register("markdown.showSource", () => {
    const info = ctx.editor.active();
    if (info?.path) ctx.editor.open(info.path);
  });

  const textMd = (info) => isMd(info) && (info.editorType ?? "default") === "default";
  ctx.editor.addTitleAction({ id: "previewToSide", icon: "open-preview", title: "Open Preview to the Side (⌘K V)", order: 10, when: textMd, run: (info) => toSide(info) });
  ctx.editor.addTitleAction({ id: "preview", icon: "preview", title: "Open as Preview (⇧⌘V)", order: 30, when: (info) => textMd(info) && !!info.path, run: (info) => asTab(info) });
  ctx.editor.addTitleAction({ id: "source", icon: "go-to-file", title: "Open Source", order: 10, when: (info) => info.editorType === "markdown.preview", run: (info) => info.path && ctx.editor.open(info.path) });
  ctx.editor.registerEditorType({ id: "markdown.preview", label: "Markdown Preview", when: (info) => isMd(info), open: (info) => asTab(info) });
}

/** `..` and `.` resolved; `root` (`/`, `C:/`) is kept however many `..` there are. */
function normalize(path, root = "/") {
  const out = [];
  for (const part of path.slice(path.startsWith(root) ? root.length : 0).split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return root + out.join("/");
}
