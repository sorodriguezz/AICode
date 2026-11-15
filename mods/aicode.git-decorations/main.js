// Decorations for the Explorer and the active editor, using Git Core's status.
const STYLE = `
.git-gutter-added { border-left: 3px solid var(--aicode-editorGutter-addedBackground, #2ea043); margin-left: 3px; }
.git-gutter-modified { border-left: 3px solid var(--aicode-editorGutter-modifiedBackground, #0078d4); margin-left: 3px; }
.git-gutter-deleted { border-left: 0; margin-left: 3px; width: 0 !important; height: 0 !important; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 5px solid var(--aicode-editorGutter-deletedBackground, #f85149); }
`;

export async function activate(ctx) {
  const service = await ctx.mods.get("aicode.git-core");
  if (!service.available) return;
  const monaco = ctx.monaco;
  const { decorationMap, lineChanges } = service;
  ctx.styles.add(STYLE);

  let snapshot = { root: null, status: null };
  let lookup = () => undefined;
  const files = ctx.decorations.register((path) => lookup(path));
  const headCache = new Map();

  const editor = ctx.editor.monacoEditor();
  const decorations = editor.createDecorationsCollection();
  let gutterTimer;
  let gutterVersion = 0;
  const updateGutter = () => {
    const version = ++gutterVersion;
    const { root, status } = snapshot;
    clearTimeout(gutterTimer);
    gutterTimer = setTimeout(async () => {
      const active = ctx.editor.active();
      const model = editor.getModel();
      if (!root || !active?.path || !model || !active.path.startsWith(root + "/")) return decorations.clear();
      const rel = active.path.slice(root.length + 1);
      if (status?.ignored.some((path) => rel === path || rel.startsWith(path + "/"))) return decorations.clear();
      if (!headCache.has(rel)) {
        headCache.set(rel, service.git.run(["show", `HEAD:${rel}`], { cwd: root, quiet: true })
          .then((r) => r.code === 0 ? r.stdout : null));
      }
      const base = await headCache.get(rel).catch(() => null);
      if (version !== gutterVersion || editor.getModel() !== model) return;
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

  ctx.subscriptions.push(service.onDidChangeStatus((next) => {
    snapshot = next;
    headCache.clear();
    lookup = next.status && next.root ? decorationMap(next.status, next.root) : () => undefined;
    files.fire();
    updateGutter();
  }));
  ctx.editor.onDidChangeActive(updateGutter);
  ctx.editor.onDidChangeContent(updateGutter);
  ctx.subscriptions.push({ dispose: () => {
    gutterVersion++;
    clearTimeout(gutterTimer);
    decorations.clear();
  } });
  await service.refreshStatus();
}
