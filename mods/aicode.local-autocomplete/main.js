// Monaco inline suggestions from Local Inference.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function activate(ctx) {
  const monaco = ctx.monaco;
  const s = (key, fallback) => ctx.settings.getNow(key, fallback);
  const inference = await ctx.mods.get("aicode.local-inference");
  const { complete, chat, fill, prepare, codeModel, warmCodeModel, isFast, engine, fail, ok, track } = inference;

  // ---------- code: inline completions in Monaco ----------
  const cache = new Map();
  const remember = (k, v) => {
    cache.set(k, v);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
  };
  let inflight = null;

  const relPath = (model) => {
    const p = model.uri.scheme === "file" ? model.uri.fsPath ?? model.uri.path : model.uri.path;
    const root = ctx.workspace.folder?.();
    const norm = String(p).replace(/\\/g, "/");
    return root && norm.toLowerCase().startsWith(String(root).toLowerCase() + "/") ? norm.slice(String(root).length + 1) : ctx.ui.basename(norm) || "untitled";
  };

  const tidy = (text, { suffix, multiline }) => {
    let t = String(text ?? "").replace(/\r/g, "");
    if (!multiline) t = t.split("\n")[0];
    // Drop trailing blank lines and cap the length.
    t = t.replace(/\s+$/, "");
    const lines = t.split("\n");
    if (lines.length > 60) t = lines.slice(0, 60).join("\n");
    // Small models like to repeat what already follows the cursor: stop at the first suggested line
    // that is one of the next lines of the file (not counting one-character lines like `}`, which
    // a suggestion legitimately closes).
    const ahead = new Set(
      suffix.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.length > 1).slice(0, 8),
    );
    const rest = suffix.split("\n")[0].trim();
    const out = [];
    for (const [i, l] of t.split("\n").entries()) {
      const k = l.trim();
      if (i > 0 && k.length > 1 && (ahead.has(k) || ahead.has(k.replace(/,$/, "")) || ahead.has(`${k},`))) break;
      out.push(l);
    }
    t = out.join("\n").replace(/\s+$/, "");
    // …and on the cursor's own line, the text that is already after it.
    if (rest && t.endsWith(rest)) t = t.slice(0, -rest.length).replace(/\s+$/, "");
    return t.trim() ? t : "";
  };

  /** Other open files as context — what the code at the cursor most likely uses (Copilot's
   *  "neighboring tabs"): the start of each file, with its imports, types and declarations. */
  const otherFiles = (current) => {
    const budget = Math.max(0, Number(s("extraContextChars", 6000)) || 0);
    if (!budget) return [];
    const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\/([a-z]:)/i, "$1").toLowerCase();
    const here = norm(current.uri?.fsPath ?? current.uri?.path);
    let editors = [];
    try {
      editors = ctx.editor.all?.() ?? [];
    } catch {}
    const out = [];
    let used = 0;
    for (const ed of editors) {
      if (!ed?.path || norm(ed.path) === here) continue;
      let text = "";
      try {
        text = ctx.editor.getText(ed.id || ed.path) ?? "";
      } catch {}
      if (!text.trim()) continue;
      const room = Math.min(2000, budget - used);
      if (room < 200) break;
      const chunk = text.length > room ? text.slice(0, text.lastIndexOf("\n", room) + 1 || room) : text;
      out.push({ filename: relPath({ uri: { scheme: "file", path: ed.path } }), text: chunk });
      used += chunk.length;
      if (out.length >= 4) break;
    }
    return out;
  };

  const inlineProvider = {
    async provideInlineCompletions(model, position, context, token) {
      try {
        return await provide(model, position, context, token);
      } catch (e) {
        // Monaco drops a provider's errors without a word: show them instead.
        console.error("[Local Autocomplete]", e);
        fail(e);
        return { items: [] };
      }
    },
    freeInlineCompletions() {},
    disposeInlineCompletions() {},
    handleItemDidShow() {},
  };

  const provide = async (model, position, context, token) => {
    if (!s("enabled", true)) return { items: [] };
    await prepare();
    if (token.isCancellationRequested) return { items: [] };
    const lang = model.getLanguageId();
    const off = String(s("disabledLanguages", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (off.includes(lang)) return { items: [] };
    const line = model.getLineContent(position.lineNumber);
    const after = line.slice(position.column - 1);
    // Only where a completion can go: end of line, or before closing brackets / quotes.
    if (!/^[\s)\]}>"'`;,.:]*$/.test(after)) return { items: [] };
    const explicit = context?.triggerKind === 1;
    if (!explicit) {
      await sleep(Math.max(0, Number(s("debounceMs", 0)) || (isFast() ? 100 : 250)));
      if (token.isCancellationRequested) return { items: [] };
    }
    const offset = model.getOffsetAt(position);
    const total = model.getValueLength();
    const maxPre = Math.max(200, Number(s("maxPrefixChars", 8000)) || 8000);
    const maxSuf = Math.max(0, Number(s("maxSuffixChars", 2000)) || 0);
    const preStart = model.getPositionAt(Math.max(0, offset - maxPre));
    const sufEnd = model.getPositionAt(Math.min(total, offset + maxSuf));
    const prefix = model.getValueInRange({ startLineNumber: preStart.lineNumber, startColumn: preStart.column, endLineNumber: position.lineNumber, endColumn: position.column });
    const suffix = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: sufEnd.lineNumber, endColumn: sufEnd.column });
    if (!prefix.trim()) return { items: [] };

    const key = `${lang}\u0000${prefix.slice(-600)}\u0000${suffix.slice(0, 200)}`;
    let text = cache.get(key);
    if (text === undefined) {
      const modelId = codeModel(); // not `model`: that is the document
      const multiline = !!s("multiline", true) && !after.trim();
      const root = ctx.workspace.folder?.();
      const maxTokens = Math.max(8, Number(s("maxTokens", 256)) || 256);
      const temperature = Number(s("temperature", 0.1)) || 0;
      inflight?.cancel();
      const req = fill({
        model: modelId,
        prefix,
        suffix,
        path: relPath(model),
        repo: root ? ctx.ui.basename(root) : "workspace",
        extra: () => otherFiles(model),
        // Stop when the suggestion leaves the current block.
        indent: (line.slice(0, position.column - 1).match(/^\s*/)?.[0] ?? "").length,
        multiline,
        maxLatencyMs: s("maxLatencyMs", 2500),
        maxTokens,
        temperature,
      });
      inflight = req;
      const sub = token.onCancellationRequested?.(() => req.cancel());
      try {
        text = tidy(await track(req), { suffix, multiline });
        if (inflight !== req || token.isCancellationRequested) return { items: [] };
        ok();
        remember(key, text);
      } catch (e) {
        if (inflight === req && !token.isCancellationRequested) fail(e);
        return { items: [] };
      } finally {
        sub?.dispose?.();
        if (inflight === req) inflight = null;
      }
    }
    if (!text || token.isCancellationRequested) return { items: [] };
    return {
      items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
    };
  };

  if (monaco?.languages?.registerInlineCompletionsProvider) {
    ctx.subscriptions.push(monaco.languages.registerInlineCompletionsProvider("*", inlineProvider));
    const enableGhost = (ed) => ed?.updateOptions?.({ inlineSuggest: { enabled: true } });
    enableGhost(ctx.editor.monacoEditor?.());
    const sub = monaco.editor.onDidCreateEditor?.(enableGhost);
    if (sub) ctx.subscriptions.push(sub);
  }

  // Warm the model only if it is already on disk.
  let warming = null;
  const warm = () => {
    if (warming || !s("enabled", true)) return;
    const request = warmCodeModel().catch(() => {
      if (warming === request) warming = null;
    });
    warming = request;
  };
  ctx.editor.onDidChangeActive((info) => info?.path && warm());
  ctx.editor.onDidChangeContent(warm);
  const warmTimer = setTimeout(() => ctx.editor.active()?.path && warm(), 1500);
  const clear = () => {
    cache.clear();
    inflight?.cancel();
    inflight = null;
  };
  ctx.settings.onDidChange(clear);
  ctx.config.watch("*", () => {
    clear();
    warming = null;
  }, "aicode.local-inference");
  ctx.subscriptions.push({ dispose: () => {
    clearTimeout(warmTimer);
    clear();
    warming = null;
  } });

  ctx.commands.register("autocomplete.toggle", async () => {
    const on = !s("enabled", true);
    await ctx.settings.set("enabled", on);
    ctx.window.showInfo(`Inline completions ${on ? "on" : "off"}.`);
  });

  ctx.commands.register("autocomplete.trigger", () => {
    if (document.activeElement?.matches(".scm-input textarea") && ctx.commands.exists("commitAssistant.trigger")) {
      return ctx.commands.execute("commitAssistant.trigger");
    }
    const ed = ctx.editor.monacoEditor?.();
    ed?.focus();
    ed?.trigger("autocomplete", "editor.action.inlineSuggest.trigger", {});
  });

  return {
    complete, chat, engine,
    generateCommit: () => ctx.commands.exists("autocomplete.generateCommit") && ctx.commands.execute("autocomplete.generateCommit"),
  };
}
