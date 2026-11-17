/** The single record returned by `git blame --line-porcelain -L n,n`. */
export function parseLineBlame(output) {
  const lines = output.split("\n");
  const hash = lines[0]?.match(/^([a-f0-9]{40,64}) \d+ \d+(?: \d+)?$/)?.[1];
  if (!hash) return null;
  const fields = new Map();
  for (const line of lines.slice(1)) {
    if (line.startsWith("\t")) break;
    const space = line.indexOf(" ");
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  const uncommitted = /^0+$/.test(hash);
  const timestamp = Number(fields.get("author-time"));
  if (!uncommitted && (!fields.get("author") || !Number.isFinite(timestamp))) return null;
  return { hash, uncommitted, author: fields.get("author"), timestamp, summary: fields.get("summary") ?? "" };
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  const format = new Intl.RelativeTimeFormat(globalThis.navigator?.language || "en", { numeric: "always" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return "just now";
}

/** Cursor-line authorship, using the editor buffer so unsaved edits keep their correct lines. */
export function addLineBlame(ctx, git, { delay = 200 } = {}) {
  const editor = ctx.editor.monacoEditor();
  const item = ctx.statusBar.add({ id: "git.lineBlame", align: "right", priority: 110, text: "", icon: "" });
  const cache = new Map();
  let root = null;
  let timer;
  let controller;
  let selected = "";
  let revision = 0;
  let disposed = false;

  const hide = () => item.update({ text: "", icon: "", tooltip: "" });
  const paint = (blame) => {
    if (!blame) return hide();
    item.update({
      icon: "git-commit",
      text: blame.uncommitted ? "You, uncommitted changes" : `${blame.author}, ${relativeTime(blame.timestamp)}`,
      tooltip: blame.uncommitted ? "This line has uncommitted changes." : `Who last changed this line\n\n${blame.author} · ${new Date(blame.timestamp * 1000).toLocaleString()}\n${blame.hash.slice(0, 8)} · ${blame.summary}`,
    });
  };
  const schedule = (invalidate = false) => {
    if (disposed) return;
    if (invalidate) { cache.clear(); selected = ""; }
    const active = ctx.editor.active();
    const model = editor.getModel();
    const position = editor.getPosition();
    const prefix = root?.endsWith("/") ? root : `${root}/`;
    const valid = root && active?.path?.startsWith(prefix) && active.editorType === "default" && model && ctx.editor.model(active.id) === model && position;
    const key = valid ? JSON.stringify([root, active.id, active.path, model.getVersionId(), position.lineNumber]) : "";
    if (!invalidate && key === selected) return;
    selected = key;
    const request = ++revision;
    clearTimeout(timer);
    controller?.abort();
    hide();
    if (!valid) return;
    if (cache.has(key)) return paint(cache.get(key));
    const cwd = root;
    const path = active.path.slice(prefix.length);
    const line = position.lineNumber;
    timer = setTimeout(async () => {
      const abort = controller = new AbortController();
      try {
        const result = await git.run(["blame", "--line-porcelain", "--contents", "-", "-L", `${line},${line}`, "--", path], { cwd, stdin: model.getValue(), quiet: true, signal: abort.signal });
        if (disposed || request !== revision) return;
        const blame = result.code === 0 ? parseLineBlame(result.stdout) : null;
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, blame);
        paint(blame);
      } catch {
        // Untracked files, empty repositories and cancelled queries have no authorship to show.
        if (!disposed && request === revision) hide();
      }
    }, delay);
  };

  ctx.editor.onDidChangeActive(() => schedule());
  ctx.editor.onDidChangeContent(() => schedule());
  ctx.subscriptions.push(editor.onDidChangeCursorPosition(() => schedule()));
  ctx.subscriptions.push({ dispose: () => {
    disposed = true;
    revision++;
    clearTimeout(timer);
    controller?.abort();
    cache.clear();
    item.dispose();
  } });
  return { setRepository: (path) => { root = path ?? null; schedule(true); } };
}
