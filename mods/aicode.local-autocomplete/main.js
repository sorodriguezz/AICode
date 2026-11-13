// Local Autocomplete: ghost-text completions from a small model running on this machine.
//
//   Code    — a Monaco inline completions provider. It sends the code before and after the cursor
//             in the fill-in-the-middle (FIM) format the model was trained with (Qwen2.5-Coder by
//             default) and shows what comes back as ghost text; Tab accepts, Esc dismisses.
//   Commits — ghost text in the Source Control message box, continued from what you typed, using
//             the staged diff and the repository's recent subjects as context; and a command that
//             writes the whole message with an instruction model.
//
// Backends:
//   builtin — the default. The mod brings its own engine (llama.cpp's llama-server, see engine.js)
//             and its own Qwen2.5-Coder GGUF models, downloaded into its folder the first time.
//             Nothing to install; nothing leaves the machine.
//   ollama / openai — an engine the user already runs (Ollama, LM Studio, llama.cpp, vLLM, Jan).

import { CATALOG, createEngine, recommend, sizeLabel } from "./engine.js";

const RECOMMENDED = {
  code: ["qwen2.5-coder:0.5b-base", "qwen2.5-coder:1.5b-base", "qwen2.5-coder:3b-base", "qwen2.5-coder:7b-base", "deepseek-coder:1.3b-base", "starcoder2:3b", "codegemma:2b"],
  commit: ["qwen2.5-coder:1.5b", "qwen2.5-coder:3b", "qwen2.5:1.5b", "qwen2.5:3b", "llama3.2:3b", "gemma2:2b"],
};

const FIM = {
  qwen: {
    build: ({ prefix, suffix, path, repo }) =>
      `<|repo_name|>${repo}\n<|file_sep|>${path}\n<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    stop: ["<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|file_sep|>", "<|repo_name|>", "<|im_end|>"],
  },
  deepseek: {
    build: ({ prefix, suffix }) => `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
    stop: ["<｜end▁of▁sentence｜>", "<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<|EOT|>"],
  },
  codellama: {
    build: ({ prefix, suffix }) => `<PRE> ${prefix} <SUF>${suffix} <MID>`,
    stop: ["<EOT>", "<PRE>", "<SUF>", "<MID>"],
  },
  starcoder: {
    build: ({ prefix, suffix, path }) => `<file_sep>${path}\n<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
    stop: ["<|endoftext|>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>"],
  },
  // JetBrains Mellum: suffix first (SPM).
  mellum: {
    build: ({ prefix, suffix }) => `<fim_suffix>${suffix}<fim_prefix>${prefix}<fim_middle>`,
    stop: ["<|endoftext|>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>"],
  },
  codegemma: {
    build: ({ prefix, suffix }) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    stop: ["<|file_separator|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<end_of_turn>", "<eos>"],
  },
};

const fimFor = (model, setting) => {
  if (setting && setting !== "auto" && FIM[setting]) return FIM[setting];
  const m = String(model).toLowerCase();
  if (m.includes("deepseek")) return FIM.deepseek;
  if (m.includes("codellama") || m.includes("code-llama")) return FIM.codellama;
  if (m.includes("starcoder") || m.includes("stable-code") || m.includes("santacoder")) return FIM.starcoder;
  if (m.includes("codegemma")) return FIM.codegemma;
  return FIM.qwen;
};

const CSS = `
.scm-input { position: relative; }
.lac-ghost {
  position: absolute; pointer-events: none; overflow: hidden; box-sizing: border-box;
  white-space: pre-wrap; overflow-wrap: break-word; color: transparent;
  border-color: transparent !important; background: transparent !important;
}
.lac-ghost .lac-typed { color: transparent; }
.lac-ghost .lac-sugg { color: var(--aicode-editorGhostText-foreground, var(--aicode-descriptionForeground)); opacity: .75; }
.lac-ghost .lac-hint {
  margin-left: 6px; font-size: 10px; padding: 0 4px; border-radius: 3px; vertical-align: 1px;
  color: var(--aicode-descriptionForeground); border: 1px solid var(--aicode-widget-border, rgba(128, 128, 128, .35));
}
@keyframes lac-in { from { opacity: 0; } }
html:not(.no-motion) .lac-ghost .lac-sugg { animation: lac-in var(--motion, 160ms) var(--ease-out, ease-out); }
textarea.lac-has-ghost::placeholder { color: transparent; }
textarea.lac-with-generate { padding-right: 28px !important; }
.scm-input > .lac-generate {
  position: absolute; width: 22px; height: 22px; padding: 0; z-index: 1;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--aicode-descriptionForeground); opacity: .8;
}
.scm-input > .lac-generate:hover:not(:disabled) { opacity: 1; color: var(--aicode-foreground); }
.scm-input > .lac-generate:disabled { opacity: 1; cursor: progress; }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function activate(ctx) {
  const monaco = ctx.monaco;
  const s = (key, fallback) => ctx.settings.getNow(key, fallback);
  ctx.styles.add(CSS);
  // Commit messages (ghost text, the ✨ button) only with the Source Control mod; code completion always.
  const gitOn = () => !!ctx.mods.isEnabled?.("aicode.git");

  // ---------- backend ----------
  const provider = () => {
    const p = s("provider", "builtin");
    return p === "ollama" || p === "openai" ? p : "builtin";
  };
  const external = () => provider() !== "builtin";
  const endpoint = () => {
    const e = String(s("endpoint", "") || "").trim().replace(/\/+$/, "");
    if (e) return e;
    return provider() === "openai" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:11434";
  };
  // Built-in models: the one the user chose, or ("auto", the default) the one that suits this
  // machine — a 7B on a big GPU, a 1.5B on a laptop CPU (engine.js, recommend()).
  let rec = null;
  const ensureRec = async () => (rec ??= recommend(await engine.hardware()));
  const builtinPick = (key, kind, fallback) => {
    const v = s(key, "auto");
    return CATALOG[v]?.kind === kind ? v : rec?.[kind] ?? fallback;
  };
  const codeModel = () => (external() ? s("codeModel", "qwen2.5-coder:1.5b-base") : builtinPick("builtinCodeModel", "code", "qwen2.5-coder-1.5b"));
  const commitModel = () => (external() ? s("commitModel", "qwen2.5-coder:1.5b") : builtinPick("builtinCommitModel", "commit", "qwen2.5-coder-1.5b-instruct"));
  const modelLabel = (id) => (external() ? id : CATALOG[id]?.label ?? id);

  const engine = createEngine(ctx, {
    settings: s,
    onChange: (info) => {
      paintStatus();
      if (info?.fellBack)
        ctx.window.showWarning(
          `Local Autocomplete: the GPU engine didn't start here, so it runs on the CPU (slower). ${info.fellBack.slice(0, 160)}`,
          { label: "Try the GPU Again", run: () => engine.retryGpu() },
        );
    },
  });
  // Look at the hardware in the background: the first suggestion then needn't wait for it.
  let fast = false; // a GPU (or Apple silicon) answers quickly: wait less after the last key
  ensureRec()
    .then(async () => {
      fast = (await engine.backend()) !== "cpu";
      paintStatus();
    })
    .catch(() => {});
  // Warm up: load the model as soon as a file is opened or edited, so the first suggestion doesn't
  // pay for starting the engine (seconds on a GPU, which compiles its shaders the first time).
  let warmed = false;
  const warm = async () => {
    if (warmed || external() || !s("enabled", true)) return;
    warmed = true;
    try {
      await ensureRec();
      const id = codeModel();
      if (!(await engine.missing([id])).length) await engine.url(id);
    } catch {
      warmed = false;
    }
  };
  const warmSubs = [ctx.editor.onDidChangeActive?.((info) => info?.path && warm()), ctx.editor.onDidChangeContent?.(() => warm())];
  for (const w of warmSubs) if (w) ctx.subscriptions.push(w);
  if (ctx.editor.active?.()?.path) setTimeout(warm, 1500);

  let lastError = null;
  let warned = false;
  let offered = false;
  const fail = (e) => {
    if (e?.cancelled) return;
    if (e?.notInstalled) return offerDownload(e.missing);
    lastError = String(e?.message ?? e);
    paintStatus();
    if (warned) return;
    warned = true;
    if (!external()) {
      ctx.window.showWarning(`Local Autocomplete: ${lastError}`, { label: "Options…", run: () => ctx.commands.execute("autocomplete.menu") });
      return;
    }
    const where = provider() === "ollama" ? "Ollama" : "the local model server";
    ctx.window.showWarning(
      `Local Autocomplete can't reach ${where} at ${endpoint()}: ${lastError}`,
      { label: "Use the Built-in Engine", run: () => ctx.settings.set("provider", "builtin") },
      { label: "Options…", run: () => ctx.commands.execute("autocomplete.menu") },
    );
  };
  const ok = () => {
    if (lastError) {
      lastError = null;
      warned = false;
      paintStatus();
    }
  };

  // ---------- downloads (built-in engine) ----------
  let progress = null; // { label, fraction, step, steps }
  const download = async (ids) => {
    try {
      await engine.install(ids, (p) => {
        progress = p;
        paintStatus();
      });
      progress = null;
      lastError = null;
      warned = false;
      paintStatus();
      ctx.window.showInfo(`Local Autocomplete is ready: ${ids.map(modelLabel).join(" and ")} run on this machine.`);
      return true;
    } catch (e) {
      progress = null;
      lastError = String(e?.message ?? e);
      paintStatus();
      ctx.window.showError(`Local Autocomplete: ${lastError}`, { label: "Try Again", run: () => download(ids) });
      return false;
    }
  };
  /** The first time a model is needed: ask once per session before downloading gigabytes. */
  const offerDownload = (missing) => {
    if (offered || engine.isInstalling()) return;
    offered = true;
    const total = missing.reduce((n, m) => n + m.sizeMB, 0);
    const ids = missing.filter((m) => m.kind === "model").map((m) => m.id);
    ctx.window.showInfo(
      `Local Autocomplete runs ${missing.map((m) => m.label).join(" + ")} on this machine${rec?.why && s("builtinCodeModel", "auto") === "auto" ? `, chosen for your ${rec.why}` : ""}. Download now (${sizeLabel(total)}, only once)?`,
      { label: "Download", run: () => download(ids.length ? ids : [codeModel()]) },
      { label: "Choose Model…", run: () => pickModel("code") },
      { label: "Turn Off", run: () => ctx.settings.set("enabled", false) },
    );
  };

  /** Where to send requests: the built-in server for that model (started on demand) or the user's. */
  const baseFor = async (model) => (external() ? endpoint() : engine.url(model));

  /** Raw text completion (FIM or plain continuation). Resolves to the text; `.cancel()` stops it. */
  const complete = ({ model, prompt, stop, maxTokens, temperature }) => {
    let req = null;
    let cancelled = false;
    const p = (async () => {
      const base = await baseFor(model);
      if (cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });
      const kind = provider();
      if (kind === "builtin") {
        req = ctx.http.request({
          url: `${base}/completion`, method: "POST", timeoutMs: 30_000,
          body: { prompt, n_predict: maxTokens, temperature, top_p: 0.9, stop, cache_prompt: true },
        });
      } else if (kind === "ollama") {
        req = ctx.http.request({
          url: `${base}/api/generate`, method: "POST", timeoutMs: 30_000,
          body: { model, prompt, raw: true, stream: false, keep_alive: s("keepAlive", "30m"), options: { temperature, top_p: 0.9, num_predict: maxTokens, stop } },
        });
      } else {
        req = ctx.http.request({
          url: `${base}/completions`, method: "POST", timeoutMs: 30_000,
          body: { model, prompt, max_tokens: maxTokens, temperature, top_p: 0.9, stop, stream: false },
        });
      }
      const res = await req;
      if (!res.ok) throw new Error(`${res.status} ${errorText(res)}`);
      const j = res.json();
      return kind === "builtin" ? j.content ?? "" : kind === "ollama" ? j.response ?? "" : j.choices?.[0]?.text ?? "";
    })();
    p.cancel = () => {
      cancelled = true;
      req?.cancel();
    };
    return p;
  };

  const chat = async ({ model, system, user, maxTokens = 300, temperature = 0.2 }) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    const base = await baseFor(model);
    const kind = provider();
    const res =
      kind === "ollama"
        ? await ctx.http.request({
            url: `${base}/api/chat`, method: "POST", timeoutMs: 120_000,
            body: { model, messages, stream: false, keep_alive: s("keepAlive", "30m"), options: { temperature, num_predict: maxTokens } },
          })
        : await ctx.http.request({
            url: kind === "builtin" ? `${base}/v1/chat/completions` : `${base}/chat/completions`, method: "POST", timeoutMs: 120_000,
            body: { model, messages, max_tokens: maxTokens, temperature, stream: false },
          });
    if (!res.ok) throw new Error(`${res.status} ${errorText(res)}`);
    const j = res.json();
    return kind === "ollama" ? j.message?.content ?? "" : j.choices?.[0]?.message?.content ?? "";
  };

  const errorText = (res) => {
    try {
      const j = res.json();
      return j.error?.message ?? j.error ?? res.statusText;
    } catch {
      return res.statusText || res.text().slice(0, 200);
    }
  };

  const listModels = async () => {
    try {
      if (provider() === "ollama") {
        const res = await ctx.http.get(`${endpoint()}/api/tags`, { timeoutMs: 4000 });
        return res.ok ? (res.json().models ?? []).map((m) => m.name) : [];
      }
      const res = await ctx.http.get(`${endpoint()}/models`, { timeoutMs: 4000 });
      return res.ok ? (res.json().data ?? []).map((m) => m.id) : [];
    } catch {
      return null; // unreachable
    }
  };

  // ---------- status bar ----------
  let busy = 0;
  const status = ctx.statusBar.add({ icon: "sparkle", tooltip: "", command: "autocomplete.menu", align: "right", priority: 50 });
  const paintStatus = () => {
    const on = s("enabled", true);
    if (progress) {
      const pct = Math.round((progress.fraction ?? 0) * 100);
      status.update({ icon: "cloud-download", text: `${pct}%`, tooltip: `Local Autocomplete: downloading ${progress.label} (${progress.step}/${progress.steps})` });
      return;
    }
    const icon = busy ? "loading~spin" : lastError ? "warning" : on ? "sparkle" : "circle-slash";
    const where = external() ? (provider() === "ollama" ? "Ollama" : "OpenAI-compatible server") : `the built-in engine${engine.running().length ? " (running)" : ""}`;
    const tooltip = lastError
      ? `Local Autocomplete: ${lastError}`
      : `Local Autocomplete ${on ? "on" : "off"} — ${modelLabel(codeModel())} via ${where} (click for options)`;
    status.update({ icon, text: "", tooltip });
  };
  const track = async (p) => {
    busy++;
    paintStatus();
    try {
      return await p;
    } finally {
      busy--;
      paintStatus();
    }
  };
  paintStatus();
  ctx.settings.onDidChange((keys) => {
    warned = false;
    lastError = null;
    // A different model or engine: the old server goes, the next request starts the new one.
    if (keys.some((k) => ["provider", "builtinCodeModel", "builtinCommitModel", "engineBackend", "engineVersion", "contextSize", "gpu", "threads"].includes(k))) {
      engine.stopAll();
      cache.clear();
      offered = false;
    }
    paintStatus();
  });

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

  /** llama-server's /infill: it lays out the model's own fill-in-the-middle tokens, takes other
   *  files as repository context (`input_extra`, Qwen's <|file_sep|> chunks) and stops where the
   *  indentation drops below `n_indent`. */
  const infill = ({ model, prefix, suffix, extra, indent, multiline, maxTokens, temperature }) => {
    let req = null;
    let cancelled = false;
    const nl = prefix.lastIndexOf("\n");
    const p = (async () => {
      const base = await engine.url(model);
      if (cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });
      req = ctx.http.request({
        url: `${base}/infill`, method: "POST", timeoutMs: 30_000,
        body: {
          input_prefix: prefix.slice(0, nl + 1),
          prompt: prefix.slice(nl + 1), // the current line up to the cursor
          input_suffix: suffix,
          input_extra: extra,
          n_predict: maxTokens,
          n_indent: multiline ? indent : 0,
          stop: multiline ? [] : ["\n"],
          temperature,
          top_k: 40,
          top_p: 0.95,
          samplers: ["top_k", "top_p", "infill"],
          cache_prompt: true,
          // A long suggestion is cut at this time instead of keeping the ghost text waiting.
          t_max_predict_ms: Math.max(300, Number(s("maxLatencyMs", 2500)) || 2500),
          stream: false,
        },
      });
      const res = await req;
      if (res.ok) return res.json().content ?? "";
      const why = errorText(res);
      // A GGUF without fill-in-the-middle tokens in its metadata: /infill can't lay the prompt out,
      // so send the model's own format as a plain completion.
      if (!/infill|fim|not supported/i.test(String(why))) throw new Error(`${res.status} ${why}`);
      const fim = FIM[CATALOG[model]?.fim] ?? FIM.qwen;
      req = ctx.http.request({
        url: `${base}/completion`, method: "POST", timeoutMs: 30_000,
        body: {
          prompt: fim.build({ prefix, suffix, path: "", repo: "" }),
          n_predict: maxTokens,
          n_indent: multiline ? indent : 0,
          stop: multiline ? [...fim.stop, "\n\n\n"] : [...fim.stop, "\n"],
          temperature,
          top_k: 40,
          top_p: 0.95,
          cache_prompt: true,
          t_max_predict_ms: Math.max(300, Number(s("maxLatencyMs", 2500)) || 2500),
        },
      });
      const again = await req;
      if (!again.ok) throw new Error(`${again.status} ${errorText(again)}`);
      return again.json().content ?? "";
    })();
    p.cancel = () => {
      cancelled = true;
      req?.cancel();
    };
    return p;
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
    {
      if (!s("enabled", true)) return { items: [] };
      if (!external()) await ensureRec();
      const lang = model.getLanguageId();
      const off = String(s("disabledLanguages", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (off.includes(lang)) return { items: [] };
      const line = model.getLineContent(position.lineNumber);
      const after = line.slice(position.column - 1);
      // Only where a completion can go: end of line, or before closing brackets / quotes.
      if (!/^[\s)\]}>"'`;,.:]*$/.test(after)) return { items: [] };
      const explicit = context?.triggerKind === 1;
      if (!explicit) {
        await sleep(Math.max(0, Number(s("debounceMs", 0)) || (fast && !external() ? 100 : 250)));
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
        const fim = external() ? fimFor(modelId, s("fimFormat", "auto")) : FIM[CATALOG[modelId]?.fim] ?? FIM.qwen;
        const multiline = !!s("multiline", true) && !after.trim();
        const root = ctx.workspace.folder?.();
        const maxTokens = Math.max(8, Number(s("maxTokens", 256)) || 256);
        const temperature = Number(s("temperature", 0.1)) || 0;
        inflight?.cancel();
        const req = external()
          ? complete({
              model: modelId,
              prompt: fim.build({ prefix, suffix, path: relPath(model), repo: root ? ctx.ui.basename(root) : "workspace" }),
              stop: multiline ? [...fim.stop, "\n\n\n"] : [...fim.stop, "\n"],
              maxTokens,
              temperature,
            })
          : infill({
              model: modelId,
              prefix,
              suffix,
              extra: otherFiles(model),
              // New lines may not be indented less than the cursor's line: the suggestion is the
              // rest of the current block and stops where the block ends, as Copilot does.
              indent: (line.slice(0, position.column - 1).match(/^\s*/)?.[0] ?? "").length,
              multiline,
              maxTokens,
              temperature,
            });
        inflight = req;
        const sub = token.onCancellationRequested?.(() => req.cancel());
        try {
          text = tidy(await track(req), { suffix, multiline });
          ok();
          remember(key, text);
        } catch (e) {
          fail(e);
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
    }
  };

  if (monaco?.languages?.registerInlineCompletionsProvider) {
    ctx.subscriptions.push(monaco.languages.registerInlineCompletionsProvider("*", inlineProvider));
    const enableGhost = (ed) => ed?.updateOptions?.({ inlineSuggest: { enabled: true } });
    enableGhost(ctx.editor.monacoEditor?.());
    const sub = monaco.editor.onDidCreateEditor?.(enableGhost);
    if (sub) ctx.subscriptions.push(sub);
  }

  // ---------- commits: context from git ----------
  let gitCache = null; // { at, root, data }
  const gitRoot = async () => {
    try {
      if (ctx.mods.isEnabled?.("aicode.git")) {
        const g = await ctx.mods.get("aicode.git");
        const r = g?.root?.();
        if (r) return r;
      }
    } catch {}
    return ctx.workspace.folder?.() ?? null;
  };
  const git = async (cwd, args) => {
    let out = "";
    try {
      const p = await ctx.process.spawn("git", ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args], {
        cwd, env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        onData: (d, stream) => stream === "stdout" && (out += d),
      });
      return (await p.done) === 0 ? out : "";
    } catch {
      return "";
    }
  };
  const commitContext = async () => {
    const root = await gitRoot();
    if (!root) return null;
    if (gitCache && gitCache.root === root && Date.now() - gitCache.at < 8000) return gitCache.data;
    let stat = await git(root, ["diff", "--cached", "--stat"]);
    let diff = "";
    let staged = true;
    if (stat.trim()) diff = await git(root, ["diff", "--cached", "-U2", "--no-ext-diff"]);
    else {
      // Nothing staged: the Git mod commits every change in that case, so describe those.
      staged = false;
      stat = await git(root, ["diff", "HEAD", "--stat"]);
      diff = await git(root, ["diff", "HEAD", "-U2", "--no-ext-diff"]);
      const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])).trim();
      if (untracked) stat += `\nNew files:\n${untracked.split("\n").slice(0, 30).join("\n")}`;
    }
    const log = (await git(root, ["log", "-n", "15", "--pretty=%s"])).split("\n").map((l) => l.trim()).filter(Boolean);
    const data = { root, stat: stat.trim(), diff: diff.length > 6000 ? `${diff.slice(0, 6000)}\n… (diff truncated)` : diff, log, staged };
    gitCache = { at: Date.now(), root, data };
    return data;
  };

  const styleHint = (log) => {
    const style = s("commitStyle", "auto");
    if (style === "conventional") return "Use Conventional Commits: type(optional scope): subject — types: feat, fix, refactor, perf, docs, style, test, build, ci, chore.";
    if (style === "plain") return "Write a short sentence in the imperative mood, no type prefix.";
    if (!log.length) return "Use Conventional Commits (feat:, fix:, chore:…).";
    return `Follow the exact style of these recent commits of the repository:\n${log.slice(0, 10).map((l) => `- ${l}`).join("\n")}`;
  };

  // ---------- commits: ghost text in the Source Control box ----------
  const ghost = { ta: null, el: null, text: "", timer: null, req: null, seq: 0 };
  const isCommitBox = (el) => el instanceof HTMLTextAreaElement && !!el.closest(".scm-input") && gitOn();

  const clearGhost = () => {
    clearTimeout(ghost.timer);
    ghost.req?.cancel?.();
    ghost.req = null;
    ghost.seq++;
    ghost.text = "";
    ghost.el?.remove();
    ghost.el = null;
    ghost.ta?.classList.remove("lac-has-ghost");
  };

  const paintGhost = () => {
    const ta = ghost.ta;
    if (!ta?.isConnected || !ghost.text) return clearGhost();
    const cs = getComputedStyle(ta);
    const el = ghost.el ?? document.createElement("div");
    el.className = "lac-ghost";
    for (const p of ["font", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle", "textIndent", "tabSize"]) el.style[p] = cs[p];
    Object.assign(el.style, { left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`, width: `${ta.offsetWidth}px`, height: `${ta.offsetHeight}px` });
    el.replaceChildren(
      Object.assign(document.createElement("span"), { className: "lac-typed", textContent: ta.value }),
      Object.assign(document.createElement("span"), { className: "lac-sugg", textContent: ghost.text }),
      Object.assign(document.createElement("span"), { className: "lac-hint", textContent: "Tab" }),
    );
    if (!ghost.el) ta.parentElement.append(el);
    ghost.el = el;
    el.scrollTop = ta.scrollTop;
    ta.classList.add("lac-has-ghost");
  };

  const suggestCommit = async (ta) => {
    if (!s("commitInline", true) || document.activeElement !== ta) return;
    if (ta.selectionStart !== ta.value.length || ta.selectionEnd !== ta.value.length) return;
    const typed = ta.value;
    // Only the subject line is continued; the body is the user's.
    if (typed.includes("\n")) return;
    const seq = ++ghost.seq;
    const c = await commitContext();
    if (!c || (!c.stat && !c.diff) || seq !== ghost.seq) return;
    const prompt = [
      c.log.length ? `Recent commit subjects of this repository (newest first):\n${c.log.slice(0, 12).map((l) => `- ${l}`).join("\n")}\n` : "",
      `Files changed:\n${c.stat}\n`,
      `Diff:\n${c.diff}\n`,
      `${styleHint(c.log).split("\n")[0]}`,
      `Subject line for the commit above, in the same style and language as the recent subjects:`,
      `- ${typed}`,
    ].join("\n");
    const req = complete({
      model: codeModel(),
      prompt,
      stop: ["\n", "<|endoftext|>", "<|file_sep|>", "<|im_end|>", "<|fim_prefix|>"],
      maxTokens: 40,
      temperature: Number(s("temperature", 0.15)) || 0,
    });
    ghost.req = req;
    try {
      let text = String(await track(req)).replace(/\r/g, "").split("\n")[0];
      if (seq !== ghost.seq) return;
      ok();
      if (!typed) text = text.replace(/^\s+/, "");
      text = text.replace(/\s+$/, "").slice(0, 120);
      if (!text.trim()) return;
      // Small models sometimes just repeat a subject from the history they were shown: not a suggestion.
      const whole = (typed + text).trim().toLowerCase();
      if (c.log.some((l) => l.trim().toLowerCase() === whole)) return;
      ghost.ta = ta;
      ghost.text = text;
      paintGhost();
    } catch (e) {
      fail(e);
    } finally {
      if (ghost.req === req) ghost.req = null;
    }
  };

  const schedule = (ta, delay = Number(s("debounceMs", 0)) || 250) => {
    clearGhost();
    ghost.ta = ta;
    ghost.timer = setTimeout(() => suggestCommit(ta), Math.max(150, delay + 150));
  };

  const acceptGhost = (ta, wordOnly = false) => {
    let piece = ghost.text;
    if (wordOnly) piece = piece.match(/^\s*\S+/)?.[0] ?? piece;
    const rest = ghost.text.slice(piece.length);
    const value = ta.value + piece;
    ta.value = value;
    ta.selectionStart = ta.selectionEnd = value.length;
    // The Git mod keeps the message from its own `input` handler.
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    if (rest) {
      ghost.ta = ta;
      ghost.text = rest;
      paintGhost();
    } else clearGhost();
  };

  const onFocusIn = (e) => isCommitBox(e.target) && schedule(e.target, 400);
  const onFocusOut = (e) => isCommitBox(e.target) && clearGhost();
  const onInput = (e) => {
    if (!isCommitBox(e.target)) return;
    if (!e.isTrusted) return; // our own accept, or a generated message
    // Typing the start of the suggestion keeps it instead of asking again.
    if (ghost.text && e.inputType === "insertText" && e.data && ghost.text.startsWith(e.data)) {
      ghost.text = ghost.text.slice(e.data.length);
      if (ghost.text) return paintGhost();
    }
    schedule(e.target);
  };
  const onKey = (e) => {
    if (!isCommitBox(e.target)) return;
    const ta = e.target;
    if (ghost.text && ghost.ta === ta) {
      if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        return acceptGhost(ta);
      }
      if (e.key === "ArrowRight" && (e.metaKey || e.ctrlKey || e.altKey) && ta.selectionStart === ta.value.length) {
        e.preventDefault();
        e.stopPropagation();
        return acceptGhost(ta, true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return clearGhost();
      }
    }
    if (e.key === "\\" && e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      clearGhost();
      ghost.ta = ta;
      suggestCommit(ta);
    }
  };
  const onScroll = (e) => isCommitBox(e.target) && ghost.el && (ghost.el.scrollTop = e.target.scrollTop);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  ctx.subscriptions.push({
    dispose: () => {
      clearGhost();
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
    },
  });

  // ---------- commits: the whole message ----------
  const cleanMessage = (text) => {
    let t = String(text ?? "").replace(/\r/g, "");
    t = t.replace(/<think>[\s\S]*?<\/think>/g, ""); // reasoning models
    const fence = t.match(/```[a-z]*\n([\s\S]*?)```/);
    if (fence) t = fence[1];
    t = t.replace(/^\s*(commit message|message|subject)\s*:\s*/i, "").trim();
    t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
    return t;
  };

  const findCommitBox = () => document.querySelector(".scm-input textarea");
  const writeCommit = async () => {
    if (!external()) await ensureRec();
    const c = await commitContext();
    if (!c) return ctx.window.showInfo("Open a folder with a git repository first.");
    if (!c.stat && !c.diff) return ctx.window.showInfo("There are no changes to describe.");
    const lang = String(s("commitLanguage", "") || "").trim();
    const system = [
      "You write git commit messages. Reply with only the commit message: no explanations, no quotes, no code fences.",
      "First line: at most 72 characters, imperative mood, describing what the change does and why.",
      "If the change is not trivial, add a blank line and a short body (2-5 bullet points starting with '- ').",
      styleHint(c.log),
      lang ? `Write the message in ${lang}.` : c.log.length ? "Write it in the same language as the recent commits." : "",
    ].filter(Boolean).join("\n");
    const user = `${c.staged ? "Staged changes" : "Changes (nothing is staged; all of these will be committed)"}:\n${c.stat}\n\n${c.diff}`;
    let message;
    try {
      message = cleanMessage(await track(chat({ model: commitModel(), system, user })));
      ok();
    } catch (e) {
      warned = false;
      offered = false; // asked for it: offer the download again
      return fail(e);
    }
    if (!message) return ctx.window.showWarning("The model returned an empty message.");
    let ta = findCommitBox();
    if (!ta && ctx.mods.isEnabled?.("aicode.git")) {
      await ctx.views.reveal("scm");
      for (let i = 0; i < 20 && !(ta = findCommitBox()); i++) await sleep(50);
    }
    if (!ta) {
      ctx.window.copy(message);
      return ctx.window.showInfo("Commit message copied to the clipboard.");
    }
    clearGhost();
    ta.value = message;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.selectionStart = ta.selectionEnd = message.length;
  };

  let generating = false;
  const generateCommit = async () => {
    if (!gitOn()) return ctx.window.showInfo("Commit messages need the Source Control (Git) mod: turn it on in Mods.");
    if (generating) return;
    generating = true;
    paintButtons();
    try {
      await writeCommit();
    } finally {
      generating = false;
      paintButtons();
    }
  };

  // ---------- the ✨ button in the Source Control message box ----------
  // The Git mod rebuilds its view often, so the button is put back whenever a message box shows up
  // without one. Only with the Git mod on: without it this mod is code completion alone.
  const BUTTON_TITLE = "Generate Commit Message with the local model (Ctrl+Alt+M)";
  const placeButton = (box) => {
    const ta = box.querySelector("textarea");
    if (!ta) return;
    let btn = box.querySelector(":scope > .lac-generate");
    if (!btn) {
      btn = ctx.ui.iconButton(generating ? "loading~spin" : "sparkle", BUTTON_TITLE, (e) => {
        e.preventDefault();
        generateCommit();
      });
      btn.classList.add("lac-generate");
      btn.tabIndex = -1;
      // Keep the focus (and the ghost text) in the box when the button is pressed.
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      box.append(btn);
      ta.classList.add("lac-with-generate");
    }
    // Top-right corner of the textarea, wherever the Git mod's padding puts it.
    btn.style.top = `${ta.offsetTop + Math.max(0, (Math.min(ta.offsetHeight, 30) - 22) / 2)}px`;
    btn.style.right = `${Math.max(0, box.clientWidth - (ta.offsetLeft + ta.offsetWidth)) + 3}px`;
  };
  const paintButtons = () => {
    for (const btn of document.querySelectorAll(".scm-input > .lac-generate")) {
      btn.replaceChildren(ctx.ui.icon(generating ? "loading~spin" : "sparkle"));
      btn.disabled = generating;
      btn.title = generating ? "Writing the commit message…" : BUTTON_TITLE;
    }
  };
  if (gitOn()) {
    const decorate = () => document.querySelectorAll(".scm-input").forEach(placeButton);
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        decorate();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    decorate();
    ctx.subscriptions.push({
      dispose: () => {
        observer.disconnect();
        document.querySelectorAll(".scm-input > .lac-generate").forEach((b) => b.remove());
        document.querySelectorAll("textarea.lac-with-generate").forEach((t) => t.classList.remove("lac-with-generate"));
      },
    });
  }

  // ---------- commands ----------
  ctx.commands.register("autocomplete.toggle", async () => {
    const on = !s("enabled", true);
    await ctx.settings.set("enabled", on);
    paintStatus();
    ctx.window.showInfo(`Inline completions ${on ? "on" : "off"}.`);
  });

  ctx.commands.register("autocomplete.trigger", () => {
    const active = document.activeElement;
    if (isCommitBox(active)) {
      clearGhost();
      ghost.ta = active;
      return suggestCommit(active);
    }
    const ed = ctx.editor.monacoEditor?.();
    ed?.focus();
    ed?.trigger("autocomplete", "editor.action.inlineSuggest.trigger", {});
  });

  ctx.commands.register("autocomplete.generateCommit", generateCommit);

  const pickModel = async (slot) => {
    if (!slot) {
      const which = await ctx.window.showQuickPick(
        [
          { id: "code", label: "Code model", description: modelLabel(codeModel()), detail: "Ghost text in the editor and the commit box (a base / FIM model)" },
          { id: "commit", label: "Commit message model", description: modelLabel(commitModel()), detail: "Writes whole commit messages (an instruction model)" },
        ],
        { placeholder: "Which model?" },
      );
      if (!which) return;
      slot = which.id;
    }
    if (!external()) return pickBuiltin(slot);
    const key = slot === "code" ? "codeModel" : "commitModel";
    const installed = await listModels();
    const cur = s(key, "");
    const names = [...new Set([...(installed ?? []), ...(provider() === "ollama" ? RECOMMENDED[slot] : [])])];
    const items = names.map((n) => ({
      id: n,
      label: n,
      icon: n === cur ? "check" : installed?.includes(n) ? "vm" : "cloud-download",
      description: installed?.includes(n) ? "installed" : "not downloaded — ollama pull",
    }));
    items.push({ id: "__custom", label: "Other model…", icon: "edit" });
    const picked = await ctx.window.showQuickPick(items, {
      placeholder: installed === null ? `Can't reach ${endpoint()} — pick a name anyway` : `Model for ${slot === "code" ? "code" : "commit messages"}`,
      matchDescription: true,
    });
    if (!picked) return;
    let name = picked.id;
    if (name === "__custom") {
      name = await ctx.window.showInputBox({ prompt: "Model name", value: cur, placeholder: "qwen2.5-coder:1.5b-base" });
      if (!name) return;
    }
    await ctx.settings.set(key, name.trim());
    cache.clear();
    if (provider() === "ollama" && installed && !installed.includes(name)) {
      const go = await ctx.window.confirm(`Download ${name} now?`, "It runs `ollama pull` in the background.", "Download");
      if (go) await pull([name]);
    }
  };

  /** The built-in engine's models: what is on disk, and the size of what is not. */
  const pickBuiltin = async (slot) => {
    const key = slot === "code" ? "builtinCodeModel" : "builtinCommitModel";
    await ensureRec();
    const kind = slot === "code" ? "code" : "commit";
    const auto = s(key, "auto") === "auto" || !CATALOG[s(key, "auto")];
    const cur = slot === "code" ? codeModel() : commitModel();
    const best = rec?.[kind];
    const ids = Object.keys(CATALOG).filter((id) => CATALOG[id].kind === kind);
    const missing = new Set((await engine.missing(ids)).filter((m) => m.kind === "model").map((m) => m.id));
    const items = [
      {
        id: "auto",
        label: `Automatic — ${CATALOG[best]?.label ?? "by this machine"}`,
        icon: auto ? "check" : "sparkle",
        description: missing.has(best) ? `${sizeLabel(CATALOG[best]?.sizeMB ?? 0)} to download` : "downloaded",
        detail: rec?.why ? `What suits your ${rec.why}` : "Chosen by this machine's GPU and memory",
      },
      ...ids.map((id) => ({
        id,
        label: CATALOG[id].label,
        icon: !auto && id === cur ? "check" : missing.has(id) ? "cloud-download" : "vm",
        description: `${CATALOG[id].by} · ${missing.has(id) ? `${sizeLabel(CATALOG[id].sizeMB)} to download` : "downloaded"}`,
        detail: `${CATALOG[id].note}${id === best ? " — recommended here" : ""}`,
      })),
    ];
    const picked = await ctx.window.showQuickPick(items, {
      placeholder: `Model for ${slot === "code" ? "code completion" : "commit messages"} (runs on this machine)`,
      activeIndex: auto ? 0 : Math.max(0, ids.indexOf(cur) + 1),
      matchDescription: true,
    });
    if (!picked) return;
    await ctx.settings.set(key, picked.id);
    cache.clear();
    const id = picked.id === "auto" ? best : picked.id;
    if (id && (await engine.missing([id])).length) await download([id]);
  };
  ctx.commands.register("autocomplete.pickModel", () => pickModel());

  const pull = async (models) => {
    const bin = await ctx.process.which?.("ollama");
    if (!bin) {
      ctx.window.showWarning("Ollama isn't installed (or isn't on the PATH).", { label: "Use the Built-in Engine", run: () => ctx.settings.set("provider", "builtin") });
      return;
    }
    for (const m of models) {
      const item = ctx.statusBar.add({ icon: "cloud-download", text: `${m}…`, tooltip: `Downloading ${m}`, align: "right", priority: 49 });
      let last = "";
      try {
        const p = await ctx.process.spawn("ollama", ["pull", m], {
          onData: (d) => {
            const pct = String(d).match(/(\d{1,3})%/g)?.pop();
            if (pct && pct !== last) item.update({ text: `${m} ${(last = pct)}` });
          },
        });
        const code = await p.done;
        if (code === 0) ctx.window.showInfo(`${m} is ready.`);
        else ctx.window.showError(`ollama pull ${m} failed (exit ${code}).`);
      } catch (e) {
        ctx.window.showError(`ollama pull ${m}: ${e?.message ?? e}`);
      } finally {
        item.dispose();
      }
    }
    warned = false;
    lastError = null;
    paintStatus();
  };
  ctx.commands.register("autocomplete.pullModels", () => {
    const ids = [...new Set([codeModel(), commitModel()])];
    return external() ? pull(ids) : download(ids);
  });

  ctx.commands.register("autocomplete.stopEngine", () => {
    engine.stopAll();
    ctx.window.showInfo("The built-in engine stopped; it starts again with the next suggestion.");
  });

  ctx.commands.register("autocomplete.openModelsFolder", async () => ctx.fs.reveal(await engine.dataDir()));

  ctx.commands.register("autocomplete.menu", async () => {
    const on = s("enabled", true);
    const builtin = !external();
    const running = engine.running();
    const hw = builtin ? await engine.hardware().catch(() => null) : null;
    const backend = builtin ? await engine.backend().catch(() => "cpu") : null;
    const where = backend === "vulkan" ? `GPU (${hw?.gpu?.name ?? "Vulkan"})` : backend === "metal" ? "Metal (Apple GPU)" : "CPU";
    const gpuIdle = builtin && hw?.gpu?.dedicated && backend === "cpu"; // a GPU it isn't using
    const picked = await ctx.window.showQuickPick(
      [
        { id: "toggle", label: on ? "Turn Inline Completions Off" : "Turn Inline Completions On", icon: on ? "circle-slash" : "sparkle" },
        { id: "code", label: "Code Model…", description: modelLabel(codeModel()), icon: "code" },
        { id: "commitModel", label: "Commit Message Model…", description: modelLabel(commitModel()), icon: "git-commit" },
        { id: "commit", label: "Generate Commit Message", icon: "wand" },
        {
          id: "provider",
          label: "Engine…",
          description: builtin ? `Built-in on the ${where}${running.length ? " — running" : ""}` : `${provider() === "ollama" ? "Ollama" : "OpenAI-compatible"} — ${endpoint()}`,
          icon: "server",
        },
        ...(gpuIdle ? [{ id: "gpu", label: "Use the GPU Again", description: hw.gpu.name, icon: "rocket" }] : []),
        ...(builtin ? [{ id: "reprobe", label: "Detect Hardware Again", description: hw?.gpu ? `${hw.gpu.name}${hw.gpu.vramGB ? `, ${hw.gpu.vramGB} GB` : ""} · ${hw.ramGB} GB RAM` : `${hw?.ramGB ?? "?"} GB RAM, no dedicated GPU`, icon: "pulse" }] : []),
        { id: "pull", label: builtin ? "Download the Chosen Models" : "Download the Chosen Models (ollama pull)", icon: "cloud-download" },
        ...(builtin && running.length ? [{ id: "stop", label: "Stop the Engine (free memory)", icon: "debug-stop" }] : []),
        ...(builtin ? [{ id: "folder", label: "Show Models Folder", icon: "folder-opened" }] : []),
      ],
      { placeholder: lastError ? `Local Autocomplete — ${lastError}` : "Local Autocomplete" },
    );
    if (!picked) return;
    if (picked.id === "toggle") return ctx.commands.execute("autocomplete.toggle");
    if (picked.id === "code") return pickModel("code");
    if (picked.id === "commitModel") return pickModel("commit");
    if (picked.id === "commit") return generateCommit();
    if (picked.id === "pull") return ctx.commands.execute("autocomplete.pullModels");
    if (picked.id === "stop") return ctx.commands.execute("autocomplete.stopEngine");
    if (picked.id === "folder") return ctx.commands.execute("autocomplete.openModelsFolder");
    if (picked.id === "gpu") {
      await engine.retryGpu();
      cache.clear();
      return ctx.window.showInfo("The next suggestion starts the engine on the GPU.");
    }
    if (picked.id === "reprobe") {
      engine.stopAll();
      const h = await engine.reprobe();
      rec = recommend(h);
      cache.clear();
      paintStatus();
      return ctx.window.showInfo(`Local Autocomplete: ${rec.why} → ${CATALOG[rec.code]?.label} for code, ${CATALOG[rec.commit]?.label} for commits${s("builtinCodeModel", "auto") === "auto" ? "" : " (you chose your own code model)"}.`);
    }
    if (picked.id === "provider") {
      const p = await ctx.window.showQuickPick(
        [
          { id: "builtin", label: "Built-in", description: "llama.cpp inside AICode — nothing to install (default)", icon: provider() === "builtin" ? "check" : "blank" },
          { id: "ollama", label: "Ollama", description: "an Ollama you already run — http://127.0.0.1:11434", icon: provider() === "ollama" ? "check" : "blank" },
          { id: "openai", label: "OpenAI-compatible", description: "LM Studio, llama.cpp server, vLLM, Jan — http://127.0.0.1:1234/v1", icon: provider() === "openai" ? "check" : "blank" },
        ],
        { placeholder: "Which engine runs the models?" },
      );
      if (!p) return;
      await ctx.settings.set("provider", p.id);
      if (p.id !== "builtin") {
        const url = await ctx.window.showInputBox({ prompt: "Server address (empty for the default)", value: s("endpoint", ""), placeholder: p.description.split(" — ").pop() });
        if (url !== undefined && url !== null) await ctx.settings.set("endpoint", url.trim());
      }
      cache.clear();
      paintStatus();
    }
  });

  return { complete, chat, generateCommit, engine };
}
