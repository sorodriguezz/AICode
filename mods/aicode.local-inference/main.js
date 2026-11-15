// Local model transport, lifecycle and administration for AICode mods.
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

export async function activate(ctx) {
  const s = (key, fallback) => ctx.settings.getNow(key, fallback);

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
          `Local Inference: the GPU engine didn't start here, so it runs on the CPU (slower). ${info.fellBack.slice(0, 160)}`,
          { label: "Try the GPU Again", run: () => engine.retryGpu() },
        );
    },
  });
  // Look at the hardware in the background: the first suggestion then needn't wait for it.
  let fast = false; // a GPU (or Apple silicon) answers quickly: wait less after the last key
  const prepare = () => external() ? Promise.resolve() : ensureRec().catch(() => null);
  const isFast = () => !external() && fast && s("gpu", true);
  const detectSpeed = () => {
    if (external()) return;
    prepare().then(async () => {
      fast = (await engine.backend()) !== "cpu";
      paintStatus();
    }).catch(() => {});
  };
  const warmCodeModel = async () => {
    if (external()) return;
    await prepare();
    const id = codeModel();
    if (!(await engine.missing([id])).length) await engine.url(id);
  };

  let lastError = null;
  let warned = false;
  const offered = new Set();
  const fail = (e, { slot = "code", explicit = false } = {}) => {
    if (e?.cancelled) return;
    if (explicit) warned = false;
    if (e?.notInstalled) return offerDownload(e.missing, slot, explicit);
    lastError = String(e?.message ?? e);
    paintStatus();
    if (warned) return;
    warned = true;
    if (!external()) {
      ctx.window.showWarning(`Local Inference: ${lastError}`, { label: "Options…", run: () => ctx.commands.execute("autocomplete.menu") });
      return;
    }
    const where = provider() === "ollama" ? "Ollama" : "the local model server";
    ctx.window.showWarning(
      `Local Inference can't reach ${where} at ${endpoint()}: ${lastError}`,
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
      ctx.window.showInfo(`Local Inference is ready: ${ids.map(modelLabel).join(" and ")} run on this machine.`);
      return true;
    } catch (e) {
      progress = null;
      lastError = String(e?.message ?? e);
      paintStatus();
      ctx.window.showError(`Local Inference: ${lastError}`, { label: "Try Again", run: () => download(ids) });
      return false;
    }
  };
  /** The first time a model is needed: ask once per session before downloading gigabytes. */
  const offerDownload = (missing, slot, explicit) => {
    const model = slot === "code" ? codeModel() : commitModel();
    if ((!explicit && offered.has(model)) || engine.isInstalling()) return;
    offered.add(model);
    const total = missing.reduce((n, m) => n + m.sizeMB, 0);
    const ids = missing.filter((m) => m.kind === "model").map((m) => m.id);
    ctx.window.showInfo(
      `Local Inference runs ${missing.map((m) => m.label).join(" + ")} on this machine${rec?.why && s(slot === "code" ? "builtinCodeModel" : "builtinCommitModel", "auto") === "auto" ? `, chosen for your ${rec.why}` : ""}. Download now (${sizeLabel(total)}, only once)?`,
      { label: "Download", run: () => download(ids.length ? ids : [model]) },
      { label: "Choose Model…", run: () => pickModel(slot) },
    );
  };

  /** Where to send requests: the built-in server for that model (started on demand) or the user's. */
  const baseFor = (model, kind) => kind === "builtin" ? engine.url(model) : endpoint();

  /** Raw text completion (FIM or plain continuation). Resolves to the text; `.cancel()` stops it. */
  const complete = ({ model, prompt, stop, maxTokens, temperature }) => {
    let req = null;
    let cancelled = false;
    const p = (async () => {
      const kind = provider();
      const base = await baseFor(model, kind);
      if (cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });
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
    const kind = provider();
    const base = await baseFor(model, kind);
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
    if (progress) {
      const pct = Math.round((progress.fraction ?? 0) * 100);
      status.update({ icon: "cloud-download", text: `${pct}%`, tooltip: `Local Inference: downloading ${progress.label} (${progress.step}/${progress.steps})` });
      return;
    }
    const icon = busy ? "loading~spin" : lastError ? "warning" : "sparkle";
    const where = external() ? (provider() === "ollama" ? "Ollama" : "OpenAI-compatible server") : `the built-in engine${engine.running().length ? " (running)" : ""}`;
    const tooltip = lastError
      ? `Local Inference: ${lastError}`
      : `Local Inference via ${where} (click for options)`;
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
    offered.clear();
    // A different model or engine: the old server goes, the next request starts the new one.
    if (keys.some((k) => ["provider", "builtinCodeModel", "builtinCommitModel", "engineBackend", "engineVersion", "contextSize", "gpu", "threads"].includes(k))) {
      engine.stopAll();
      detectSpeed();
    }
    paintStatus();
  });

  /** llama-server's /infill: it lays out the model's own fill-in-the-middle tokens, takes other
   *  files as repository context (`input_extra`, Qwen's <|file_sep|> chunks) and stops where the
   *  indentation drops below `n_indent`. */
  const fill = ({ model, prefix, suffix, path, repo, extra, indent, multiline, maxTokens, temperature, maxLatencyMs }) => {
    if (external()) {
      const fim = fimFor(model, s("fimFormat", "auto"));
      return complete({ model, prompt: fim.build({ prefix, suffix, path, repo }), stop: [...fim.stop, multiline ? "\n\n\n" : "\n"], maxTokens, temperature });
    }
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
          input_extra: extra?.(),
          n_predict: maxTokens,
          n_indent: multiline ? indent : 0,
          stop: multiline ? [] : ["\n"],
          temperature,
          top_k: 40,
          top_p: 0.95,
          samplers: ["top_k", "top_p", "infill"],
          cache_prompt: true,
          // A long suggestion is cut at this time instead of keeping the ghost text waiting.
          t_max_predict_ms: Math.max(300, Number(maxLatencyMs) || 2500),
          stream: false,
        },
      });
      const res = await req;
      if (res.ok) return res.json().content ?? "";
      const why = errorText(res);
      // A GGUF without fill-in-the-middle tokens in its metadata: /infill can't lay the prompt out,
      // so send the model's own format as a plain completion.
      if (!/infill|fim|not supported/i.test(String(why))) throw new Error(`${res.status} ${why}`);
      if (cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });
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
          t_max_predict_ms: Math.max(300, Number(maxLatencyMs) || 2500),
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
  const hasCode = () => ctx.mods.isEnabled("aicode.local-autocomplete");
  const hasCommits = () => ctx.mods.isEnabled("aicode.commit-assistant");
  ctx.commands.register("autocomplete.pullModels", async () => {
    await prepare();
    const ids = [];
    if (hasCode() || !hasCommits() || ctx.config.getFor("aicode.commit-assistant", "commitInline", true)) ids.push(codeModel());
    if (hasCommits() || !hasCode()) ids.push(commitModel());
    if (provider() === "openai") return ctx.window.showInfo("Install models from your OpenAI-compatible server.");
    return external() ? pull([...new Set(ids)]) : download([...new Set(ids)]);
  });

  ctx.commands.register("autocomplete.stopEngine", () => {
    engine.stopAll();
    ctx.window.showInfo("The built-in engine stopped; it starts again with the next suggestion.");
  });

  ctx.commands.register("autocomplete.openModelsFolder", async () => ctx.fs.reveal(await engine.dataDir()));

  ctx.commands.register("autocomplete.menu", async () => {
    const on = ctx.config.getFor("aicode.local-autocomplete", "enabled", true);
    const builtin = !external();
    const running = engine.running();
    const hw = builtin ? await engine.hardware().catch(() => null) : null;
    const backend = builtin ? await engine.backend().catch(() => "cpu") : null;
    const where = backend === "vulkan" ? `GPU (${hw?.gpu?.name ?? "Vulkan"})` : backend === "metal" ? "Metal (Apple GPU)" : "CPU";
    const gpuIdle = builtin && hw?.gpu?.dedicated && backend === "cpu"; // a GPU it isn't using
    const picked = await ctx.window.showQuickPick(
      [
        ...(hasCode() ? [{ id: "toggle", label: on ? "Turn Inline Completions Off" : "Turn Inline Completions On", icon: on ? "circle-slash" : "sparkle" }] : []),
        { id: "code", label: "Code Model…", description: modelLabel(codeModel()), icon: "code" },
        { id: "commitModel", label: "Commit Message Model…", description: modelLabel(commitModel()), icon: "git-commit" },
        ...(hasCommits() ? [{ id: "commit", label: "Generate Commit Message", icon: "wand" }] : []),
        {
          id: "provider",
          label: "Engine…",
          description: builtin ? `Built-in on the ${where}${running.length ? " — running" : ""}` : `${provider() === "ollama" ? "Ollama" : "OpenAI-compatible"} — ${endpoint()}`,
          icon: "server",
        },
        ...(gpuIdle ? [{ id: "gpu", label: "Use the GPU Again", description: hw.gpu.name, icon: "rocket" }] : []),
        ...(builtin ? [{ id: "reprobe", label: "Detect Hardware Again", description: hw?.gpu ? `${hw.gpu.name}${hw.gpu.vramGB ? `, ${hw.gpu.vramGB} GB` : ""} · ${hw.ramGB} GB RAM` : `${hw?.ramGB ?? "?"} GB RAM, no dedicated GPU`, icon: "pulse" }] : []),
        ...(provider() !== "openai" ? [{ id: "pull", label: builtin ? "Download the Chosen Models" : "Download the Chosen Models (ollama pull)", icon: "cloud-download" }] : []),
        ...(builtin && running.length ? [{ id: "stop", label: "Stop the Engine (free memory)", icon: "debug-stop" }] : []),
        ...(builtin ? [{ id: "folder", label: "Show Models Folder", icon: "folder-opened" }] : []),
      ],
      { placeholder: lastError ? `Local Inference — ${lastError}` : "Local Inference" },
    );
    if (!picked) return;
    if (picked.id === "toggle") return ctx.commands.execute("autocomplete.toggle");
    if (picked.id === "code") return pickModel("code");
    if (picked.id === "commitModel") return pickModel("commit");
    if (picked.id === "commit") return ctx.commands.execute("autocomplete.generateCommit");
    if (picked.id === "pull") return ctx.commands.execute("autocomplete.pullModels");
    if (picked.id === "stop") return ctx.commands.execute("autocomplete.stopEngine");
    if (picked.id === "folder") return ctx.commands.execute("autocomplete.openModelsFolder");
    if (picked.id === "gpu") {
      await engine.retryGpu();
      detectSpeed();
      return ctx.window.showInfo("The next suggestion starts the engine on the GPU.");
    }
    if (picked.id === "reprobe") {
      engine.stopAll();
      const h = await engine.reprobe();
      rec = recommend(h);
      detectSpeed();
      paintStatus();
      return ctx.window.showInfo(`Local Inference: ${rec.why} → ${CATALOG[rec.code]?.label} for code, ${CATALOG[rec.commit]?.label} for commits${s("builtinCodeModel", "auto") === "auto" ? "" : " (you chose your own code model)"}.`);
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
      paintStatus();
    }
  });

  detectSpeed();
  return { complete, fill, chat, prepare, codeModel, commitModel, warmCodeModel, isFast, engine, fail, ok, track };
}
