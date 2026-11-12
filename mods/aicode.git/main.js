// Source Control: git for the open folder — changes, commits, branches, diffs and gutter markers.

import { makeGit, parseStatus, groups, lineChanges, decorationMap } from "./git.js";

const STYLE = `
.scm { padding: 6px 0 12px; }
.scm-input { padding: 2px 12px 8px 20px; }
.scm-input textarea { width: 100%; min-height: 30px; max-height: 200px; resize: none; display: block; }
.scm-input .btn { margin-top: 6px; }
/* Like VS Code: Commit with its options behind a chevron set into the same button. */
.scm-commit { display: flex; margin-top: 6px; }
.scm-commit .btn { margin-top: 0; }
.scm-commit .btn.commit-main { flex: 1 1 auto; min-width: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
.scm-commit .btn.commit-more { flex: 0 0 auto; width: 26px; padding: 0; justify-content: center; border-top-left-radius: 0; border-bottom-left-radius: 0; position: relative; }
.scm-commit .btn.commit-more::before { content: ""; position: absolute; left: 0; top: 4px; bottom: 4px; width: 1px; background: var(--aicode-button-separator, rgba(255, 255, 255, .4)); }
/* Like VS Code: while empty, the box stays one line and a long placeholder ends in "…" instead
   of wrapping under the edge. */
.scm-input textarea:placeholder-shown { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scm-input textarea::placeholder { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scm .list-row .letter { margin-left: auto; width: 14px; text-align: center; font-weight: 600; font-size: 12px; }
.scm .list-row .row-actions { display: none; gap: 0; }
.scm .list-row:hover .row-actions { display: flex; }
.scm .list-row .row-actions .icon-button { width: 20px; height: 20px; }
.scm .list-row .row-actions .codicon { font-size: 14px; }
.scm .l-M { color: var(--aicode-gitDecoration-modifiedResourceForeground, #e2c08d); }
.scm .l-A, .scm .l-U, .scm .l-R, .scm .l-C { color: var(--aicode-gitDecoration-addedResourceForeground, #73c991); }
.scm .l-D { color: var(--aicode-gitDecoration-deletedResourceForeground, #c74e39); }
.scm .l-\\! { color: var(--aicode-gitDecoration-conflictingResourceForeground, #e4676b); }
/* Like VS Code: the count is a round badge at the right end of the header; the actions show
   to its left on hover. */
.scm .section-header .count {
  margin-left: auto; margin-right: 6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; flex: 0 0 auto;
  background: var(--aicode-badge-background); color: var(--aicode-badge-foreground);
}
.scm .section-header:hover .count { margin-left: 4px; }
.scm .section-header .actions { padding-right: 0; }
.scm .list-row .scm-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scm .list-row .scm-label .name, .scm .list-row .scm-label .hint { overflow: visible; }
.scm .list-row .scm-label .hint { margin-left: 5px; }
.scm .list-row .letter { flex: 0 0 auto; }
.scm .list-row .row-actions { flex: 0 0 auto; }
.scm .list-row.deleted .name { text-decoration: line-through; }
.git-gutter-added { border-left: 3px solid var(--aicode-editorGutter-addedBackground, #2ea043); margin-left: 3px; }
.git-gutter-modified { border-left: 3px solid var(--aicode-editorGutter-modifiedBackground, #0078d4); margin-left: 3px; }
.git-gutter-deleted { border-left: 0; margin-left: 3px; width: 0 !important; height: 0 !important; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 5px solid var(--aicode-editorGutter-deletedBackground, #f85149); }
`;

export async function activate(ctx) {
  const { h, icon, iconButton, clear, basename, dirname, fileIcon } = ctx.ui;
  const monaco = ctx.monaco;
  const git = makeGit(ctx);
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  if (!(await ctx.process.which("git"))) {
    ctx.views.provide("scm", { render: (el) => el.append(h("div", { class: "notice" }, "git is not installed or not on your PATH.")) });
    return;
  }

  let lookup = () => undefined;
  const deco = ctx.decorations.register((path) => lookup(path));
  let root = null; // repository top level
  let status = null;
  let view = null;
  let message = "";
  let busy = "";
  const collapsed = new Set();
  const branchItem = ctx.statusBar.add({ align: "left", priority: 100, icon: "source-control", text: "", command: "git.checkout", tooltip: "Checkout Branch/Tag…", animate: true });
  const syncItem = ctx.statusBar.add({ align: "left", priority: 99, icon: "sync", text: "", command: "git.sync", tooltip: "Synchronize Changes", animate: true });

  const repoFor = async (folder) => {
    if (!folder) return null;
    const r = await git.run(["rev-parse", "--show-toplevel"], { cwd: folder, quiet: true });
    return r.code === 0 ? r.stdout.trim() : null;
  };

  // The repository's top folder and .git (index, HEAD) are watched: commits, checkouts and files
  // made from a terminal show up without coming back to the window.
  let watched = null;
  let soonTimer = null;
  const soon = () => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(refresh, 400);
  };
  const watchRepo = () => {
    if (watched?.root === root) return;
    watched?.subs.forEach((d) => d.dispose());
    watched = root ? { root, subs: [ctx.fs.watch(root, soon), ctx.fs.watch(`${root}/.git`, soon)] } : null;
  };
  let refreshing = null;
  let lastRefreshKey = "";
  const refresh = () => (refreshing ??= doRefresh().finally(() => (refreshing = null)));
  const doRefresh = async () => {
    root = await repoFor(ctx.workspace.folder());
    watchRepo();
    if (root) {
      const r = await git.run(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd: root, quiet: true });
      status = r.code === 0 ? parseStatus(r.stdout) : null;
      // Ignored files show faded in the explorer: folders come back whole (node_modules/, not its files).
      const ign = status ? await git.run(["status", "--porcelain=v2", "-z", "--ignored=traditional", "--untracked-files=normal"], { cwd: root, quiet: true }) : null;
      if (status && ign?.code === 0) status.ignored = ign.stdout.split("\0").filter((f) => f.startsWith("! ")).map((f) => f.slice(2).replace(/\/$/, ""));
    } else status = null;
    headCache.clear();
    lookup = status && root ? decorationMap(status, root) : () => undefined;
    deco.fire();
    paintStatus();
    // Showing the view refreshes it: repaint only when something changed, so it doesn't redraw
    // (and jump) right after it appears.
    const key = JSON.stringify([ctx.workspace.folder(), root, status, busy]);
    if (key !== lastRefreshKey || !view?.childElementCount) {
      lastRefreshKey = key;
      render();
    }
    updateGutter();
    ctx.editor.refreshTitleActions?.();
  };

  const paintStatus = () => {
    if (!status) {
      branchItem.update({ text: "" , icon: ""});
      syncItem.update({ text: "", icon: "" });
      ctx.views.setBadge("scm", 0);
      return;
    }
    const branch = status.branch === "(detached)" ? (status.oid ?? "").slice(0, 8) : status.branch;
    const dirty = status.files.length ? "*" : "";
    branchItem.update({ icon: "source-control", text: `${branch}${dirty}` });
    syncItem.update(
      status.upstream
        ? { icon: busy ? "sync" : "sync", text: status.ahead || status.behind ? `${status.behind}↓ ${status.ahead}↑` : "", tooltip: `${status.upstream} — pull ${status.behind}, push ${status.ahead}` }
        : { icon: "cloud-upload", text: "", tooltip: "Publish Branch" },
    );
    ctx.views.setBadge("scm", status.files.length);
  };

  // ---------- operations ----------

  const op = async (label, fn) => {
    busy = label;
    render();
    try {
      await fn();
    } catch (e) {
      ctx.window.showError(`Git: ${String(e.message ?? e)}`);
    } finally {
      busy = "";
      await refresh();
    }
  };

  const stage = (paths) => op("Staging…", () => git.ok(["add", "-A", "--", ...paths], { cwd: root }));
  const unstage = (paths) => op("Unstaging…", async () => {
    const r = await git.run(["restore", "--staged", "--", ...paths], { cwd: root });
    // A repository with no commits yet has nothing to restore from.
    if (r.code !== 0) await git.ok(["rm", "--cached", "-r", "-q", "--", ...paths], { cwd: root });
  });
  const discard = async (files) => {
    const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
    const untracked = files.filter((f) => f.untracked).map((f) => f.path);
    const names = files.length === 1 ? files[0].path : `${files.length} files`;
    const detail = untracked.length ? "Untracked files will be DELETED. This cannot be undone." : "Your changes will be lost. This cannot be undone.";
    if (!(await ctx.window.confirm(`Discard changes in ${names}?`, detail, untracked.length ? "Delete" : "Discard"))) return;
    await op("Discarding…", async () => {
      if (tracked.length) await git.ok(["restore", "--worktree", "--", ...tracked], { cwd: root });
      if (untracked.length) await git.ok(["clean", "-f", "-q", "--", ...untracked], { cwd: root });
    });
  };

  const commit = async (opts = {}) => {
    if (!root) return;
    // Called as a click handler too: an event is not options.
    if (opts instanceof Event) opts = {};
    if (opts.amend) {
      if ((await git.run(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, quiet: true })).code !== 0) return ctx.window.showInfo("There is no commit to amend yet.");
      if (groups(status).merge.length) return ctx.window.showWarning("Resolve the merge conflicts first.");
      await op("Amending…", async () => {
        const args = ["commit", "--amend"];
        if (message.trim()) args.push("-F", "-");
        else args.push("--no-edit");
        await git.ok(args, { cwd: root, stdin: message.trim() ? message : undefined });
        message = "";
      });
      return;
    }
    const g = groups(status);
    if (g.merge.length) return ctx.window.showWarning("Resolve the merge conflicts first.");
    if (!g.staged.length) {
      if (!g.changes.length && !g.untracked.length) return ctx.window.showInfo("There are no changes to commit.");
      // VS Code's smart commit: with nothing staged, every change is staged, without asking.
      await git.ok(["add", "-A"], { cwd: root });
      // As in VS Code: they show as Staged Changes while the message is being written.
      if (!message.trim()) await refresh();
    }
    if (!message.trim()) return editMessage(opts);
    let done = false;
    await op("Committing…", async () => {
      await git.ok(["commit", "-F", "-"], { cwd: root, stdin: message });
      message = "";
      done = true;
    });
    if (done && opts.then === "push") await sync("push");
    else if (done && opts.then === "sync") await ctx.commands.execute("git.sync");
  };

  // ---------- commit message in an editor ----------
  // Like VS Code (git's own COMMIT_EDITMSG): Commit with an empty box opens the message in a tab,
  // with git's status as comments; the tab's ✓ commits, its ✕ gives up.
  let pending = null; // { path, opts }
  const commentPrefix = /^#/;
  const editMessage = async (opts) => {
    try {
      const gitDir = (await git.ok(["rev-parse", "--absolute-git-dir"], { cwd: root })).trim();
      const path = `${gitDir}/COMMIT_EDITMSG`;
      const st = await git.ok(["-c", "color.status=never", "-c", "advice.statusHints=false", "status"], { cwd: root });
      const comments = [
        "Please enter the commit message for your changes. Lines starting",
        "with '#' will be ignored, and an empty message aborts the commit.",
        "",
        ...st.replace(/\n+$/, "").split("\n"),
        "",
      ].map((l) => (l ? `# ${l}` : "#"));
      // Already open from an earlier try: close it first (while nothing is pending), then show
      // what is on disk now.
      if (pending) pending.closing = true;
      pending = null;
      const open = ctx.editor.all().find((d) => d.path === path);
      if (open && !(await ctx.editor.close(open.id))) return;
      await ctx.fs.writeText(path, `\n${comments.join("\n")}\n`);
      pending = { path, opts };
      await ctx.editor.open(path, { line: 1, column: 1, preview: false });
      ctx.editor.refreshTitleActions();
    } catch (e) {
      ctx.window.showError(`Git: ${String(e.message ?? e)}`);
    }
  };
  const isPending = (info) => !!(pending && info?.path === pending.path);
  const messageFrom = (text) => text.split("\n").filter((l) => !commentPrefix.test(l)).join("\n").trim();
  // Like VS Code, closing the tab is what commits: with the saved message, or, when it is empty,
  // not at all (and a note says so).
  const onMessageClosed = async () => {
    const p = pending;
    pending = null;
    ctx.editor.refreshTitleActions();
    if (p.cancelled) return ctx.window.showInfo("Commit operation was cancelled.");
    let text = "";
    try {
      text = (await ctx.fs.readText(p.path)).text;
    } catch {}
    const msg = messageFrom(text);
    if (!msg) return ctx.window.showInfo("Commit operation was cancelled due to empty commit message.");
    message = msg;
    await commit(p.opts);
  };
  // The message saves as it is typed, so closing the tab never asks to save: it just commits.
  ctx.editor.onDidChangeContent((info) => {
    if (isPending(info)) ctx.editor.save(info.id);
  });
  ctx.editor.onDidChangeEditors(() => {
    if (pending && !pending.closing && !ctx.editor.all().some((d) => d.path === pending.path)) onMessageClosed();
  });
  const closePending = async (cancelled) => {
    if (!pending) return;
    const info = ctx.editor.all().find((d) => d.path === pending.path);
    if (!info) return onMessageClosed();
    pending.cancelled = cancelled;
    // Save first, so closing neither asks nor loses the message.
    if (info.dirty) await ctx.editor.save(info.id);
    pending.closing = true;
    const closed = await ctx.editor.close(info.id);
    if (pending) pending.closing = false;
    if (closed !== false && pending) await onMessageClosed();
  };
  const acceptMessage = () => closePending(false);
  ctx.editor.addTitleAction?.({ id: "acceptCommitMessage", icon: "check", title: "Commit", order: 1, when: isPending, run: () => acceptMessage() });
  ctx.editor.addTitleAction?.({ id: "discardCommitMessage", icon: "discard", title: "Cancel Commit", order: 2, when: isPending, run: () => closePending(true) });

  const commitMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    ctx.window.contextMenu(r.right + 4, r.top, [
      { label: "Commit", disabled: !!busy, run: () => commit() },
      { label: "Commit (Amend)", disabled: !!busy, run: () => commit({ amend: true }) },
      { separator: true, label: "" },
      { label: "Commit & Push", disabled: !!busy, run: () => commit({ then: "push" }) },
      { label: "Commit & Sync", disabled: !!busy, run: () => commit({ then: "sync" }) },
    ]);
  };

  const sync = async (kind) => {
    if (!root) return;
    await op(kind === "fetch" ? "Fetching…" : kind === "pull" ? "Pulling…" : "Pushing…", async () => {
      if (kind === "fetch") await git.ok(["fetch", "--prune"], { cwd: root });
      else if (kind === "pull") await git.ok(["pull", "--ff-only"], { cwd: root });
      else if (status?.upstream) await git.ok(["push"], { cwd: root });
      else {
        const remotes = (await git.ok(["remote"], { cwd: root })).split("\n").filter(Boolean);
        if (!remotes.length) throw new Error("This repository has no remote to publish to.");
        const remote = remotes.includes("origin") ? "origin" : remotes[0];
        await git.ok(["push", "-u", remote, status.branch], { cwd: root });
      }
    });
  };

  const stash = () => op("Stashing…", () => git.ok(["stash", "push", "--include-untracked"], { cwd: root }));
  const stashPop = () => op("Popping stash…", () => git.ok(["stash", "pop"], { cwd: root }));
  const undoCommit = async () => {
    if (!root) return;
    if (!(await ctx.window.confirm("Undo the last commit?", "Its changes go back to Staged Changes.", "Undo Commit"))) return;
    await op("Undoing commit…", () => git.ok(["reset", "--soft", "HEAD~1"], { cwd: root }));
  };

  // The view's "…", as in VS Code: the repository's operations, grouped (a flat menu: no submenus).
  const moreMenu = (e) => {
    const g = status ? groups(status) : null;
    const unstaged = g ? [...g.changes, ...g.untracked] : [];
    const r = e?.currentTarget?.getBoundingClientRect?.();
    const x = r ? r.left : e?.clientX ?? 0;
    const y = r ? r.bottom + 4 : e?.clientY ?? 0;
    const no = !root || !!busy;
    ctx.window.contextMenu(x, y, [
      { label: "Pull", disabled: no || !status?.upstream, run: () => sync("pull") },
      { label: "Push", disabled: no, run: () => sync("push") },
      { label: "Fetch", disabled: no, run: () => sync("fetch") },
      { label: "Sync", disabled: no, run: () => ctx.commands.execute("git.sync") },
      { separator: true, label: "" },
      { label: "Checkout to…", disabled: no, run: checkout },
      { label: "Create Branch…", disabled: no, run: createBranch },
      { separator: true, label: "" },
      { label: "Commit", disabled: no, run: commit },
      { label: "Undo Last Commit", disabled: no, run: undoCommit },
      { separator: true, label: "" },
      { label: "Stage All Changes", disabled: no || !unstaged.length, run: () => stage(unstaged.map((f) => f.path)) },
      { label: "Unstage All Changes", disabled: no || !g?.staged.length, run: () => unstage(g.staged.map((f) => f.path)) },
      { label: "Discard All Changes", disabled: no || !unstaged.length, run: () => discard(unstaged) },
      { separator: true, label: "" },
      { label: "Stash", disabled: no || !status?.files.length, run: stash },
      { label: "Pop Latest Stash", disabled: no, run: stashPop },
      { separator: true, label: "" },
      { label: "Refresh", run: refresh },
    ]);
  };

  const checkout = async () => {
    if (!root) return;
    const out = await git.ok(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:relative)\t%(refname)", "refs/heads", "refs/remotes"], { cwd: root });
    const items = [
      { label: "Create new branch…", icon: "add", action: "create" },
      ...out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [name, sha, when, ref] = l.split("\t");
          return { label: name, description: `${sha} · ${when}${ref.startsWith("refs/remotes") ? " · remote" : ""}`, icon: ref.startsWith("refs/remotes") ? "cloud" : "source-control", ref, name };
        })
        .filter((i) => !i.name.endsWith("/HEAD")),
    ];
    const choice = await ctx.window.showQuickPick(items, { placeholder: "Select a branch to checkout", matchDescription: true });
    if (!choice) return;
    if (choice.action === "create") return createBranch();
    if (choice.ref.startsWith("refs/remotes/")) {
      const local = choice.name.split("/").slice(1).join("/");
      return op("Checking out…", () => git.ok(["checkout", "-b", local, "--track", choice.name], { cwd: root }));
    }
    return op("Checking out…", () => git.ok(["checkout", choice.name], { cwd: root }));
  };

  const createBranch = async () => {
    const name = await ctx.window.showInputBox({ prompt: "Name of the new branch", placeholder: "feature/x", validate: (v) => (/^[^\s~^:?*\[\\]+$/.test(v) && !v.startsWith("-") ? null : "Not a valid branch name") });
    if (name) await op("Creating branch…", () => git.ok(["checkout", "-b", name], { cwd: root }));
  };

  // ---------- diffs ----------

  const headCache = new Map(); // "ref:path" -> text | null
  const show = async (ref, path) => {
    const key = `${ref}:${path}`;
    if (headCache.has(key)) return headCache.get(key);
    const r = await git.run(["show", `${ref}:${path}`], { cwd: root, quiet: true });
    const text = r.code === 0 ? r.stdout : null;
    headCache.set(key, text);
    return text;
  };

  const workingText = async (abs) => {
    const open = ctx.editor.getText(abs);
    if (open !== undefined) return open;
    try {
      const f = await ctx.fs.readText(abs);
      return f.binary ? null : f.text;
    } catch {
      return "";
    }
  };

  const openDiff = async (file) => {
    const abs = `${root}/${file.path}`;
    const staged = file.kind === "staged";
    const original = file.untracked ? "" : staged ? (await show("HEAD", file.from ?? file.path)) ?? "" : (await show("", file.path)) ?? (await show("HEAD", file.path)) ?? "";
    const modified = staged ? (await show("", file.path)) ?? "" : file.letter === "D" ? "" : await workingText(abs);
    if (modified === null) return ctx.window.showInfo(`${file.path} is a binary file.`);
    const language = monaco.languages.getLanguages().find((l) => (l.extensions ?? []).some((e) => file.path.toLowerCase().endsWith(e)))?.id ?? "plaintext";
    ctx.editor.openCustom({
      title: `${basename(file.path)} (${staged ? "Index" : file.untracked ? "Untracked" : "Working Tree"})`,
      icon: "diff",
      key: `git-diff:${file.kind}:${file.path}`,
      render: (el) => {
        const bar = h(
          "div",
          { class: "proposal-bar" },
          icon("source-control"),
          h("div", { class: "what" }, h("b", null, file.path), h("span", { class: "muted" }, staged ? "  HEAD ↔ index" : "  index ↔ working tree")),
          file.letter !== "D" ? h("button", { class: "btn secondary", onclick: () => ctx.editor.open(abs) }, icon("go-to-file"), "Open File") : null,
          staged
            ? h("button", { class: "btn secondary", onclick: () => unstage([file.path]) }, icon("remove"), "Unstage")
            : h("button", { class: "btn", onclick: () => stage([file.path]) }, icon("add"), "Stage"),
        );
        const host = h("div", { class: "proposal-diff" });
        el.append(h("div", { class: "proposal" }, bar, host));
        const a = monaco.editor.createModel(original, language);
        const b = monaco.editor.createModel(modified, language);
        const diff = monaco.editor.createDiffEditor(host, { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, minimap: { enabled: false }, disableLayerHinting: true });
        diff.setModel({ original: a, modified: b });
        return { dispose: () => { diff.dispose(); a.dispose(); b.dispose(); } };
      },
    });
  };

  // ---------- gutter ----------

  const editor = ctx.editor.monacoEditor();
  const decorations = editor.createDecorationsCollection();
  let gutterTimer;
  const updateGutter = () => {
    clearTimeout(gutterTimer);
    gutterTimer = setTimeout(async () => {
      const active = ctx.editor.active();
      const model = editor.getModel();
      if (!root || !active?.path || !model || !active.path.startsWith(root + "/")) return decorations.clear();
      const rel = active.path.slice(root.length + 1);
      const base = await show("HEAD", rel);
      if (editor.getModel() !== model) return;
      const current = model.getValue();
      if (base === null) {
        // New file: every line is added.
        return decorations.set([{ range: new monaco.Range(1, 1, model.getLineCount(), 1), options: { isWholeLine: true, linesDecorationsClassName: "git-gutter-added" } }]);
      }
      if (base.length + current.length > 3_000_000) return decorations.clear();
      const changes = lineChanges(base.replace(/\r\n/g, "\n"), current.replace(/\r\n/g, "\n"));
      if (!changes) return decorations.clear();
      const deco = (from, to, cls) => ({ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, linesDecorationsClassName: cls, overviewRuler: { color: cls === "git-gutter-added" ? "#2ea04399" : cls === "git-gutter-modified" ? "#0078d499" : "#f8514999", position: monaco.editor.OverviewRulerLane.Left } } });
      decorations.set([
        ...changes.added.map(([a, b]) => deco(a, b, "git-gutter-added")),
        ...changes.modified.map(([a, b]) => deco(a, b, "git-gutter-modified")),
        ...changes.deleted.map((l) => deco(Math.min(l, model.getLineCount()), Math.min(l, model.getLineCount()), "git-gutter-deleted")),
      ]);
    }, 250);
  };

  // ---------- view ----------

  const fileRow = (file) => {
    const abs = `${root}/${file.path}`;
    const actions = [];
    if (file.letter !== "D") actions.push(iconButton("go-to-file", "Open File", (e) => { e.stopPropagation(); ctx.editor.open(abs); }));
    if (file.kind === "staged") actions.push(iconButton("remove", "Unstage Changes", (e) => { e.stopPropagation(); unstage([file.path]); }));
    else {
      actions.push(iconButton("discard", file.untracked ? "Delete File" : "Discard Changes", (e) => { e.stopPropagation(); discard([file]); }));
      actions.push(iconButton("add", "Stage Changes", (e) => { e.stopPropagation(); stage([file.path]); }));
    }
    return h(
      "div",
      { class: `list-row${file.letter === "D" ? " deleted" : ""}`, style: { paddingLeft: "20px" }, title: `${file.path}${file.from ? ` ← ${file.from}` : ""}`, onclick: () => openDiff(file) },
      ctx.ui.fileIconEl ? ctx.ui.fileIconEl(basename(file.path)) : icon(fileIcon(file.path)),
      // One label for name and folder, cut once at its end: the name stays whole while it fits.
      h(
        "span",
        { class: "scm-label" },
        h("span", { class: "name" }, basename(file.path)),
        dirname(file.path) === file.path ? null : h("span", { class: "hint" }, dirname(file.path)),
      ),
      h("span", { class: "row-actions" }, actions),
      h("span", { class: `letter l-${file.letter}` }, file.letter),
    );
  };

  const section = (id, title, files, actions) => {
    if (!files.length) return null;
    const closed = collapsed.has(id);
    return h(
      "div",
      null,
      h(
        "div",
        { class: "section-header", onclick: () => { closed ? collapsed.delete(id) : collapsed.add(id); render(); } },
        icon(closed ? "chevron-right" : "chevron-down"),
        h("span", null, title),
        h("div", { class: "actions", onclick: (e) => e.stopPropagation() }, actions),
        h("span", { class: "count" }, String(files.length)),
      ),
      closed ? null : files.map(fileRow),
    );
  };

  const render = () => {
    if (!view) return;
    clear(view);
    const folder = ctx.workspace.folder();
    if (!folder) {
      view.append(h("div", { class: "pad stack" }, h("div", null, "Open a folder to use source control."), ctx.commands.exists("explorer.openFolder") ? h("button", { class: "btn block", onclick: () => ctx.commands.execute("explorer.openFolder") }, "Open Folder") : null));
      return;
    }
    if (!root || !status) {
      view.append(h("div", { class: "pad stack" }, h("div", null, "The folder currently open doesn't have a git repository."), h("button", { class: "btn block", onclick: () => op("Initializing…", () => git.ok(["init"], { cwd: folder })) }, "Initialize Repository")));
      return;
    }
    const g = groups(status);
    const textarea = h("textarea", {
      class: "input",
      rows: 1,
      placeholder: `Message (⌘Enter to commit on "${status.branch}")`,
      value: message,
      oninput: (e) => {
        message = e.target.value;
        e.target.style.height = "auto";
        e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
      },
      onkeydown: (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      },
    });
    const unstagedAll = [...g.changes, ...g.untracked];
    view.append(
      h(
        "div",
        { class: "scm" },
        h("div", { class: "scm-input" }, textarea, h(
          "div",
          { class: "scm-commit" },
          h("button", { class: "btn commit-main", disabled: !!busy, onclick: () => commit() }, icon(busy ? "loading" : "check", busy ? "codicon-modifier-spin" : ""), busy || "Commit"),
          h("button", { class: "btn commit-more", title: "More Actions…", disabled: !!busy, onclick: commitMenu }, icon("chevron-down")),
        )),
        section("merge", "Merge Changes", g.merge, [iconButton("add", "Stage All Merge Changes", () => stage(g.merge.map((f) => f.path)))]),
        section("staged", "Staged Changes", g.staged, [iconButton("remove", "Unstage All Changes", () => unstage(g.staged.map((f) => f.path)))]),
        section("changes", "Changes", unstagedAll, [
          iconButton("discard", "Discard All Changes", () => discard(unstagedAll)),
          iconButton("add", "Stage All Changes", () => stage(unstagedAll.map((f) => f.path))),
        ]),
        !status.files.length ? h("div", { class: "pad muted" }, "No changes.") : null,
      ),
    );
  };

  ctx.views.provide("scm", {
    actions: [
      { icon: "check", title: "Commit", run: commit },
      { icon: "refresh", title: "Refresh", run: refresh },
      { icon: "ellipsis", title: "More Actions…", run: (e) => moreMenu(e) },
    ],
    render: (el) => {
      view = el;
      render();
    },
    onShow: () => refresh(),
  });

  ctx.commands.register("git.refresh", refresh);
  ctx.commands.register("git.commit", commit);
  ctx.commands.register("git.stageAll", () => status && stage(status.files.map((f) => f.path)));
  ctx.commands.register("git.unstageAll", () => status && unstage(groups(status).staged.map((f) => f.path)));
  ctx.commands.register("git.checkout", checkout);
  ctx.commands.register("git.createBranch", createBranch);
  ctx.commands.register("git.fetch", () => sync("fetch"));
  ctx.commands.register("git.pull", () => sync("pull"));
  ctx.commands.register("git.push", () => sync("push"));
  ctx.commands.register("git.sync", async () => {
    if (!status?.upstream) return sync("push");
    if (status.behind) await sync("pull");
    if (status?.ahead) await sync("push");
    if (!status?.ahead && !status?.behind) await sync("fetch");
  });
  ctx.commands.register("git.acceptCommitMessage", acceptMessage);
  ctx.commands.register("git.stash", stash);
  ctx.commands.register("git.stashPop", stashPop);
  ctx.commands.register("git.undoCommit", undoCommit);
  ctx.commands.register("git.init", () => ctx.workspace.folder() && op("Initializing…", () => git.ok(["init"], { cwd: ctx.workspace.folder() })));
  ctx.commands.register("git.stageActive", () => {
    const p = ctx.editor.active()?.path;
    if (!root || !p?.startsWith(root + "/")) return ctx.window.showInfo("The active file is not in a git repository.");
    return stage([p.slice(root.length + 1)]);
  });
  ctx.commands.register("git.openChange", () => {
    const active = ctx.editor.active();
    const file = status?.files.find((f) => `${root}/${f.path}` === active?.path);
    if (!file) return ctx.window.showInfo("The active file has no changes.");
    const g = groups(status);
    openDiff([...g.changes, ...g.untracked, ...g.staged].find((f) => f.path === file.path));
  });

  // The tab bar's "Open Changes", as in VS Code: only while the active file has changes.
  ctx.editor.addTitleAction?.({
    id: "openChange",
    icon: "compare-changes",
    title: "Open Changes",
    order: 20,
    when: (info) => !!(info.path && root && status?.files.some((f) => `${root}/${f.path}` === info.path)),
    run: () => ctx.commands.execute("git.openChange"),
  });

  ctx.workspace.onDidChangeFolder(refresh);
  ctx.editor.onDidSave(refresh);
  ctx.editor.onDidChangeActive(updateGutter);
  ctx.editor.onDidChangeContent(updateGutter);
  // Coming back to the window is when files most often changed behind our back.
  const onFocus = () => refresh();
  window.addEventListener("focus", onFocus);
  ctx.subscriptions.push({ dispose: () => window.removeEventListener("focus", onFocus) });

  await refresh();
  return { refresh, status: () => status, root: () => root };
}
