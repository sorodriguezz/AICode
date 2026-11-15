const STYLE = `
/* The graph (VS Code's Source Control Graph): lanes, the subject, its author, and the refs at the end. */
.scm-graph {
  --git-lane-0: var(--aicode-scmGraph-foreground1, #59a4f9); --git-lane-1: var(--aicode-scmGraph-foreground2, #b180d7);
  --git-lane-2: var(--aicode-scmGraph-foreground3, #ffb000); --git-lane-3: var(--aicode-scmGraph-foreground4, #40b0a6);
  --git-lane-4: var(--aicode-scmGraph-foreground5, #dc267f); --git-lane-5: #e2c08d;
  height: 100%; display: flex; flex-direction: column; justify-content: flex-start; padding: 6px 0 4px;
}
.scm-graph.collapsed { justify-content: flex-end; }
.scm-graph > .section-header { flex: 0 0 auto; }
.scm-graph-rows { min-height: 0; overflow: auto; }
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
.scm-graph .scm-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scm-graph .scm-label .hint { margin-left: 5px; }
.scm-graph .letter { flex: 0 0 auto; width: 14px; text-align: center; font-weight: 600; }
.scm-graph .l-M { color: var(--aicode-gitDecoration-modifiedResourceForeground, #e2c08d); }
.scm-graph .l-A { color: var(--aicode-gitDecoration-addedResourceForeground, #73c991); }
.scm-graph .l-D { color: var(--aicode-gitDecoration-deletedResourceForeground, #c74e39); }
.scm-graph .l-R { color: var(--aicode-gitDecoration-renamedResourceForeground, #3b82c4); }
.scm-graph .l-C { color: var(--aicode-gitDecoration-addedResourceForeground, #73c991); }
`;

const PAGE = 50;

export async function activate(ctx) {
  const { h, icon, iconButton, basename, dirname, fileIcon } = ctx.ui;
  const service = await ctx.mods.get("aicode.git-core");
  const { git, LOG_FORMAT, parseLog, layoutGraph, parseNameStatus } = service;
  const { openCommitDiff } = service.makeDiffTools(ctx, git);
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  ctx.subscriptions.push({ dispose: () => style.remove() });

  let view;
  let visible = false;
  let closed = false;
  let generation = 0;
  let root = null;
  let loaded = false;
  let graphLimit = PAGE;
  let graph = [];
  let graphLayout = [];
  let graphMore = false;
  let openCommit = null;

  const showError = (e) => ctx.window.showError(`Git: ${String(e.message ?? e)}`);

  const refresh = async () => {
    if (!visible || closed || !service.available) return;
    const seq = ++generation;
    try {
      const nextRoot = await service.repository();
      if (seq !== generation) return;
      if (root !== nextRoot) {
        openCommit = null;
        graphLimit = PAGE;
        graph = graphLayout = [];
        graphMore = loaded = false;
        root = nextRoot;
        render();
      }
      let list = [];
      if (root) {
        const upstream = await git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: root, quiet: true });
        if (seq !== generation) return;
        const revs = upstream.code === 0 && upstream.stdout.trim() ? ["HEAD", upstream.stdout.trim()] : ["HEAD"];
        const r = await git.run(["log", "--topo-order", `-n${graphLimit + 1}`, `--format=${LOG_FORMAT}`, ...revs, "--"], { cwd: root, quiet: true });
        if (seq !== generation) return;
        if (r.code === 0) list = parseLog(r.stdout);
      }
      graphMore = list.length > graphLimit;
      graph = list.slice(0, graphLimit);
      graphLayout = layoutGraph(graph);
      loaded = true;
      render();
    } catch (e) {
      if (seq === generation) showError(e);
    }
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
      render();
      return;
    }
    const current = openCommit = { hash: c.hash, files: null };
    render();
    try {
      const out = c.parents[0]
        ? await git.ok(["diff", "--name-status", "-z", "-M", c.parents[0], c.hash], { cwd: root })
        : await git.ok(["diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", "-M", c.hash], { cwd: root });
      current.files = parseNameStatus(out);
    } catch (e) {
      current.files = [];
      if (openCommit === current) showError(e);
    }
    if (openCommit === current) render();
  };

  const optionalActions = () => [
    ["git.fetch", "repo-fetch", "Fetch"],
    ["git.pull", "repo-pull", "Pull"],
    ["git.push", "repo-push", "Push"],
  ].filter(([command]) => ctx.commands.exists(command)).map(([command, symbol, title]) =>
    iconButton(symbol, title, () => void ctx.commands.execute(command).catch(showError)),
  );

  const render = () => {
    if (!view) return;
    if (!service.available) {
      view.replaceChildren(h("div", { class: "notice" }, "git is not installed or not on your PATH."));
      return;
    }
    const scrollTop = view.querySelector(".scm-graph-rows")?.scrollTop ?? 0;
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
              { class: "list-row graph-file", title: `${f.path}${f.from ? ` ← ${f.from}` : ""}`, onclick: () => void openCommitDiff(root, c, f).catch(showError) },
              passLanes(L),
              ctx.ui.fileIconEl ? ctx.ui.fileIconEl(basename(f.path)) : icon(fileIcon(f.path)),
              h("span", { class: "scm-label" }, h("span", { class: "name" }, basename(f.path)), dirname(f.path) === f.path ? null : h("span", { class: "hint" }, dirname(f.path))),
              h("span", { class: `letter l-${f.letter}` }, f.letter),
            ),
          );
      });
      if (graphMore) rows.push(h("div", { class: "list-row graph-more", onclick: () => { graphLimit += PAGE; void refresh(); } }, icon("fold-down"), "Load More Commits"));
      if (!graph.length) {
        const message = !loaded ? "Loading…" : root ? "No commits yet." : "Open a folder containing a Git repository.";
        rows.push(h("div", { class: "pad muted" }, message));
      }
    }
    const body = closed ? null : h("div", { class: "scm-graph-rows" }, rows);
    view.replaceChildren(h(
      "div",
      { class: `scm-graph${closed ? " collapsed" : ""}` },
      h(
        "div",
        { class: "section-header", onclick: () => {
          closed = !closed;
          generation++;
          render();
          if (!closed) void refresh();
        } },
        icon(closed ? "chevron-right" : "chevron-down"),
        h("span", null, "Graph"),
        h("div", { class: "actions", onclick: (e) => e.stopPropagation() }, optionalActions(), iconButton("refresh", "Refresh", refresh)),
      ),
      body,
    ));
    if (body) body.scrollTop = scrollTop;
  };

  ctx.views.provide("git.graph", {
    actions: [{ icon: "refresh", title: "Refresh", run: refresh }],
    render: (el) => { view = el; render(); },
    onShow: () => { visible = true; return refresh(); },
    onHide: () => { visible = false; generation++; },
  });
  ctx.commands.register("git.graph.refresh", () => ctx.views.reveal("git.graph"));
  ctx.subscriptions.push(service.onDidChange(refresh));
}
