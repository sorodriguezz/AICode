// Search: find (and replace) text across the open folder, like VS Code's Search view. The search
// runs in Rust (ripgrep's walker: .gitignore, include/exclude globs); replacing happens here, in the
// open editors' buffers (undoable, left unsaved) or straight in the files that are not open.

const STYLE = `
.search-view { position: absolute; inset: 0; display: flex; flex-direction: column; }
.search-form { padding: 4px 12px 0 4px; display: grid; grid-template-columns: 16px 1fr; column-gap: 2px; row-gap: 6px; align-items: center; }
.search-form .toggle-replace { width: 16px; height: 26px; align-self: start; border-radius: 3px; }
.search-form .toggle-replace .codicon { font-size: 14px; }
.search-form .col { grid-column: 2; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sbox { position: relative; display: flex; align-items: center; min-width: 0; height: 26px; border: 1px solid var(--aicode-input-border); border-radius: 4px; background: var(--aicode-input-background); }
.sbox:focus-within { border-color: var(--aicode-focusBorder); }
.sbox.invalid { border-color: var(--aicode-inputValidation-errorBorder, #be1100); }
.sbox input { flex: 1 1 auto; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--aicode-input-foreground); padding: 0 6px; font: inherit; user-select: text; -webkit-user-select: text; }
.sbox input::placeholder { color: var(--aicode-input-placeholderForeground); }
.sbox .opts { display: flex; gap: 1px; padding-right: 2px; }
.sbox .opt { width: 20px; height: 20px; border-radius: 3px; border: 1px solid transparent; }
.sbox .opt .codicon { font-size: 15px; }
.sbox .opt.active { background: var(--aicode-inputOption-activeBackground, #3994bc33); border-color: var(--aicode-inputOption-activeBorder, transparent); color: var(--aicode-inputOption-activeForeground, inherit); }
.replace-row { display: flex; align-items: center; gap: 2px; }
.replace-row .sbox { flex: 1 1 auto; }
.replace-row .icon-button { width: 24px; height: 24px; }
.search-details { display: flex; justify-content: flex-end; margin-top: -4px; }
.search-details .icon-button { width: 22px; height: 16px; }
.details-field { display: flex; flex-direction: column; gap: 3px; }
.details-field label { font-size: 11px; color: var(--aicode-descriptionForeground); padding-left: 1px; }
.search-msg { font-size: 12px; color: var(--aicode-descriptionForeground); padding: 8px 12px 6px 22px; line-height: 1.4; }
.search-msg.err { color: var(--aicode-errorForeground); }
.search-msg a { cursor: pointer; }
.search-results { flex: 1 1 auto; overflow: auto; padding-bottom: 10px; }
.sres-file .twistie .codicon { font-size: 16px; }
.sres-file .name { margin-left: 6px; flex: 0 0 auto; }
.sres-file .hint { margin-left: 6px; flex: 1 1 auto; min-width: 0; }
.sres-file .count { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center; background: var(--aicode-badge-background); color: var(--aicode-badge-foreground); flex: 0 0 auto; }
.sres-row { position: relative; }
.sres-row .ractions { display: none; position: absolute; right: 4px; top: 1px; gap: 0; background: inherit; padding-left: 4px; }
.sres-row:hover .ractions { display: flex; }
.sres-row:hover .count { visibility: hidden; }
.sres-row .ractions .icon-button { width: 20px; height: 20px; }
body .sres-row .ractions .codicon { font-size: 14px; }
.sres-hit .name { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.sres-hit mark { background: var(--aicode-editor-findMatchHighlightBackground, #ea5c0055); color: inherit; border-radius: 2px; }
.sres-hit del { background: var(--aicode-diffEditor-removedTextBackground, #ff000033); color: inherit; text-decoration: line-through; }
.sres-hit ins { background: var(--aicode-diffEditor-insertedTextBackground, #9ccc2c33); color: inherit; text-decoration: none; }
`;

export async function activate(ctx) {
  const { h, icon, iconButton, clear, basename, dirname, fileIcon } = ctx.ui;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  ctx.subscriptions.push({ dispose: () => style.remove() });

  const saved = await ctx.settings.get("state", {});
  const opts = { caseSensitive: false, wholeWord: false, regex: false, preserveCase: false, ...(saved.opts ?? {}) };
  let query = "";
  let replaceText = "";
  let showReplace = !!saved.showReplace;
  let showDetails = !!saved.showDetails;
  let include = "";
  let exclude = "";
  let onlyOpen = false;
  let useIgnore = true;
  let history = saved.history ?? [];
  let historyIndex = -1;
  let result = null; // { hits, files_searched, truncated }
  let error = "";
  let running = 0;
  let searching = false;
  const collapsed = new Set();
  const dismissed = new Set(); // `${path}:${line}:${column}` and whole files
  let root, searchInput, replaceInput, includeInput, excludeInput, msgEl, listEl, formEl;

  const folder = () => ctx.workspace.folder();
  const rel = (p) => (folder() && p.startsWith(folder() + "/") ? p.slice(folder().length + 1) : p);
  const persist = () => ctx.settings.set("state", { opts, showReplace, showDetails, history: history.slice(0, 20) });

  // ---------- searching ----------

  const run = async () => {
    const mine = ++running;
    dismissed.clear();
    if (!query) {
      result = null;
      error = "";
      searching = false;
      return paint();
    }
    if (!folder()) {
      result = null;
      error = "Open a folder to search its files.";
      return paint();
    }
    searching = true;
    paintMessage();
    try {
      const paths = onlyOpen ? ctx.editor.all().map((e) => e.path).filter(Boolean) : undefined;
      const r = await ctx.fs.search(folder(), query, { ...opts, maxResults: 5000, include, exclude, useIgnore, paths });
      if (mine !== running) return;
      result = withOpenBuffers(r);
      error = "";
      fresh = true;
    } catch (e) {
      if (mine !== running) return;
      result = null;
      error = String(e).replace(/^Error: /, "");
    }
    searching = false;
    paint();
  };

  /**
   * Files open with unsaved changes are searched in their editor, not on disk (as VS Code does):
   * their hits from Rust are replaced by the buffer's. Only files the search could have looked at
   * (already in the results, or matching no filter) are added.
   */
  const withOpenBuffers = (r) => {
    let re;
    try {
      re = new RegExp(regexSource(), flags("gu"));
    } catch {
      return r;
    }
    const dirty = ctx.editor.all().filter((e) => e.path && e.dirty && folder() && e.path.startsWith(folder() + "/"));
    if (!dirty.length) return r;
    const touched = new Set(dirty.map((e) => e.path));
    const inResults = new Set(r.hits.map((x) => x.path));
    const hits = r.hits.filter((x) => !touched.has(x.path));
    for (const e of dirty) {
      if (!inResults.has(e.path) && (include || exclude || onlyOpen === false && !useIgnore)) continue;
      const text = ctx.editor.getText(e.id) ?? "";
      text.split(/\r?\n/).forEach((line, i) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          if (m[0] === "") {
            re.lastIndex++;
            continue;
          }
          hits.push({ path: e.path, line: i + 1, column: [...line.slice(0, m.index)].length + 1, length: [...m[0]].length, text: [...line].slice(0, 400).join("") });
        }
      });
    }
    return { ...r, hits };
  };

  let timer = null;
  const runSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  };

  const remember = () => {
    if (!query) return;
    history = [query, ...history.filter((q) => q !== query)].slice(0, 20);
    historyIndex = -1;
    persist();
  };

  // ---------- replacing ----------

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexSource = () => {
    let p = opts.regex ? query : escapeRe(query);
    if (opts.wholeWord) p = `\\b(?:${p})\\b`;
    return p;
  };
  const flags = (extra = "") => `${opts.caseSensitive ? "" : "i"}${extra}`;

  /** "Preserve Case": FOO→BAR, Foo→Bar, foo→bar. */
  const withCase = (matched, replacement) => {
    if (!opts.preserveCase || !replacement) return replacement;
    if (matched === matched.toUpperCase() && matched !== matched.toLowerCase()) return replacement.toUpperCase();
    if (matched[0] && matched[0] === matched[0].toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
    if (matched === matched.toLowerCase()) return replacement.toLowerCase();
    return replacement;
  };

  /** What one match becomes ($1… work with regular expressions, as in VS Code). */
  const replacementFor = (matched) => {
    if (!opts.regex) return withCase(matched, replaceText);
    try {
      const one = new RegExp(`^(?:${regexSource()})$`, flags("u"));
      return withCase(matched, matched.replace(one, replaceText));
    } catch {
      return withCase(matched, replaceText);
    }
  };

  /** Replaces the matches of one line, keeping everything else of it. */
  const replaceInLine = (line, only) => {
    const re = new RegExp(regexSource(), flags("gu"));
    let out = "";
    let last = 0; // in UTF-16 units
    let m;
    while ((m = re.exec(line))) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      const col = [...line.slice(0, m.index)].length + 1;
      if (only && only !== col) continue;
      out += line.slice(last, m.index) + replacementFor(m[0]);
      last = m.index + m[0].length;
    }
    return out + line.slice(last);
  };

  /** Applies replacements to one file: `lines` maps line → column (one match) or 0 (all of them). */
  const replaceInFile = async (path, lines) => {
    const model = ctx.monaco?.editor.getModel(ctx.monaco.Uri.file(path));
    if (model) {
      const edits = [];
      for (const [lineNo, col] of lines) {
        if (lineNo > model.getLineCount()) continue;
        const before = model.getLineContent(lineNo);
        const after = replaceInLine(before, col || 0);
        if (after !== before) edits.push({ range: new ctx.monaco.Range(lineNo, 1, lineNo, before.length + 1), text: after });
      }
      if (edits.length) model.pushEditOperations([], edits, () => null);
      return edits.length;
    }
    const file = await ctx.fs.readText(path);
    if (file.binary) return 0;
    const parts = file.text.split(/(\r?\n)/); // lines at even indexes, line breaks between them
    let changed = 0;
    for (const [lineNo, col] of lines) {
      const i = (lineNo - 1) * 2;
      if (i >= parts.length) continue;
      const after = replaceInLine(parts[i], col || 0);
      if (after !== parts[i]) {
        parts[i] = after;
        changed++;
      }
    }
    if (changed) await ctx.fs.writeText(path, parts.join(""), { bom: file.bom });
    return changed;
  };

  const liveHits = () => (result?.hits ?? []).filter((x) => !dismissed.has(x.path) && !dismissed.has(`${x.path}:${x.line}:${x.column}`));

  const byFile = (hits) => {
    const map = new Map();
    for (const x of hits) {
      if (!map.has(x.path)) map.set(x.path, []);
      map.get(x.path).push(x);
    }
    return map;
  };

  const replaceHits = async (hits, { confirm = false } = {}) => {
    if (!hits.length) return;
    const files = byFile(hits);
    if (confirm) {
      const n = hits.length;
      const ok = await ctx.window.confirm(
        `Replace ${n} occurrence${n === 1 ? "" : "s"} across ${files.size} file${files.size === 1 ? "" : "s"} with '${replaceText}'?`,
        "Files that are open are changed in their editor (unsaved, undoable); the others are written right away.",
        "Replace",
      );
      if (!ok) return;
    }
    for (const [path, list] of files) {
      // One match per line → only that column; several on a line → all of that line's matches.
      const lines = new Map();
      for (const x of list) lines.set(x.line, lines.has(x.line) ? 0 : x.column);
      try {
        await replaceInFile(path, lines);
      } catch (e) {
        ctx.window.showError(`${basename(path)}: ${e}`);
      }
    }
    if (confirm) ctx.window.showInfo(`Replaced ${hits.length} occurrence${hits.length === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"}.`);
    await run();
  };

  // ---------- rendering ----------

  const toggleOpt = (key, iconName, title) =>
    h(
      "button",
      {
        class: `icon-button opt${opts[key] ? " active" : ""}`,
        title,
        "aria-pressed": String(!!opts[key]),
        onclick: (e) => {
          opts[key] = !opts[key];
          e.currentTarget.classList.toggle("active", opts[key]);
          persist();
          if (key === "preserveCase") paintResults();
          else run();
        },
      },
      icon(iconName),
    );

  const box = (input, ...options) => h("div", { class: "sbox" }, input, options.length ? h("div", { class: "opts" }, options) : null);

  const paintForm = () => {
    clear(formEl);
    const fields = [box(searchInput, toggleOpt("caseSensitive", "case-sensitive", "Match Case (⌥⌘C)"), toggleOpt("wholeWord", "whole-word", "Match Whole Word (⌥⌘W)"), toggleOpt("regex", "regex", "Use Regular Expression (⌥⌘R)"))];
    if (showReplace) {
      fields.push(
        h(
          "div",
          { class: "replace-row" },
          box(replaceInput, toggleOpt("preserveCase", "preserve-case", "Preserve Case (⌥⌘P)")),
          iconButton("replace-all", "Replace All (⌥⌘Enter)", () => replaceHits(liveHits(), { confirm: true })),
        ),
      );
    }
    fields.push(h("div", { class: "search-details" }, iconButton("ellipsis", showDetails ? "Hide Search Details" : "Toggle Search Details", () => { showDetails = !showDetails; persist(); paintForm(); })));
    if (showDetails) {
      const openBtn = h("button", { class: `icon-button opt${onlyOpen ? " active" : ""}`, title: "Search Only in Open Editors", onclick: (e) => { onlyOpen = !onlyOpen; e.currentTarget.classList.toggle("active", onlyOpen); run(); } }, icon("book"));
      const ignoreBtn = h("button", { class: `icon-button opt${useIgnore ? " active" : ""}`, title: "Use Exclude Settings and Ignore Files (.gitignore, node_modules)", onclick: (e) => { useIgnore = !useIgnore; e.currentTarget.classList.toggle("active", useIgnore); run(); } }, icon("exclude"));
      fields.push(
        h("div", { class: "details-field" }, h("label", null, "files to include"), box(includeInput, openBtn)),
        h("div", { class: "details-field" }, h("label", null, "files to exclude"), box(excludeInput, ignoreBtn)),
      );
    }
    formEl.append(
      h("button", { class: "icon-button toggle-replace", title: "Toggle Replace (⇧⌘H)", onclick: () => setReplace(!showReplace) }, icon(showReplace ? "chevron-down" : "chevron-right")),
      h("div", { class: "col" }, fields),
    );
  };

  const setReplace = (on) => {
    showReplace = on;
    persist();
    paintForm();
    paintResults();
    (on ? replaceInput : searchInput).focus();
  };

  const paintMessage = () => {
    if (!msgEl) return;
    clear(msgEl);
    msgEl.className = "search-msg";
    searchInput?.parentElement.classList.toggle("invalid", !!error && !!query);
    if (searching) return msgEl.append("Searching…");
    if (error) {
      msgEl.classList.add("err");
      return msgEl.append(error);
    }
    if (!result) return;
    const hits = liveHits();
    const files = byFile(hits).size;
    ctx.views.setBadge("search", files);
    if (!hits.length) {
      msgEl.append(`No results found.${!useIgnore || include || exclude ? "" : " Review your settings for configured exclusions and check your gitignore files."} `, include || exclude || onlyOpen ? h("a", { onclick: () => { include = exclude = ""; onlyOpen = false; includeInput.value = excludeInput.value = ""; paintForm(); run(); } }, "Clear filters") : "");
      return;
    }
    msgEl.append(`${hits.length} result${hits.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`);
    if (result.truncated) msgEl.append(h("div", { style: { marginTop: "4px" } }, "The result set only contains a subset of all matches. Be more specific in your search to narrow down the results."));
  };

  let fresh = false; // results that just came in slide in; re-paints (collapsing a file) do not
  const paintResults = () => {
    if (!listEl) return;
    clear(listEl);
    paintMessage();
    if (!result) return ctx.views.setBadge("search", 0);
    const replacing = showReplace && replaceInput && (replaceText !== "" || document.activeElement === replaceInput);
    let n = 0;
    for (const [path, hits] of byFile(liveHits())) {
      const closed = collapsed.has(path);
      const fileRow = h(
        "div",
        {
          class: `list-row sres-row sres-file${fresh ? " row-enter" : ""}`,
          style: { paddingLeft: "6px", animationDelay: `${Math.min(n++, 12) * 16}ms` },
          title: path,
          onclick: () => {
            closed ? collapsed.delete(path) : collapsed.add(path);
            paintResults();
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            ctx.window.contextMenu(e.clientX, e.clientY, [
              { label: "Replace All in File", disabled: !showReplace, run: () => replaceHits(hits) },
              { label: "Dismiss", run: () => { dismissed.add(path); paintResults(); } },
              { separator: true, label: "" },
              { label: "Copy Path", run: () => ctx.window.copy(path) },
              { label: "Copy Relative Path", run: () => ctx.window.copy(rel(path)) },
              { label: "Copy All Results", run: () => ctx.window.copy(hits.map((x) => `${rel(path)}:${x.line}:${x.column}: ${x.text.trim()}`).join("\n")) },
            ]);
          },
        },
        h("span", { class: "twistie" }, icon(closed ? "chevron-right" : "chevron-down")),
        ctx.ui.fileIconEl ? ctx.ui.fileIconEl(basename(path)) : icon(fileIcon(path)),
        h("span", { class: "name" }, basename(path)),
        h("span", { class: "hint" }, dirname(rel(path)) === "." || !rel(path).includes("/") ? "" : dirname(rel(path))),
        h("span", { class: "count" }, String(hits.length)),
        h(
          "span",
          { class: "ractions", onclick: (e) => e.stopPropagation() },
          showReplace ? iconButton("replace-all", "Replace All in File", () => replaceHits(hits)) : null,
          iconButton("close", "Dismiss", () => { dismissed.add(path); paintResults(); }),
        ),
      );
      listEl.append(fileRow);
      if (closed) continue;
      for (const hit of hits) {
        const chars = [...hit.text];
        const start = hit.column - 1;
        const before = chars.slice(Math.max(0, start - 40), start).join("").trimStart();
        const match = chars.slice(start, start + hit.length).join("");
        const after = chars.slice(start + hit.length, start + hit.length + 160).join("");
        const shown = replacing ? [h("del", null, match), h("ins", null, replacementFor(match))] : [h("mark", null, match)];
        listEl.append(
          h(
            "div",
            {
              class: "list-row sres-row sres-hit",
              style: { paddingLeft: "38px" },
              title: `${hit.line}:${hit.column}  ${hit.text.trim()}`,
              onclick: () => ctx.editor.open(path, { line: hit.line, column: hit.column, preview: true }),
              ondblclick: () => ctx.editor.open(path, { line: hit.line, column: hit.column }),
            },
            h("span", { class: "name" }, before, ...shown, after),
            h(
              "span",
              { class: "ractions", onclick: (e) => e.stopPropagation() },
              showReplace ? iconButton("replace", "Replace", () => replaceHits([hit])) : null,
              iconButton("close", "Dismiss", () => { dismissed.add(`${hit.path}:${hit.line}:${hit.column}`); paintResults(); }),
            ),
          ),
        );
      }
    }
    fresh = false;
  };

  const paint = () => {
    paintMessage();
    paintResults();
  };

  const field = (placeholder, onChange, onKey) =>
    h("input", {
      placeholder,
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      oninput: (e) => onChange(e.target.value),
      onkeydown: (e) => onKey?.(e),
    });

  ctx.views.provide("search", {
    actions: [
      { icon: "refresh", title: "Refresh", run: () => run() },
      { icon: "clear-all", title: "Clear Search Results", run: () => { query = ""; searchInput.value = ""; replaceText = ""; replaceInput.value = ""; run(); searchInput.focus(); } },
      { icon: "collapse-all", title: "Collapse All", run: () => { for (const x of result?.hits ?? []) collapsed.add(x.path); paintResults(); } },
    ],
    render: (el) => {
      root = el;
      searchInput = field(
        "Search",
        (v) => {
          query = v;
          runSoon();
        },
        (e) => {
          if (e.key === "Enter") {
            clearTimeout(timer);
            remember();
            run();
          } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length) {
            // ↑/↓ walk through earlier searches.
            e.preventDefault();
            historyIndex = Math.max(-1, Math.min(history.length - 1, historyIndex + (e.key === "ArrowUp" ? 1 : -1)));
            query = historyIndex < 0 ? "" : history[historyIndex];
            searchInput.value = query;
            runSoon();
          } else if (e.key === "Escape" && query) {
            query = "";
            searchInput.value = "";
            run();
          }
        },
      );
      replaceInput = field(
        "Replace",
        (v) => {
          replaceText = v;
          paintResults();
        },
        (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.altKey) replaceHits(liveHits(), { confirm: true });
        },
      );
      replaceInput.addEventListener("focus", () => paintResults());
      replaceInput.addEventListener("blur", () => paintResults());
      includeInput = field("e.g. *.ts, src/**/include", (v) => { include = v; runSoon(); }, (e) => e.key === "Enter" && run());
      excludeInput = field("e.g. *.ts, src/**/exclude", (v) => { exclude = v; runSoon(); }, (e) => e.key === "Enter" && run());
      searchInput.addEventListener("keydown", (e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || !e.altKey) return;
        const k = e.code.replace(/^Key/, "").toLowerCase();
        const map = { c: "caseSensitive", w: "wholeWord", r: "regex" };
        if (map[k]) {
          e.preventDefault();
          opts[map[k]] = !opts[map[k]];
          persist();
          paintForm();
          searchInput.focus();
          run();
        }
      });
      formEl = h("div", { class: "search-form" });
      msgEl = h("div", { class: "search-msg" });
      listEl = h("div", { class: "search-results" });
      paintForm();
      root.append(h("div", { class: "search-view" }, formEl, msgEl, listEl));
      const sel = ctx.editor.getSelection();
      if (sel?.text && !sel.text.includes("\n")) {
        query = sel.text;
        searchInput.value = query;
        run();
      }
      searchInput.focus();
    },
    onShow: () => {
      const sel = ctx.editor.getSelection();
      if (sel?.text && !sel.text.includes("\n") && sel.text !== query && searchInput) {
        query = sel.text;
        searchInput.value = query;
        run();
      }
      searchInput?.focus();
      searchInput?.select();
    },
  });

  ctx.commands.register("search.inFolder", async (dir) => {
    await ctx.views.reveal("search");
    if (typeof dir === "string") {
      include = rel(dir) || "";
      showDetails = true;
      paintForm();
      includeInput.value = include;
    }
    searchInput?.focus();
    searchInput?.select();
    if (query) run();
  });
  ctx.commands.register("search.focus", async () => {
    await ctx.views.reveal("search");
    searchInput?.focus();
    searchInput?.select();
  });
  ctx.commands.register("search.replace", async () => {
    await ctx.views.reveal("search");
    setReplace(true);
  });

  ctx.workspace.onDidChangeFolder(() => {
    include = exclude = "";
    if (includeInput) includeInput.value = excludeInput.value = "";
    run();
  });
}
