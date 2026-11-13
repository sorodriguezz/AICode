// Source Control: git for the open folder — changes, commits, branches, diffs and gutter markers.

import { makeGit, parseStatus, groups, lineChanges, decorationMap, LOG_FORMAT, parseLog, layoutGraph, parseNameStatus } from "./git.js";

const STYLE = `
.scm { position: relative; padding: 6px 0 12px; }
/* While an operation runs (fetch, pull, push, commit…): VS Code's thin sliding bar at the view's top. */
.scm-progress { position: absolute; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; pointer-events: none; }
.scm-progress::before {
  content: ""; position: absolute; top: 0; bottom: 0; width: 30%;
  background: var(--aicode-progressBar-background, var(--aicode-focusBorder));
  animation: scm-progress 1.2s ease-in-out infinite;
}
@keyframes scm-progress { from { left: -30%; } to { left: 100%; } }
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
/* Tree view: folder rows. */
.scm .scm-dir .codicon { flex: 0 0 auto; }
/* The graph (VS Code's Source Control Graph): lanes, the subject, its author, and the refs at the end. */
.scm-graph {
  --git-lane-0: var(--aicode-scmGraph-foreground1, #59a4f9); --git-lane-1: var(--aicode-scmGraph-foreground2, #b180d7);
  --git-lane-2: var(--aicode-scmGraph-foreground3, #ffb000); --git-lane-3: var(--aicode-scmGraph-foreground4, #40b0a6);
  --git-lane-4: var(--aicode-scmGraph-foreground5, #dc267f); --git-lane-5: #e2c08d;
  margin-top: 6px;
}
.scm-graph .list-row { gap: 4px; padding-left: 4px; }
.scm-graph .graph-lanes { flex: 0 0 auto; height: 100%; overflow: visible; }
.scm-graph .graph-text { display: flex; gap: 6px; align-items: baseline; flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; }
/* Short of room, the author gives way first (down to nothing), then the subject. */
.scm-graph .subject { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 40px; }
.scm-graph .author { color: var(--aicode-descriptionForeground); font-size: 12px; flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.scm-graph .graph-row.head .subject { font-weight: 600; }
.scm-graph .graph-row.open { background: var(--aicode-list-inactiveSelectionBackground, var(--aicode-list-hoverBackground)); }
.scm-graph .ref-pills { display: flex; gap: 3px; flex: 0 0 auto; margin-left: 4px; }
/* Icon-only pills are round; the current branch's carries its name (cut only past 120px). */
.scm-graph .ref-pill {
  display: inline-flex; align-items: center; justify-content: center; gap: 3px; height: 18px; min-width: 18px; padding: 0 3px; border-radius: 9px; flex: 0 0 auto;
  box-sizing: border-box; font-size: 11px; line-height: 18px; color: #fff; white-space: nowrap;
}
.scm-graph .ref-pill.current { padding: 0 7px 0 4px; }
.scm-graph .ref-pill > span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.scm-graph .ref-pill .codicon { font-size: 12px; flex: 0 0 auto; }
.scm-graph .ref-pill.local { background: var(--aicode-scmGraph-historyItemRefColor, #3b82c4); }
.scm-graph .ref-pill.remote { background: var(--aicode-scmGraph-historyItemRemoteRefColor, #8d6bbd); }
.scm-graph .ref-pill.tag { background: var(--aicode-badge-background); color: var(--aicode-badge-foreground); }
.scm-graph .graph-file { gap: 6px; }
.scm-graph .graph-file .letter { margin-left: auto; }
.scm-graph .graph-more { color: var(--aicode-textLink-foreground); gap: 6px; padding-left: 12px; }
/* "Show Git Output". */
.git-output { margin: 0; padding: 10px 14px; height: 100%; overflow: auto; box-sizing: border-box; font: 12px/1.5 var(--aicode-editor-font-family, ui-monospace, Menlo, monospace); white-space: pre-wrap; user-select: text; -webkit-user-select: text; }
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
  // "Show Git Output": every git command this mod ran, with how long it took and what it said.
  const output = [];
  const outputWatchers = new Set();
  const git = makeGit(ctx, (args, code, stderr, ms) => {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    output.push(`${t} > git ${args.join(" ")} [${ms}ms]${code ? ` (exit ${code})` : ""}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
    if (output.length > 3000) output.splice(0, 1000);
    outputWatchers.forEach((f) => f());
  });
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
  /** The running operation talks to the remote (fetch, pull, push): the sync icon turns. */
  let busyRemote = false;
  const collapsed = new Set();
  // View & Sort, as VS Code: the changes as a list (each with its folder) or a tree of folders.
  let viewMode = await ctx.settings.get("viewMode", "list"); // "list" | "tree"
  let sortBy = await ctx.settings.get("sortBy", "path"); // "name" | "path" | "status"
  // The graph: the current branch and its upstream (VS Code's "Auto"), newest first.
  const GRAPH_PAGE = 50;
  let graphLimit = GRAPH_PAGE;
  let graph = [];
  let graphLayout = [];
  let graphMore = false;
  let openCommit = null; // { hash, files: [] | null }
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
  let queued = null;
  const refresh = () => {
    if (!refreshing) return (refreshing = doRefresh().finally(() => (refreshing = null)));
    // One is running, with what it read before (say, "Fetching…" while the fetch was still on):
    // run once more after it, so whoever asked now sees the state as it is now.
    return (queued ??= refreshing.catch(() => {}).then(() => {
      queued = null;
      return refresh();
    }));
  };
  const doRefresh = async () => {
    root = await repoFor(ctx.workspace.folder());
    watchRepo();
    if (root) {
      const r = await git.run(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd: root, quiet: true });
      status = r.code === 0 ? parseStatus(r.stdout) : null;
      // Ignored files show faded in the explorer: folders come back whole (node_modules/, not its files).
      const ign = status ? await git.run(["status", "--porcelain=v2", "-z", "--ignored=traditional", "--untracked-files=normal"], { cwd: root, quiet: true }) : null;
      if (status && ign?.code === 0) status.ignored = ign.stdout.split("\0").filter((f) => f.startsWith("! ")).map((f) => f.slice(2).replace(/\/$/, ""));
      if (status && !collapsed.has("graph")) await loadGraph();
    } else status = null;
    if (!status) graph = graphLayout = [];
    headCache.clear();
    lookup = status && root ? decorationMap(status, root) : () => undefined;
    deco.fire();
    paintStatus();
    // Showing the view refreshes it: repaint only when something changed, so it doesn't redraw
    // (and jump) right after it appears.
    const key = JSON.stringify([ctx.workspace.folder(), root, status, busy, [...collapsed], graph.map((c) => [c.hash, c.refs])]);
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
        ? { icon: busyRemote ? "sync~spin" : "sync", text: status.ahead || status.behind ? `${status.behind}↓ ${status.ahead}↑` : "", tooltip: busyRemote ? busy : `${status.upstream} — pull ${status.behind}, push ${status.ahead}` }
        : { icon: busyRemote ? "sync~spin" : "cloud-upload", text: "", tooltip: busyRemote ? busy : "Publish Branch" },
    );
    ctx.views.setBadge("scm", status.files.length);
  };

  // ---------- operations ----------

  const op = async (label, fn, { remote = false } = {}) => {
    if (busy) return; // one at a time: a second click while fetching does nothing
    busy = label;
    busyRemote = remote;
    render();
    paintStatus();
    try {
      await fn();
    } catch (e) {
      ctx.window.showError(`Git: ${String(e.message ?? e)}`);
    } finally {
      busy = "";
      busyRemote = false;
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
    // Commit All: everything is staged first. Commit Staged: only what is staged, never the rest.
    if (opts.all && status?.files.length) {
      await git.ok(["add", "-A"], { cwd: root });
      await refresh();
    }
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
      if (opts.staged) return ctx.window.showInfo("There are no staged changes to commit.");
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
      if (kind === "fetch") await git.ok(["fetch"], { cwd: root });
      else if (kind === "pull") await git.ok(["pull", "--ff-only"], { cwd: root });
      else if (status?.upstream) await git.ok(["push"], { cwd: root });
      else {
        const remotes = (await git.ok(["remote"], { cwd: root })).split("\n").filter(Boolean);
        if (!remotes.length) throw new Error("This repository has no remote to publish to.");
        const remote = remotes.includes("origin") ? "origin" : remotes[0];
        await git.ok(["push", "-u", remote, status.branch], { cwd: root });
      }
    }, { remote: true });
  };

  // ---------- more operations (the "…" menu, VS Code's) ----------

  /** A git operation against a remote: the sync icon turns while it runs. */
  const remoteOp = (label, args) => root && op(label, () => git.ok(args, { cwd: root }), { remote: true });
  const localOp = (label, args) => root && op(label, () => git.ok(args, { cwd: root }));

  const pickRemote = async (placeholder) => {
    const out = await git.ok(["remote", "-v"], { cwd: root });
    const found = new Map();
    for (const l of out.split("\n")) {
      const [name, url] = l.split(/\s+/);
      if (name && !found.has(name)) found.set(name, url);
    }
    if (!found.size) {
      ctx.window.showInfo("This repository has no remotes.", { label: "Add Remote…", run: () => addRemote() });
      return null;
    }
    const c = await ctx.window.showQuickPick([...found].map(([name, url]) => ({ label: name, description: url, icon: "cloud" })), { placeholder });
    return c?.label ?? null;
  };
  const pickRef = async (placeholder, filter = () => true) => {
    const items = (await refItems()).filter(filter);
    // Groups lose their first row to the filter: start a group on the first one left.
    let last = null;
    for (const it of items) {
      const kind = it.ref.split("/")[1];
      if (kind !== last) Object.assign(it, { separator: true, group: { heads: "branches", remotes: "remote branches", tags: "tags" }[kind] });
      else delete it.separator, delete it.group;
      last = kind;
    }
    if (!items.length) {
      ctx.window.showInfo("There is nothing to pick from.");
      return null;
    }
    return ctx.window.showQuickPick(items, { placeholder, matchDescription: true });
  };
  const notCurrent = (it) => it.name !== status?.branch;

  // Pull, Push
  const pullRebase = () => remoteOp("Pulling…", ["pull", "--rebase"]);
  const pullFrom = async () => {
    if (!root) return;
    const remote = await pickRemote("Pick a remote to pull the branch from");
    if (!remote) return;
    const b = await pickRef(`Pick a branch to pull from ${remote}`, (it) => it.ref.startsWith(`refs/remotes/${remote}/`));
    if (b) await remoteOp("Pulling…", ["pull", remote, b.name.slice(remote.length + 1)]);
  };
  const pushTo = async () => {
    if (!root || !status?.branch || status.branch === "(detached)") return ctx.window.showInfo("Check out a branch to push it.");
    const remote = await pickRemote(`Pick a remote to push ${status.branch} to`);
    if (remote) await remoteOp("Pushing…", ["push", ...(status.upstream ? [] : ["-u"]), remote, status.branch]);
  };
  const fetchPrune = () => remoteOp("Fetching…", ["fetch", "--prune"]);
  const fetchAll = () => remoteOp("Fetching…", ["fetch", "--all"]);

  // Branch
  const merge = async () => {
    if (!root) return;
    const b = await pickRef("Select a branch or tag to merge into the current branch", notCurrent);
    if (b) await localOp("Merging…", ["merge", b.name]);
  };
  const rebase = async () => {
    if (!root) return;
    const b = await pickRef("Select a branch to rebase onto", (it) => notCurrent(it) && !it.ref.startsWith("refs/tags/"));
    if (b) await localOp("Rebasing…", ["rebase", b.name]);
  };
  const renameBranch = async () => {
    if (!root || !status?.branch || status.branch === "(detached)") return ctx.window.showInfo("Check out a branch to rename it.");
    const name = await ctx.window.showInputBox({ prompt: "New name of the branch", value: status.branch, validate: validBranch });
    if (name && name !== status.branch) await localOp("Renaming branch…", ["branch", "-m", name]);
  };
  const deleteBranch = async () => {
    if (!root) return;
    const b = await pickRef("Select a branch to delete", (it) => it.ref.startsWith("refs/heads/") && notCurrent(it));
    if (!b) return;
    const r = await git.run(["branch", "-d", b.name], { cwd: root });
    if (r.code === 0) return refresh();
    if (/not fully merged/.test(r.stderr) && (await ctx.window.confirm(`The branch "${b.name}" is not fully merged. Delete it anyway?`, "Its commits that are on no other branch are lost.", "Delete Branch")))
      await localOp("Deleting branch…", ["branch", "-D", b.name]);
    else if (!/not fully merged/.test(r.stderr)) ctx.window.showError(`Git: ${r.stderr.trim()}`);
  };
  const publishBranch = async () => {
    if (!root || !status?.branch || status.branch === "(detached)") return ctx.window.showInfo("Check out a branch to publish it.");
    if (status.upstream) return ctx.window.showInfo(`${status.branch} is already published to ${status.upstream}.`);
    const remote = await pickRemote(`Pick a remote to publish ${status.branch} to`);
    if (remote) await remoteOp("Publishing…", ["push", "-u", remote, status.branch]);
  };

  // Remote
  const addRemote = async () => {
    if (!root) return;
    const url = (await ctx.window.showInputBox({ prompt: "URL of the remote repository", placeholder: "https://github.com/owner/repo.git" }))?.trim();
    if (!url) return;
    const taken = (await git.ok(["remote"], { cwd: root })).split("\n").filter(Boolean);
    const name = (await ctx.window.showInputBox({
      prompt: "Name of the remote",
      value: taken.includes("origin") ? "" : "origin",
      validate: (v) => (!/^[^\s~^:?*\[\\]+$/.test(v) ? "Not a valid remote name" : taken.includes(v) ? `A remote named ${v} already exists` : null),
    }))?.trim();
    if (!name) return;
    await localOp("Adding remote…", ["remote", "add", name, url]);
    await remoteOp("Fetching…", ["fetch", name]);
  };
  const removeRemote = async () => {
    if (!root) return;
    const remote = await pickRemote("Pick a remote to remove");
    if (remote && (await ctx.window.confirm(`Remove the remote "${remote}"?`, "Its remote branches go too. The repository it points to is not touched.", "Remove")))
      await localOp("Removing remote…", ["remote", "remove", remote]);
  };

  // Stash
  const stashWith = async (extra) => {
    if (!root) return;
    // Like VS Code: an optional message (Enter leaves it out; Escape gives up).
    const msg = await ctx.window.showInputBox({ prompt: "Stash message (optional; press Enter to skip)", placeholder: "Message" });
    if (msg === undefined) return;
    await localOp("Stashing…", ["stash", "push", ...extra, ...(msg.trim() ? ["-m", msg.trim()] : [])]);
  };
  const stash = () => stashWith([]);
  const stashUntracked = () => stashWith(["--include-untracked"]);
  const stashStaged = () => stashWith(["--staged"]);
  const pickStash = async (placeholder) => {
    const out = await git.ok(["stash", "list", "--format=%gd%x00%s%x00%cr"], { cwd: root });
    const items = out.split("\n").filter(Boolean).map((l) => {
      const [ref, subject, when] = l.split("\0");
      return { label: `#${ref.match(/\{(\d+)\}/)?.[1] ?? "?"}: ${subject}`, description: when, icon: "archive", ref };
    });
    if (!items.length) {
      ctx.window.showInfo("There are no stashes in the repository.");
      return null;
    }
    return ctx.window.showQuickPick(items, { placeholder });
  };
  const applyStash = async (pop, latest) => {
    if (!root) return;
    const s = latest ? { ref: "stash@{0}" } : await pickStash(pop ? "Pick a stash to pop" : "Pick a stash to apply");
    if (s) await localOp(pop ? "Popping stash…" : "Applying stash…", ["stash", pop ? "pop" : "apply", s.ref]);
  };
  const stashPop = () => applyStash(true, true);
  const dropStash = async () => {
    if (!root) return;
    const s = await pickStash("Pick a stash to drop");
    if (s && (await ctx.window.confirm(`Drop the stash ${s.label}?`, "This cannot be undone.", "Drop Stash"))) await localOp("Dropping stash…", ["stash", "drop", s.ref]);
  };
  const dropAllStashes = async () => {
    if (!root) return;
    const n = (await git.ok(["stash", "list"], { cwd: root })).split("\n").filter(Boolean).length;
    if (!n) return ctx.window.showInfo("There are no stashes in the repository.");
    if (await ctx.window.confirm(`Drop all ${n} stash${n === 1 ? "" : "es"}?`, "This cannot be undone.", "Drop All")) await localOp("Dropping stashes…", ["stash", "clear"]);
  };
  const viewStash = async () => {
    if (!root) return;
    const s = await pickStash("Pick a stash to view");
    if (!s) return;
    const hash = (await git.ok(["rev-parse", s.ref], { cwd: root })).trim();
    const files = parseNameStatus(await git.ok(["diff", "--name-status", "-z", "-M", `${hash}^1`, hash], { cwd: root }));
    if (!files.length) return ctx.window.showInfo("That stash changes no tracked files.");
    const f = await ctx.window.showQuickPick(files.map((x) => ({ label: basename(x.path), description: dirname(x.path) === x.path ? x.letter : `${dirname(x.path)} · ${x.letter}`, fileIcon: basename(x.path), file: x })), { placeholder: `${s.label} — pick a file to see its changes`, matchDescription: true });
    if (f) await openCommitDiff({ hash, parents: [`${hash}^1`], subject: s.label }, f.file);
  };

  // Tags
  const createTag = async () => {
    if (!root) return;
    const name = (await ctx.window.showInputBox({ prompt: "Tag name", placeholder: "v1.0.0", validate: (v) => (/^[^\s~^:?*\[\\]+$/.test(v) && !v.startsWith("-") ? null : "Not a valid tag name") }))?.trim();
    if (!name) return;
    const msg = await ctx.window.showInputBox({ prompt: "Tag message (optional; press Enter for a lightweight tag)", placeholder: "Message" });
    if (msg === undefined) return;
    await localOp("Tagging…", msg.trim() ? ["tag", "-a", name, "-m", msg.trim()] : ["tag", name]);
  };
  const deleteTag = async () => {
    if (!root) return;
    const t = await pickRef("Select a tag to delete", (it) => it.ref.startsWith("refs/tags/"));
    if (t) await localOp("Deleting tag…", ["tag", "-d", t.name]);
  };
  const deleteRemoteTag = async () => {
    if (!root) return;
    const remote = await pickRemote("Pick a remote to delete the tag from");
    if (!remote) return;
    const out = await git.ok(["ls-remote", "--tags", "--refs", remote], { cwd: root });
    const tags = out.split("\n").filter(Boolean).map((l) => l.split("\t")[1].replace("refs/tags/", ""));
    if (!tags.length) return ctx.window.showInfo(`${remote} has no tags.`);
    const t = await ctx.window.showQuickPick(tags.map((x) => ({ label: x, icon: "tag" })), { placeholder: `Select a tag to delete from ${remote}` });
    if (t && (await ctx.window.confirm(`Delete the tag "${t.label}" from ${remote}?`, "Others who fetched it keep their copy.", "Delete Tag")))
      await remoteOp("Deleting remote tag…", ["push", remote, "--delete", `refs/tags/${t.label}`]);
  };
  const pushTags = () => remoteOp("Pushing tags…", ["push", "--tags"]);

  // Clone (works with no repository open)
  const clone = async () => {
    const url = (await ctx.window.showInputBox({ prompt: "Repository URL", placeholder: "https://github.com/owner/repo.git" }))?.trim();
    if (!url) return;
    const parent = await ctx.window.pickFolder();
    if (!parent) return;
    const name = url.replace(/\/+$/, "").split(/[/:]/).pop().replace(/\.git$/, "") || "repository";
    const dest = `${parent}/${name}`;
    let ok = false;
    await op("Cloning…", async () => {
      await git.ok(["clone", url, dest], { cwd: parent });
      ok = true;
    }, { remote: true });
    if (ok) ctx.window.showInfo(`Cloned ${name}.`, { label: "Open", run: () => ctx.workspace.setFolder(dest) });
  };

  const showOutput = () =>
    ctx.editor.openCustom({
      title: "Git Output",
      icon: "output",
      key: "git-output",
      render: (el) => {
        const pre = h("pre", { class: "git-output" });
        const paint = () => {
          const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
          pre.textContent = output.join("\n") || "No git commands have run yet.";
          if (atEnd) pre.scrollTop = pre.scrollHeight;
        };
        el.append(pre);
        paint();
        pre.scrollTop = pre.scrollHeight;
        outputWatchers.add(paint);
        return { dispose: () => outputWatchers.delete(paint) };
      },
    });

  const setView = (mode) => {
    viewMode = mode;
    ctx.settings.set("viewMode", mode);
    render();
  };
  const setSort = (by) => {
    sortBy = by;
    ctx.settings.set("sortBy", by);
    render();
  };
  const undoCommit = async () => {
    if (!root) return;
    if (!(await ctx.window.confirm("Undo the last commit?", "Its changes go back to Staged Changes.", "Undo Commit"))) return;
    await op("Undoing commit…", () => git.ok(["reset", "--soft", "HEAD~1"], { cwd: root }));
  };

  // The view's "…", as in VS Code: the common ones first, the rest in submenus.
  const moreMenu = (e) => {
    const g = status ? groups(status) : null;
    const unstaged = g ? [...g.changes, ...g.untracked] : [];
    const r = e?.currentTarget?.getBoundingClientRect?.();
    const x = r ? r.left : e?.clientX ?? 0;
    const y = r ? r.bottom + 4 : e?.clientY ?? 0;
    const no = !root || !!busy;
    const sep = { separator: true, label: "" };
    ctx.window.contextMenu(x, y, [
      viewMode === "tree" ? { label: "View as List", run: () => setView("list") } : { label: "View as Tree", run: () => setView("tree") },
      sep,
      {
        label: "View & Sort",
        submenu: [
          { label: "View as List", checked: viewMode === "list", run: () => setView("list") },
          { label: "View as Tree", checked: viewMode === "tree", run: () => setView("tree") },
          sep,
          { label: "Sort Changes by Name", checked: sortBy === "name", run: () => setSort("name") },
          { label: "Sort Changes by Path", checked: sortBy === "path", run: () => setSort("path") },
          { label: "Sort Changes by Status", checked: sortBy === "status", run: () => setSort("status") },
        ],
      },
      sep,
      { label: "Pull", disabled: no || !status?.upstream, run: () => sync("pull") },
      { label: "Push", disabled: no, run: () => sync("push") },
      { label: "Clone", disabled: !!busy, run: clone },
      { label: "Checkout to…", disabled: no, run: checkout },
      { label: "Fetch", disabled: no, run: () => sync("fetch") },
      sep,
      {
        label: "Commit",
        disabled: no,
        submenu: [
          { label: "Commit", run: () => commit() },
          { label: "Commit Staged", disabled: !g?.staged.length, run: () => commit({ staged: true }) },
          { label: "Commit All", disabled: !status?.files.length, run: () => commit({ all: true }) },
          { label: "Undo Last Commit", run: undoCommit },
          sep,
          { label: "Commit (Amend)", run: () => commit({ amend: true }) },
          { label: "Commit Staged (Amend)", run: () => commit({ amend: true, staged: true }) },
          { label: "Commit All (Amend)", run: () => commit({ amend: true, all: true }) },
          sep,
          { label: "Commit & Push", run: () => commit({ then: "push" }) },
          { label: "Commit & Sync", run: () => commit({ then: "sync" }) },
        ],
      },
      {
        label: "Changes",
        disabled: no,
        submenu: [
          { label: "Stage All Changes", disabled: !unstaged.length, run: () => stage(unstaged.map((f) => f.path)) },
          { label: "Unstage All Changes", disabled: !g?.staged.length, run: () => unstage(g.staged.map((f) => f.path)) },
          { label: "Discard All Changes", disabled: !unstaged.length, run: () => discard(unstaged) },
        ],
      },
      {
        label: "Pull, Push",
        disabled: no,
        submenu: [
          { label: "Sync", run: () => ctx.commands.execute("git.sync") },
          sep,
          { label: "Pull", disabled: !status?.upstream, run: () => sync("pull") },
          { label: "Pull (Rebase)", disabled: !status?.upstream, run: pullRebase },
          { label: "Pull from…", run: pullFrom },
          sep,
          { label: "Push", run: () => sync("push") },
          { label: "Push to…", run: pushTo },
          sep,
          { label: "Fetch", run: () => sync("fetch") },
          { label: "Fetch (Prune)", run: fetchPrune },
          { label: "Fetch From All Remotes", run: fetchAll },
        ],
      },
      {
        label: "Branch",
        disabled: no,
        submenu: [
          { label: "Merge…", run: merge },
          { label: "Rebase Branch…", run: rebase },
          sep,
          { label: "Create Branch…", run: () => createBranch() },
          { label: "Create Branch From…", run: createBranchFrom },
          sep,
          { label: "Rename Branch…", run: renameBranch },
          { label: "Delete Branch…", run: deleteBranch },
          sep,
          { label: "Publish Branch…", disabled: !!status?.upstream, run: publishBranch },
        ],
      },
      {
        label: "Remote",
        disabled: no,
        submenu: [
          { label: "Add Remote…", run: addRemote },
          { label: "Remove Remote", run: removeRemote },
        ],
      },
      {
        label: "Stash",
        disabled: no,
        submenu: [
          { label: "Stash", disabled: !status?.files.length, run: stash },
          { label: "Stash (Include Untracked)", disabled: !status?.files.length, run: stashUntracked },
          { label: "Stash Staged", disabled: !g?.staged.length, run: stashStaged },
          sep,
          { label: "Apply Latest Stash", run: () => applyStash(false, true) },
          { label: "Apply Stash…", run: () => applyStash(false, false) },
          sep,
          { label: "Pop Latest Stash", run: () => applyStash(true, true) },
          { label: "Pop Stash…", run: () => applyStash(true, false) },
          sep,
          { label: "Drop Stash…", run: dropStash },
          { label: "Drop All Stashes…", run: dropAllStashes },
          sep,
          { label: "View Stash…", run: viewStash },
        ],
      },
      {
        label: "Tags",
        disabled: no,
        submenu: [
          { label: "Create Tag", run: createTag },
          { label: "Delete Tag", run: deleteTag },
          { label: "Delete Remote Tag", run: deleteRemoteTag },
          sep,
          { label: "Push Tags", run: pushTags },
        ],
      },
      sep,
      { label: "Show Git Output", run: showOutput },
    ]);
  };

  // ---------- branches ----------

  const validBranch = (v) => (/^[^\s~^:?*\[\\]+$/.test(v) && !v.startsWith("-") && !v.endsWith(".lock") && !v.includes("..") ? null : "Not a valid branch name");

  /** Branches, remote branches and tags as picker rows, VS Code's way: the age after the name, then
   *  "author • hash • subject" under it, and each group named at the right. */
  const refItems = async () => {
    const F = ["%(refname)", "%(refname:short)", "%(objectname:short)", "%(*objectname:short)", "%(creatordate:relative)", "%(authorname)", "%(*authorname)", "%(taggername)", "%(subject)", "%(*subject)"].join("%00");
    const out = await git.ok(["for-each-ref", "--sort=-creatordate", `--format=${F}`, "refs/heads", "refs/remotes", "refs/tags"], { cwd: root });
    const rows = out.split("\n").filter(Boolean).map((l) => {
      const [ref, name, sha, tagSha, when, author, tagAuthor, tagger, subject, tagSubject] = l.split("\0");
      // An annotated tag points at a tag object: show the commit it tags.
      return { ref, name, sha: tagSha || sha, when, who: tagAuthor || author || tagger, subject: tagSubject || subject };
    });
    const kinds = [
      ["refs/heads/", "branches", "git-branch"],
      ["refs/remotes/", "remote branches", "cloud"],
      ["refs/tags/", "tags", "tag"],
    ];
    const items = [];
    for (const [prefix, group, iconName] of kinds) {
      let list = rows.filter((r) => r.ref.startsWith(prefix) && !r.ref.endsWith("/HEAD"));
      if (prefix === "refs/tags/") list = list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      list.forEach((r, i) =>
        items.push({
          label: r.name,
          description: r.when,
          detail: [r.who, r.sha, r.subject].filter(Boolean).join(" • "),
          icon: iconName,
          ref: r.ref,
          name: r.name,
          ...(i === 0 ? { separator: true, group } : {}),
        }),
      );
    }
    return items;
  };

  const checkout = async () => {
    if (!root) return;
    const items = [
      { label: "Create new branch…", icon: "add", action: "create" },
      { label: "Create new branch from…", icon: "add", action: "createFrom" },
      { label: "Checkout detached…", icon: "debug-disconnect", action: "detached" },
      ...(await refItems()),
    ];
    const choice = await ctx.window.showQuickPick(items, { placeholder: "Select a branch or tag to checkout", matchDescription: true });
    if (!choice) return;
    if (choice.action === "create") return createBranch();
    if (choice.action === "createFrom") return createBranchFrom();
    if (choice.action === "detached") return checkoutDetached();
    if (choice.ref.startsWith("refs/remotes/")) {
      const local = choice.name.split("/").slice(1).join("/");
      // Already a local branch by that name: switch to it rather than fail on "already exists".
      const exists = (await git.run(["show-ref", "--verify", "--quiet", `refs/heads/${local}`], { cwd: root, quiet: true })).code === 0;
      return op("Checking out…", () => git.ok(exists ? ["checkout", local] : ["checkout", "-b", local, "--track", choice.name], { cwd: root }));
    }
    // A tag checks out detached, as in VS Code.
    if (choice.ref.startsWith("refs/tags/")) return op("Checking out…", () => git.ok(["checkout", "--detach", choice.name], { cwd: root }));
    return op("Checking out…", () => git.ok(["checkout", choice.name], { cwd: root }));
  };

  const createBranch = async (fromArg) => {
    if (!root) return;
    // From the menu or the command palette this gets an event or nothing: only a ref name counts.
    const from = typeof fromArg === "string" ? fromArg : null;
    const name = await ctx.window.showInputBox({
      prompt: from ? `Name of the new branch (from ${from})` : "Name of the new branch",
      placeholder: "feature/x",
      validate: validBranch,
    });
    if (name) await op("Creating branch…", () => git.ok(["checkout", "-b", name, ...(from ? [from] : [])], { cwd: root }));
  };

  const createBranchFrom = async () => {
    if (!root) return;
    const from = await ctx.window.showQuickPick(await refItems(), { placeholder: "Select a ref to create the branch from", matchDescription: true });
    if (from) await createBranch(from.name);
  };

  const checkoutDetached = async () => {
    if (!root) return;
    const at = await ctx.window.showQuickPick(await refItems(), { placeholder: "Select a ref to checkout in detached mode", matchDescription: true });
    if (at) await op("Checking out…", () => git.ok(["checkout", "--detach", at.name], { cwd: root }));
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
    diffTab({
      title: `${basename(file.path)} (${staged ? "Index" : file.untracked ? "Untracked" : "Working Tree"})`,
      key: `git-diff:${file.kind}:${file.path}`,
      path: file.path,
      what: staged ? "  HEAD ↔ index" : "  index ↔ working tree",
      original,
      modified,
      buttons: () => [
        file.letter !== "D" ? h("button", { class: "btn secondary", onclick: () => ctx.editor.open(abs) }, icon("go-to-file"), "Open File") : null,
        staged
          ? h("button", { class: "btn secondary", onclick: () => unstage([file.path]) }, icon("remove"), "Unstage")
          : h("button", { class: "btn", onclick: () => stage([file.path]) }, icon("add"), "Stage"),
      ],
    });
  };

  /** A read-only side-by-side diff in a tab, under a bar naming the file and the two sides. */
  const diffTab = ({ title, key, path, what, original, modified, buttons = () => [] }) => {
    const language = monaco.languages.getLanguages().find((l) => (l.extensions ?? []).some((e) => path.toLowerCase().endsWith(e)))?.id ?? "plaintext";
    ctx.editor.openCustom({
      title,
      icon: "diff",
      key,
      render: (el) => {
        const bar = h("div", { class: "proposal-bar" }, icon("source-control"), h("div", { class: "what" }, h("b", null, path), h("span", { class: "muted" }, what)), ...buttons());
        const host = h("div", { class: "proposal-diff monaco-component" });
        el.append(h("div", { class: "proposal" }, bar, host));
        const a = monaco.editor.createModel(original, language);
        const b = monaco.editor.createModel(modified, language);
        const diff = monaco.editor.createDiffEditor(host, { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, minimap: { enabled: false }, disableLayerHinting: true });
        diff.setModel({ original: a, modified: b });
        return { dispose: () => { diff.dispose(); a.dispose(); b.dispose(); } };
      },
    });
  };

  /** A file as one commit changed it: its parent's version ↔ the commit's. */
  const openCommitDiff = async (c, f) => {
    const short = c.hash.slice(0, 7);
    const parent = c.parents[0];
    const original = f.letter === "A" || !parent ? "" : (await show(parent, f.from ?? f.path)) ?? "";
    const modified = f.letter === "D" ? "" : await show(c.hash, f.path);
    if (modified === null) return ctx.window.showInfo(`${f.path} is a binary file.`);
    diffTab({
      title: `${basename(f.path)} (${short})`,
      key: `git-commit:${c.hash}:${f.path}`,
      path: f.path,
      what: `  ${parent ? parent.slice(0, 7) : "(none)"} ↔ ${short} · ${c.subject}`,
      original,
      modified,
      buttons: () => [f.letter !== "D" ? h("button", { class: "btn secondary", onclick: () => ctx.editor.open(`${root}/${f.path}`) }, icon("go-to-file"), "Open File") : null],
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

  const fileRow = (file, depth = 0, inTree = false) => {
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
      { class: `list-row${file.letter === "D" ? " deleted" : ""}`, style: { paddingLeft: `${20 + depth * 12}px` }, title: `${file.path}${file.from ? ` ← ${file.from}` : ""}`, onclick: () => openDiff(file) },
      ctx.ui.fileIconEl ? ctx.ui.fileIconEl(basename(file.path)) : icon(fileIcon(file.path)),
      // One label for name and folder, cut once at its end: the name stays whole while it fits.
      h(
        "span",
        { class: "scm-label" },
        h("span", { class: "name" }, basename(file.path)),
        inTree || dirname(file.path) === file.path ? null : h("span", { class: "hint" }, dirname(file.path)),
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
      closed ? null : viewMode === "tree" ? treeRows(id, sorted(files)) : sorted(files).map((f) => fileRow(f)),
    );
  };

  const sorted = (files) => {
    const by = {
      name: (a, b) => basename(a.path).localeCompare(basename(b.path)) || a.path.localeCompare(b.path),
      path: (a, b) => a.path.localeCompare(b.path),
      status: (a, b) => a.letter.localeCompare(b.letter) || a.path.localeCompare(b.path),
    }[sortBy] ?? ((a, b) => a.path.localeCompare(b.path));
    return [...files].sort(by);
  };

  /** Folders, then files; a folder with only one folder in it shows as one row ("src/core"), as VS Code. */
  const treeRows = (sectionId, files) => {
    const top = { dirs: new Map(), files: [] };
    for (const f of files) {
      let node = top;
      for (const part of f.path.split("/").slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(f);
    }
    const rows = [];
    const walk = (node, depth, prefix) => {
      for (const [name, sub] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        let label = name;
        let dir = sub;
        while (!dir.files.length && dir.dirs.size === 1) {
          const [n, d] = [...dir.dirs][0];
          label += `/${n}`;
          dir = d;
        }
        const path = prefix ? `${prefix}/${label}` : label;
        const key = `dir:${sectionId}:${path}`;
        const closed = collapsed.has(key);
        rows.push(
          h(
            "div",
            { class: "list-row scm-dir", style: { paddingLeft: `${8 + depth * 12}px` }, title: path, onclick: () => { closed ? collapsed.delete(key) : collapsed.add(key); render(); } },
            icon(closed ? "chevron-right" : "chevron-down"),
            h("span", { class: "scm-label" }, h("span", { class: "name" }, label)),
          ),
        );
        if (!closed) walk(dir, depth + 1, path);
      }
      for (const f of node.files) rows.push(fileRow(f, depth, true));
    };
    walk(top, 0, "");
    return rows;
  };

  // ---------- graph ----------

  const loadGraph = async () => {
    const revs = ["HEAD", ...(status?.upstream ? [status.upstream] : [])];
    const r = await git.run(["log", "--topo-order", `-n${graphLimit + 1}`, `--format=${LOG_FORMAT}`, ...revs, "--"], { cwd: root, quiet: true });
    const list = r.code === 0 ? parseLog(r.stdout) : [];
    graphMore = list.length > graphLimit;
    graph = list.slice(0, graphLimit);
    graphLayout = layoutGraph(graph);
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    el.append(...kids);
    return el;
  };
  const LANE = 11;
  const ROW = 22;
  const laneX = (j) => 8 + j * LANE;
  const laneColor = (j) => `var(--git-lane-${j % 6})`;
  const laneSvg = (width, draw) => {
    const w = laneX(Math.max(0, width - 1)) + 8;
    const el = svg("svg", { class: "graph-lanes", width: w, height: ROW, viewBox: `0 0 ${w} ${ROW}` });
    draw(el);
    return el;
  };
  const line = (d, j) => svg("path", { d, stroke: laneColor(j), "stroke-width": 1.5, fill: "none" });

  const commitLanes = (L, isHead) =>
    laneSvg(L.width, (el) => {
      const m = ROW / 2;
      const x = laneX(L.lane);
      for (const j of L.through) el.append(line(`M ${laneX(j)} 0 V ${ROW}`, j));
      for (const j of L.into) el.append(line(`M ${laneX(j)} 0 C ${laneX(j)} ${m} ${x} ${m * 0.6} ${x} ${m}`, j));
      if (L.up) el.append(line(`M ${x} 0 V ${m}`, L.lane));
      if (L.down) el.append(line(`M ${x} ${m} V ${ROW}`, L.lane));
      for (const k of L.out) el.append(line(`M ${x} ${m} C ${x} ${m * 1.4} ${laneX(k)} ${m} ${laneX(k)} ${ROW}`, k));
      el.append(
        isHead
          ? svg("circle", { cx: x, cy: m, r: 4, fill: "var(--aicode-sideBar-background, #181818)", stroke: laneColor(L.lane), "stroke-width": 2 })
          : svg("circle", { cx: x, cy: m, r: 4, fill: laneColor(L.lane) }),
      );
    });
  // Under an open commit, its files sit between the lanes that go on.
  const passLanes = (L) => laneSvg(L.width, (el) => L.after.forEach((j) => el.append(line(`M ${laneX(j)} 0 V ${ROW}`, j))));

  const refPills = (refs) => {
    const pills = [];
    const pill = (kind, ic, text, title) => h("span", { class: `ref-pill ${kind}`, title }, icon(ic), text ? h("span", null, text) : null);
    // As VS Code: only the current branch is named; every other ref is its icon, named on hover.
    for (const b of refs.branches) pills.push(b === refs.head ? pill("local current", "target", b, `${b} (current branch)`) : pill("local", "git-branch", "", `branch ${b}`));
    for (const r of refs.remotes) pills.push(pill("remote", "cloud", "", `remote branch ${r}`));
    for (const t of refs.tags) pills.push(pill("tag", "tag", "", `tag ${t}`));
    return pills.length ? h("span", { class: "ref-pills" }, pills) : null;
  };

  const toggleCommit = async (c) => {
    if (openCommit?.hash === c.hash) {
      openCommit = null;
      return render();
    }
    openCommit = { hash: c.hash, files: null };
    render();
    try {
      const out = c.parents[0]
        ? await git.ok(["diff", "--name-status", "-z", "-M", c.parents[0], c.hash], { cwd: root })
        : await git.ok(["diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", "-M", c.hash], { cwd: root });
      if (openCommit?.hash === c.hash) openCommit.files = parseNameStatus(out);
    } catch (e) {
      if (openCommit?.hash === c.hash) openCommit.files = [];
      ctx.window.showError(`Git: ${String(e.message ?? e)}`);
    }
    render();
  };

  const graphSection = () => {
    const closed = collapsed.has("graph");
    const rows = [];
    if (!closed) {
      graph.forEach((c, i) => {
        const L = graphLayout[i];
        const isHead = !!c.refs.head;
        const date = c.date ? new Date(c.date).toLocaleString() : c.when;
        rows.push(
          h(
            "div",
            {
              class: `list-row graph-row${isHead ? " head" : ""}${openCommit?.hash === c.hash ? " open" : ""}`,
              title: `${c.subject}\n\n${c.author}, ${c.when} (${date})\n${c.hash.slice(0, 10)}`,
              onclick: () => toggleCommit(c),
            },
            commitLanes(L, isHead),
            h("span", { class: "graph-text" }, h("span", { class: "subject" }, c.subject), h("span", { class: "author" }, c.author)),
            refPills(c.refs),
          ),
        );
        if (openCommit?.hash !== c.hash) return;
        if (!openCommit.files) {
          rows.push(h("div", { class: "list-row graph-file muted" }, passLanes(L), icon("loading", "codicon-modifier-spin"), "Loading…"));
          return;
        }
        for (const f of openCommit.files)
          rows.push(
            h(
              "div",
              { class: "list-row graph-file", title: `${f.path}${f.from ? ` ← ${f.from}` : ""}`, onclick: () => openCommitDiff(c, f) },
              passLanes(L),
              ctx.ui.fileIconEl ? ctx.ui.fileIconEl(basename(f.path)) : icon(fileIcon(f.path)),
              h("span", { class: "scm-label" }, h("span", { class: "name" }, basename(f.path)), dirname(f.path) === f.path ? null : h("span", { class: "hint" }, dirname(f.path))),
              h("span", { class: `letter l-${f.letter}` }, f.letter),
            ),
          );
      });
      if (graphMore) rows.push(h("div", { class: "list-row graph-more", onclick: () => { graphLimit += GRAPH_PAGE; refresh(); } }, icon("fold-down"), "Load More Commits"));
      if (!graph.length) rows.push(h("div", { class: "pad muted" }, "No commits yet."));
    }
    return h(
      "div",
      { class: "scm-graph" },
      h(
        "div",
        // Opening draws now (with what was loaded before) and then brings the commits up to date.
        { class: "section-header", onclick: () => { closed ? collapsed.delete("graph") : collapsed.add("graph"); render(); if (closed) refresh(); } },
        icon(closed ? "chevron-right" : "chevron-down"),
        h("span", null, "Graph"),
        h(
          "div",
          { class: "actions", onclick: (e) => e.stopPropagation() },
          iconButton("repo-fetch", "Fetch", () => sync("fetch")),
          iconButton("repo-pull", "Pull", () => sync("pull")),
          iconButton("repo-push", "Push", () => sync("push")),
          iconButton("refresh", "Refresh", () => refresh()),
        ),
      ),
      rows,
    );
  };


  const render = () => {
    if (!view) return;
    clear(view);
    const folder = ctx.workspace.folder();
    if (!folder) {
      view.append(
        h(
          "div",
          { class: "pad stack" },
          h("div", null, "In order to use Git features, you can open a folder containing a Git repository or clone from a URL."),
          ctx.commands.exists("explorer.openFolder") ? h("button", { class: "btn block", onclick: () => ctx.commands.execute("explorer.openFolder") }, "Open Folder") : null,
          h("button", { class: "btn block", disabled: !!busy, onclick: clone }, "Clone Repository"),
        ),
      );
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
        busy ? h("div", { class: "scm-progress", title: busy }) : null,
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
        graphSection(),
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
    if (busy) return;
    if (!status?.upstream) return sync("push");
    if (status.behind) await sync("pull");
    if (status?.ahead) await sync("push");
    if (!status?.ahead && !status?.behind) await sync("fetch");
  });
  ctx.commands.register("git.acceptCommitMessage", acceptMessage);
  ctx.commands.register("git.stash", stash);
  ctx.commands.register("git.stashPop", stashPop);
  ctx.commands.register("git.undoCommit", undoCommit);
  ctx.commands.register("git.showOutput", showOutput);
  ctx.commands.register("git.clone", clone);
  ctx.commands.register("git.pullRebase", pullRebase);
  ctx.commands.register("git.pullFrom", pullFrom);
  ctx.commands.register("git.pushTo", pushTo);
  ctx.commands.register("git.fetchPrune", fetchPrune);
  ctx.commands.register("git.fetchAll", fetchAll);
  ctx.commands.register("git.merge", merge);
  ctx.commands.register("git.rebase", rebase);
  ctx.commands.register("git.createBranchFrom", createBranchFrom);
  ctx.commands.register("git.renameBranch", renameBranch);
  ctx.commands.register("git.deleteBranch", deleteBranch);
  ctx.commands.register("git.publish", publishBranch);
  ctx.commands.register("git.addRemote", addRemote);
  ctx.commands.register("git.removeRemote", removeRemote);
  ctx.commands.register("git.stashIncludeUntracked", stashUntracked);
  ctx.commands.register("git.stashStaged", stashStaged);
  ctx.commands.register("git.stashApplyLatest", () => applyStash(false, true));
  ctx.commands.register("git.stashApply", () => applyStash(false, false));
  ctx.commands.register("git.stashPopPick", () => applyStash(true, false));
  ctx.commands.register("git.stashDrop", dropStash);
  ctx.commands.register("git.stashDropAll", dropAllStashes);
  ctx.commands.register("git.viewStash", viewStash);
  ctx.commands.register("git.createTag", createTag);
  ctx.commands.register("git.deleteTag", deleteTag);
  ctx.commands.register("git.deleteRemoteTag", deleteRemoteTag);
  ctx.commands.register("git.pushTags", pushTags);
  ctx.commands.register("git.commitStaged", () => commit({ staged: true }));
  ctx.commands.register("git.commitAll", () => commit({ all: true }));
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
