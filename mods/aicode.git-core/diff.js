/** Read-only Git diffs shared by the working tree, the stash and commit history. */
export function makeDiffTools(ctx, git) {
  const { h, icon, basename } = ctx.ui;
  const monaco = ctx.monaco;
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

  const openCommitDiff = async (root, c, f) => {
    const show = async (ref, path) => {
      const result = await git.run(["show", `${ref}:${path}`], { cwd: root, quiet: true });
      return result.code === 0 ? result.stdout : null;
    };
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
  return { diffTab, openCommitDiff };
}
