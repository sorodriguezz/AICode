// Running git and reading what it says. Everything goes through the user's own `git` with
// machine-readable output (`--porcelain=v2 -z`), never through a library of our own.

export function makeGit(ctx) {
  /** Runs git; resolves { code, stdout, stderr } (never rejects on a non-zero exit). */
  const run = async (args, { cwd, stdin, quiet = false } = {}) => {
    let stdout = "";
    let stderr = "";
    const proc = await ctx.process.spawn("git", ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args], {
      cwd,
      stdin,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: quiet ? "0" : "1", LC_ALL: "C" },
      onData: (data, stream) => (stream === "stdout" ? (stdout += data) : (stderr += data)),
    });
    const code = await proc.done;
    return { code, stdout, stderr };
  };

  const ok = async (args, opts) => {
    const r = await run(args, opts);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
    return r.stdout;
  };

  return { run, ok };
}

/** `git status --porcelain=v2 --branch -z` → { branch, upstream, ahead, behind, files[] }. */
export function parseStatus(out) {
  const status = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [], ignored: [] };
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith("# branch.head ")) status.branch = f.slice(14);
    else if (f.startsWith("# branch.oid ")) status.oid = f.slice(13);
    else if (f.startsWith("# branch.upstream ")) status.upstream = f.slice(18);
    else if (f.startsWith("# branch.ab ")) {
      const m = f.match(/\+(\d+) -(\d+)/);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (f[0] === "1") {
      const parts = f.split(" ");
      status.files.push({ xy: parts[1], path: parts.slice(8).join(" ") });
    } else if (f[0] === "2") {
      const parts = f.split(" ");
      status.files.push({ xy: parts[1], path: parts.slice(9).join(" "), from: fields[++i] });
    } else if (f[0] === "u") {
      const parts = f.split(" ");
      status.files.push({ xy: parts[1], path: parts.slice(10).join(" "), conflict: true });
    } else if (f[0] === "?") {
      status.files.push({ xy: "??", path: f.slice(2), untracked: true });
    } else if (f[0] === "!") {
      status.ignored.push(f.slice(2).replace(/\/$/, ""));
    }
  }
  return status;
}

const LETTER = { M: "M", A: "A", D: "D", R: "R", C: "C", T: "M", U: "U" };

const DECO = {
  "!": { color: "gitDecoration.conflictingResourceForeground", tooltip: "Conflicting", rank: 6 },
  D: { color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted", rank: 5 },
  M: { color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified", rank: 4 },
  U: { color: "gitDecoration.untrackedResourceForeground", tooltip: "Untracked", rank: 3 },
  A: { color: "gitDecoration.addedResourceForeground", tooltip: "Index Added", rank: 3 },
  R: { color: "gitDecoration.renamedResourceForeground", tooltip: "Index Renamed", rank: 2 },
  C: { color: "gitDecoration.addedResourceForeground", tooltip: "Index Copied", rank: 2 },
};

/**
 * What the explorer shows for each path: files get a letter and a color (the working tree's
 * change wins over the staged one, as in VS Code), folders the color of their most serious change.
 */
export function decorationMap(status, root) {
  const files = new Map();
  const dirs = new Map();
  for (const f of status.files) {
    let letter;
    if (f.conflict) letter = "!";
    else if (f.untracked) letter = "U";
    else {
      const [x, y] = f.xy;
      letter = y !== "." ? LETTER[y] ?? y : LETTER[x] ?? x;
    }
    const d = DECO[letter];
    if (!d) continue;
    const path = `${root}/${f.path}`;
    files.set(path, { badge: letter, color: d.color, tooltip: d.tooltip, rank: d.rank });
    for (let i = path.lastIndexOf("/"); i > root.length; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i);
      const prev = dirs.get(dir);
      if (prev && prev.rank >= d.rank) continue;
      dirs.set(dir, { badge: "•", color: d.color, tooltip: "Contains changes", rank: d.rank });
    }
  }
  const ignored = (status.ignored ?? []).map((p) => `${root}/${p}`);
  return (path) => {
    const hit = files.get(path) ?? dirs.get(path);
    if (hit) return hit;
    if (ignored.some((p) => path === p || path.startsWith(p + "/"))) return { faded: true, color: "gitDecoration.ignoredResourceForeground", tooltip: "Ignored" };
    return undefined;
  };
}

/** Splits status files into the groups the view shows. */
export function groups(status) {
  const merge = [];
  const staged = [];
  const changes = [];
  const untracked = [];
  for (const f of status.files) {
    if (f.conflict) merge.push({ ...f, letter: "!", kind: "merge" });
    else if (f.untracked) untracked.push({ ...f, letter: "U", kind: "untracked" });
    else {
      const [x, y] = f.xy;
      if (x !== ".") staged.push({ ...f, letter: LETTER[x] ?? x, kind: "staged" });
      if (y !== ".") changes.push({ ...f, letter: LETTER[y] ?? y, kind: "changes" });
    }
  }
  return { merge, staged, changes, untracked };
}

/**
 * Line diff (Myers, O((N+M)·D)) between two texts, as the gutter needs it: ranges of the new text
 * that were added or modified, and the lines after which something was deleted. Gives up (null) on
 * diffs too large to be worth drawing.
 */
export function lineChanges(oldText, newText, maxD = 2000) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return null;
  // Walk back to collect the edit script as (deleted a-lines, inserted b-lines).
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[max + k - 1] < vv[max + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "ins", line: prevY });
      else ops.push({ type: "del", line: prevX, at: y });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  // Group into hunks of consecutive edits.
  const ins = new Set(ops.filter((o) => o.type === "ins").map((o) => o.line));
  const delAt = new Map();
  for (const o of ops) if (o.type === "del") delAt.set(o.at, (delAt.get(o.at) ?? 0) + 1);
  const result = { added: [], modified: [], deleted: [] };
  let i = 0;
  while (i < m) {
    if (!ins.has(i)) {
      i++;
      continue;
    }
    const start = i;
    while (ins.has(i)) i++;
    // An insertion right where lines were deleted is a modification.
    const deletedHere = delAt.get(start) ?? 0;
    (deletedHere ? result.modified : result.added).push([start + 1, i]);
    if (deletedHere) delAt.delete(start);
  }
  for (const at of delAt.keys()) result.deleted.push(Math.max(1, at));
  return result;
}
