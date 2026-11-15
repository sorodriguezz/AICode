import * as helpers from "./git.js";
import { makeDiffTools } from "./diff.js";

export async function activate(ctx) {
  const available = Boolean(await ctx.process.which("git"));
  const git = helpers.makeGit(ctx);
  const listeners = new Set();
  const statusListeners = new Set();
  let watched = null;
  let pending = null;
  let statusRequest = null;
  let revision = 0;
  let changeTimer;

  const notify = () => {
    clearTimeout(changeTimer);
    revision++;
    for (const listener of listeners) Promise.resolve().then(listener).catch((e) => console.error("Git refresh", e));
    if (statusListeners.size) return refreshStatus();
  };
  const onChange = () => notify()?.catch((e) => console.error("Git status", e));
  const changed = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(onChange, 400);
  };
  const watch = (root) => {
    if (watched?.root === root) return;
    watched?.subscriptions.forEach((sub) => sub.dispose());
    watched = root ? { root, subscriptions: [ctx.fs.watch(root, changed), ctx.fs.watch(`${root}/.git`, changed)] } : null;
  };
  const repository = async () => {
    const folder = ctx.workspace.folder();
    if (!available || !folder) {
      watch(null);
      return null;
    }
    if (pending?.folder === folder) return pending.request;
    const request = git.run(["rev-parse", "--show-toplevel"], { cwd: folder, quiet: true }).then((r) => {
      const root = r.code === 0 ? r.stdout.trim() : null;
      if (ctx.workspace.folder() === folder) watch(root);
      return root;
    }).finally(() => {
      if (pending?.request === request) pending = null;
    });
    pending = { folder, request };
    return request;
  };

  const readStatus = async () => {
    const root = await repository();
    const args = ["--no-optional-locks", "status", "--porcelain=v2", "-z"];
    if (!root) return { root, status: null };
    const result = await git.run([...args, "--branch", "--untracked-files=all"], { cwd: root, quiet: true });
    if (result.code !== 0) return { root, status: null };
    const status = helpers.parseStatus(result.stdout);
    // A separate listing keeps ignored directories collapsed while listing every untracked file.
    const ignored = await git.run([...args, "--ignored=traditional", "--untracked-files=normal"], { cwd: root, quiet: true });
    if (ignored.code === 0) status.ignored = helpers.parseStatus(ignored.stdout).ignored;
    return { root, status };
  };

  const refreshStatus = () => (statusRequest ??= (async () => {
    while (true) {
      const requested = revision;
      const snapshot = await readStatus();
      if (requested !== revision) continue;
      for (const listener of statusListeners) {
        try { listener(snapshot); } catch (e) { console.error("Git status listener", e); }
      }
      return snapshot;
    }
  })().finally(() => { statusRequest = null; }));

  ctx.workspace.onDidChangeFolder(() => { watch(null); onChange(); });
  ctx.editor.onDidSave(() => {
    if (statusListeners.size) {
      revision++;
      refreshStatus().catch((e) => console.error("Git status", e));
    }
  });
  window.addEventListener("focus", onChange);
  ctx.subscriptions.push({ dispose: () => {
    clearTimeout(changeTimer);
    watch(null);
    window.removeEventListener("focus", onChange);
  } });
  return {
    ...helpers,
    makeDiffTools,
    available,
    git,
    repository,
    changed,
    refreshStatus,
    refreshAfterChange: notify,
    onDidChangeStatus: (fn) => {
      statusListeners.add(fn);
      return { dispose: () => statusListeners.delete(fn) };
    },
    onDidChange: (fn) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
  };
}
