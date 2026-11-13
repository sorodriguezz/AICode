// The built-in engine: llama.cpp's `llama-server`, run by this mod, with GGUF models it downloads
// itself. Nothing to install: the first time it is needed, the mod fetches the engine for this
// system (~25–60 MB, from llama.cpp's GitHub releases) and the models (from Hugging Face) into its
// own folder (ctx.storage.dir() → AICode/data/aicode.local-autocomplete/). Each model runs as a
// server on 127.0.0.1 with a random port, started on first use and stopped when idle.
//
// Machines differ, so the engine looks at this one first (hardware()): with a dedicated GPU it uses
// llama.cpp's Vulkan build and bigger models, on Apple silicon Metal and the unified memory, and on
// the CPU small models. If the GPU build fails to start, it falls back to the CPU by itself.
//
//   data/
//   ├── hardware.json                     what hardware() found (probed once)
//   ├── engine/<version>-<backend>/…/llama-server(.exe)
//   ├── engine/gpu-failed                 the GPU build did not start here: use the CPU
//   └── models/<file>.gguf

export const ENGINE_VERSION = "b12362";

/**
 * Models the mod knows how to fetch. Only two jobs, so only two kinds:
 *   code   — base models trained for fill-in-the-middle: ghost text in the editor and the commit box
 *   commit — small instruction models that write a whole commit message from a diff
 * `fim` names the prompt format (used when llama.cpp's /infill can't lay it out from the file);
 * `args` are extra llama-server flags for that model.
 */
export const CATALOG = {
  // ----- code completion -----
  "qwen2.5-coder-0.5b": { label: "Qwen2.5-Coder 0.5B", by: "Alibaba", kind: "code", repo: "ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF", file: "qwen2.5-coder-0.5b-q8_0.gguf", sizeMB: 530, fim: "qwen", note: "fastest; for old or small machines" },
  "qwen2.5-coder-1.5b": { label: "Qwen2.5-Coder 1.5B", by: "Alibaba", kind: "code", repo: "ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF", file: "qwen2.5-coder-1.5b-q8_0.gguf", sizeMB: 1650, fim: "qwen", note: "best on the CPU" },
  "qwen2.5-coder-3b": { label: "Qwen2.5-Coder 3B", by: "Alibaba", kind: "code", repo: "ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF", file: "qwen2.5-coder-3b-q8_0.gguf", sizeMB: 3300, fim: "qwen", note: "a GPU with 6 GB+, or Apple silicon with 16 GB+" },
  "qwen2.5-coder-7b": { label: "Qwen2.5-Coder 7B", by: "Alibaba", kind: "code", repo: "ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF", file: "qwen2.5-coder-7b-q8_0.gguf", sizeMB: 8100, fim: "qwen", note: "most precise; a GPU with 10 GB+, or Apple silicon with 32 GB+" },
  "mellum-4b": { label: "Mellum 4B", by: "JetBrains", kind: "code", repo: "JetBrains/Mellum-4b-base-gguf", file: "mellum-4b-base.Q8_0.gguf", sizeMB: 4270, fim: "mellum", args: ["--spm-infill"], note: "made only for code completion (JetBrains IDEs); a GPU with 6 GB+" },
  "starcoder2-3b": { label: "StarCoder2 3B", by: "BigCode", kind: "code", repo: "second-state/StarCoder2-3B-GGUF", file: "starcoder2-3b-Q4_K_M.gguf", sizeMB: 1850, fim: "starcoder", note: "open data, many languages" },
  "codegemma-2b": { label: "CodeGemma 2B", by: "Google", kind: "code", repo: "bartowski/codegemma-2b-GGUF", file: "codegemma-2b-Q4_K_M.gguf", sizeMB: 1630, fim: "codegemma", note: "built for fast completion" },
  "deepseek-coder-1.3b": { label: "DeepSeek-Coder 1.3B", by: "DeepSeek", kind: "code", repo: "TheBloke/deepseek-coder-1.3b-base-GGUF", file: "deepseek-coder-1.3b-base.Q8_0.gguf", sizeMB: 1430, fim: "deepseek", note: "small and quick" },
  // ----- commit messages -----
  "qwen2.5-coder-0.5b-instruct": { label: "Qwen2.5-Coder 0.5B Instruct", by: "Alibaba", kind: "commit", repo: "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF", file: "qwen2.5-coder-0.5b-instruct-q8_0.gguf", sizeMB: 530, note: "fastest; simple messages" },
  "qwen2.5-coder-1.5b-instruct": { label: "Qwen2.5-Coder 1.5B Instruct", by: "Alibaba", kind: "commit", repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF", file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf", sizeMB: 1120, note: "good messages on any machine" },
  "qwen2.5-coder-3b-instruct": { label: "Qwen2.5-Coder 3B Instruct", by: "Alibaba", kind: "commit", repo: "ggml-org/Qwen2.5-Coder-3B-Instruct-Q8_0-GGUF", file: "qwen2.5-coder-3b-instruct-q8_0.gguf", sizeMB: 3300, note: "better messages; a GPU or Apple silicon" },
  "qwen2.5-coder-7b-instruct": { label: "Qwen2.5-Coder 7B Instruct", by: "Alibaba", kind: "commit", repo: "ggml-org/Qwen2.5-Coder-7B-Instruct-Q8_0-GGUF", file: "qwen2.5-coder-7b-instruct-q8_0.gguf", sizeMB: 8100, note: "best messages; a GPU with 16 GB+" },
  "llama-3.2-1b-instruct": { label: "Llama 3.2 1B Instruct", by: "Meta", kind: "commit", repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: "Llama-3.2-1B-Instruct-Q8_0.gguf", sizeMB: 1320, note: "small, writes plain English well" },
  "llama-3.2-3b-instruct": { label: "Llama 3.2 3B Instruct", by: "Meta", kind: "commit", repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", sizeMB: 2020, note: "clear messages, many languages" },
};

export const sizeLabel = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

/** The models that suit this machine. `hw` is what hardware() found. */
export function recommend(hw) {
  const ram = hw?.ramGB ?? 8;
  const vram = hw?.gpu?.vramGB ?? 0;
  const pick = (code, commit, why) => ({ code, commit, why });
  if (hw?.os === "mac" && hw.arch === "arm64") {
    // Apple silicon: the GPU shares the RAM.
    if (ram >= 32) return pick("qwen2.5-coder-7b", "qwen2.5-coder-3b-instruct", `Apple silicon with ${ram} GB`);
    if (ram >= 16) return pick("qwen2.5-coder-3b", "qwen2.5-coder-1.5b-instruct", `Apple silicon with ${ram} GB`);
    return pick("qwen2.5-coder-1.5b", "qwen2.5-coder-1.5b-instruct", `Apple silicon with ${ram} GB`);
  }
  if (hw?.gpu?.dedicated) {
    const gpu = `${hw.gpu.name}${vram ? ` (${vram} GB)` : ""}`;
    if (vram >= 16) return pick("qwen2.5-coder-7b", "qwen2.5-coder-3b-instruct", gpu);
    if (vram >= 10) return pick("qwen2.5-coder-7b", "qwen2.5-coder-1.5b-instruct", gpu);
    if (vram >= 6) return pick("qwen2.5-coder-3b", "qwen2.5-coder-1.5b-instruct", gpu);
    return pick("qwen2.5-coder-1.5b", "qwen2.5-coder-1.5b-instruct", gpu);
  }
  if (ram >= 8) return pick("qwen2.5-coder-1.5b", "qwen2.5-coder-1.5b-instruct", `CPU with ${ram} GB of RAM`);
  return pick("qwen2.5-coder-0.5b", "qwen2.5-coder-0.5b-instruct", `CPU with ${ram} GB of RAM`);
}

/** Thrown when the engine or a model is not on disk yet (the mod offers the download). */
export class NotInstalled extends Error {
  constructor(missing) {
    super(`Not downloaded yet: ${missing.map((m) => m.label).join(", ")}`);
    this.notInstalled = true;
    this.missing = missing;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HW_VERSION = 1;

// Windows: GPUs, their memory (the registry's 64-bit qwMemorySize — WMI's AdapterRAM stops at 4 GB)
// and the RAM, as JSON. Sent as -EncodedCommand so no quoting can break it.
const WIN_PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
$vram = [int64]0
Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {
  $m = $_.'HardwareInformation.qwMemorySize'
  if ($m -is [array]) { $m = [BitConverter]::ToInt64([byte[]]$m, 0) }
  if ($m -and [int64]$m -gt $vram) { $vram = [int64]$m }
}
$ram = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
[pscustomobject]@{ gpus = $names; vram = $vram; ram = $ram } | ConvertTo-Json -Compress
`;

const LINUX_PROBE = `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1; echo ---; lspci 2>/dev/null | grep -iE 'vga|3d|display'; echo ---; grep MemTotal /proc/meminfo`;

/** A GPU worth running the model on: not integrated graphics or a virtual adapter. */
const isDedicated = (name) =>
  /nvidia|geforce|rtx|gtx|quadro|tesla|radeon(?!.*(vega \d+ graphics|graphics))|\barc\b|instinct|amd .*(rx|pro)/i.test(name) &&
  !/basic|virtual|parsec|remote|uhd|iris|hd graphics/i.test(name);

const utf16Base64 = (text) => {
  let bin = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bin += String.fromCharCode(c & 0xff, c >> 8);
  }
  return btoa(bin);
};

export function createEngine(ctx, { settings, onChange }) {
  const { dirname } = ctx.ui;
  // ctx.ui.joinPath takes two parts; these paths have more.
  const joinPath = (...parts) => parts.reduce((a, b) => ctx.ui.joinPath(a, b));
  let dataDir = null;
  let plat = null;
  let hw = null;
  let hwProbe = null;
  const servers = new Map(); // modelId → { url, proc, last, ready: Promise<string>, log, backend }
  const installing = new Map(); // key → Promise

  const data = async () => {
    if (dataDir) return dataDir;
    const dir = await ctx.storage.dir();
    // 1.1.0 could save the engine archive as a file named "engine" (and a model as "models"),
    // where folders belong: remove those so the next download goes to the right place.
    for (const name of ["engine", "models"]) {
      try {
        const st = await ctx.fs.stat(ctx.ui.joinPath(dir, name));
        if (st.exists && !st.is_dir) await ctx.fs.delete(ctx.ui.joinPath(dir, name), { trash: false });
      } catch {}
    }
    return (dataDir = dir);
  };

  const run = async (program, args, opts = {}) => {
    let out = "";
    let err = "";
    const p = await ctx.process.spawn(program, args, {
      ...opts,
      onData: (d, stream) => {
        if (stream === "stdout") out += d;
        else err += d;
        opts.onData?.(d, stream);
      },
    });
    const code = await p.done;
    return { code, out, err };
  };

  const exists = async (path) => {
    try {
      return !!(await ctx.fs.stat(path)).exists;
    } catch {
      return false;
    }
  };

  const platform = async () => {
    if (plat) return plat;
    const lang = ctx.native?.language;
    const os = lang === "powershell" ? "win" : lang === "jxa" ? "mac" : lang === "python" ? "linux" : /Win/i.test(navigator.platform) ? "win" : /Mac/i.test(navigator.platform) ? "mac" : "linux";
    let arch = "x64";
    try {
      if (os === "win") {
        const r = await run("cmd", ["/d", "/c", "echo %PROCESSOR_ARCHITECTURE%"]);
        if (/ARM64/i.test(r.out)) arch = "arm64";
      } else {
        const r = await run("uname", ["-m"]);
        if (/arm64|aarch64/i.test(r.out)) arch = "arm64";
      }
    } catch {}
    return (plat = { os, arch });
  };

  // ---------- what this machine has ----------
  const probe = async () => {
    const p = await platform();
    const out = { v: HW_VERSION, os: p.os, arch: p.arch, gpu: null, ramGB: 8 };
    const gb = (bytes) => Math.round(Number(bytes) / 1024 ** 3);
    try {
      if (p.os === "win") {
        const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", utf16Base64(WIN_PROBE)]);
        const j = JSON.parse(r.out.trim().split(/\r?\n/).pop() || "{}");
        const names = [].concat(j.gpus ?? []).filter(Boolean);
        const best = names.find(isDedicated);
        if (j.ram) out.ramGB = gb(j.ram);
        if (best) out.gpu = { name: best, vramGB: gb(j.vram || 0), dedicated: true };
        if (best && /nvidia|geforce|rtx|gtx|quadro/i.test(best)) {
          // nvidia-smi is exact where the registry is not.
          const smi = await run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]).catch(() => null);
          const mb = parseInt(smi?.out ?? "", 10);
          if (mb > 0) out.gpu.vramGB = Math.round(mb / 1024);
        }
      } else if (p.os === "mac") {
        const r = await run("sysctl", ["-n", "hw.memsize"]);
        out.ramGB = gb(r.out.trim()) || 8;
        if (p.arch === "arm64") out.gpu = { name: "Apple silicon", vramGB: out.ramGB, dedicated: false, unified: true };
      } else {
        const r = await run("sh", ["-c", LINUX_PROBE]);
        const [smi = "", pci = "", mem = ""] = r.out.split("---").map((x) => x.trim());
        const kb = parseInt(mem.match(/(\d+)/)?.[1] ?? "0", 10);
        if (kb) out.ramGB = Math.round(kb / 1024 ** 2);
        if (smi) {
          const [name, mb] = smi.split(",").map((x) => x.trim());
          out.gpu = { name, vramGB: Math.round(parseInt(mb, 10) / 1024) || 0, dedicated: true };
        } else {
          const line = pci.split("\n").find(isDedicated);
          if (line) out.gpu = { name: line.replace(/^.*?:\s*/, "").replace(/^.*?:\s*/, ""), vramGB: 0, dedicated: true };
        }
      }
    } catch {}
    return out;
  };

  /** This machine's OS, CPU architecture, RAM and GPU (probed once, then read from hardware.json). */
  const hardware = async () => {
    if (hw) return hw;
    return (hwProbe ??= (async () => {
      const file = joinPath(await data(), "hardware.json");
      try {
        const cached = JSON.parse(await ctx.fs.readText(file));
        if (cached?.v === HW_VERSION) return (hw = cached);
      } catch {}
      hw = await probe();
      ctx.fs.writeText(file, JSON.stringify(hw, null, 2)).catch(() => {});
      return hw;
    })());
  };
  const reprobe = async () => {
    hw = null;
    hwProbe = null;
    try {
      await ctx.fs.delete(joinPath(await data(), "hardware.json"), { trash: false });
    } catch {}
    return hardware();
  };

  // ---------- which build of llama.cpp ----------
  const gpuFailedFile = async () => joinPath(await data(), "engine", "gpu-failed");
  /** "metal" (macOS), "vulkan" (a dedicated GPU, unless it failed here) or "cpu". */
  const backend = async () => {
    const p = await platform();
    if (p.os === "mac") return "metal";
    const b = settings("engineBackend", "auto");
    if (b === "cpu" || b === "vulkan") return b;
    if (await exists(await gpuFailedFile())) return "cpu";
    const h = await hardware();
    return h.gpu?.dedicated ? "vulkan" : "cpu";
  };
  const version = () => String(settings("engineVersion", ENGINE_VERSION) || ENGINE_VERSION).trim();

  const assetName = async (b) => {
    const p = await platform();
    const v = version();
    if (p.os === "mac") return `llama-${v}-bin-macos-${p.arch}.tar.gz`;
    if (p.os === "win") return `llama-${v}-bin-win-${b === "vulkan" ? "vulkan" : "cpu"}-${p.arch}.zip`;
    return `llama-${v}-bin-ubuntu-${b === "vulkan" ? "vulkan-" : ""}${p.arch}.tar.gz`;
  };
  const engineDir = async (b) => joinPath(await data(), "engine", `${version()}-${b ?? (await backend())}`);
  const modelPath = async (id) => joinPath(await data(), "models", CATALOG[id]?.file ?? `${id}.gguf`);

  /** The llama-server binary inside the engine folder (the archives nest it differently). */
  const findServer = async (dir, depth = 0) => {
    const exe = (await platform()).os === "win" ? "llama-server.exe" : "llama-server";
    let entries = [];
    try {
      entries = await ctx.fs.readDir(dir);
    } catch {
      return null;
    }
    const hit = entries.find((e) => !e.is_dir && e.name === exe);
    if (hit) return hit.path;
    if (depth >= 3) return null;
    for (const e of entries.filter((x) => x.is_dir)) {
      const found = await findServer(e.path, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const engineInstalled = async (b) => !!(await findServer(await engineDir(b)));
  const modelInstalled = async (id) => exists(await modelPath(id));

  /** What is missing to run these models: [{ kind: "engine" | "model", id, label, sizeMB }]. */
  const missing = async (ids) => {
    const out = [];
    const b = await backend();
    if (!(await engineInstalled(b))) out.push({ kind: "engine", id: b, label: `llama.cpp engine (${b === "vulkan" ? "GPU, Vulkan" : b === "metal" ? "Metal" : "CPU"})`, sizeMB: b === "vulkan" ? 45 : 30 });
    for (const id of new Set(ids)) {
      if (!CATALOG[id]) continue;
      if (!(await modelInstalled(id))) out.push({ kind: "model", id, label: CATALOG[id].label, sizeMB: CATALOG[id].sizeMB });
    }
    return out;
  };

  /** On Windows, a tool that ships with Windows itself (System32). `which` can find another one
   *  first — Git for Windows puts GNU tar and curl on the PATH, and GNU tar takes `C:` for a remote
   *  host and cannot open zips. */
  let sys32 = undefined;
  const systemTool = async (name) => {
    if ((await platform()).os === "win") {
      if (sys32 === undefined) {
        const r = await run("cmd", ["/d", "/c", "echo %SystemRoot%"]).catch(() => ({ out: "" }));
        const root = r.out.trim().replace(/\\/g, "/");
        sys32 = root && !root.includes("%") ? `${root}/System32` : "C:/Windows/System32";
      }
      const path = `${sys32}/${name}.exe`;
      if (await exists(path)) return path;
      return null;
    }
    return (await ctx.process.which(name)) ?? name;
  };

  /** Unpacks a .zip or .tar.gz into `dir`. */
  const unpack = async (archive, dir) => {
    const tar = await systemTool("tar");
    if (tar) {
      const r = await run(tar, ["-xf", archive, "-C", dir]);
      if (r.code === 0) return;
      if ((await platform()).os !== "win") throw new Error(`could not unpack the engine: ${r.err.trim() || `tar exited with ${r.code}`}`);
    }
    // Windows without bsdtar (older than Windows 10 1803): PowerShell's Expand-Archive.
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(dir)} -Force`]);
    if (r.code !== 0) throw new Error(`could not unpack the engine: ${r.err.trim() || `Expand-Archive exited with ${r.code}`}`);
  };

  /** Downloads `url` to `dest` with curl (resumable), reporting 0..1 through onProgress. */
  const download = async (url, dest, { sizeMB, onProgress }) => {
    const curl = (await systemTool("curl")) ?? (await ctx.process.which("curl")) ?? "curl";
    await ctx.fs.create(dirname(dest), true).catch(() => {});
    const part = `${dest}.part`;
    let pct = 0;
    const timer = setInterval(async () => {
      if (!sizeMB) return;
      try {
        const st = await ctx.fs.stat(part);
        if (st.exists) onProgress?.(Math.min(0.99, st.size / (sizeMB * 1024 * 1024)));
      } catch {}
    }, 800);
    try {
      const r = await run(curl, ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "-C", "-", "-#", "-o", part, url], {
        // With a known size the file on disk is the progress: curl's own meter also reports the
        // redirect (Hugging Face, GitHub) as 100% before the real download starts.
        onData: (d) => {
          if (sizeMB) return;
          const m = String(d).match(/(\d{1,3}(?:\.\d)?)%/g);
          if (m) {
            const v = parseFloat(m[m.length - 1]) / 100;
            if (v > pct) onProgress?.((pct = v));
          }
        },
      });
      // 33: the server does not resume (the .part is already whole) — check it below.
      if (r.code !== 0 && r.code !== 33) throw new Error(`download failed (curl ${r.code}): ${r.err.split(/[\r\n]/).filter((l) => l && !l.includes("#")).pop() ?? url}`);
      if (await exists(dest)) await ctx.fs.delete(dest, { trash: false });
      await ctx.fs.rename(part, dest);
    } finally {
      clearInterval(timer);
    }
  };

  const installEngine = async (b, onProgress) => {
    const dir = await engineDir(b);
    const name = await assetName(b);
    const archive = joinPath(await data(), "engine", name);
    await download(`https://github.com/ggml-org/llama.cpp/releases/download/${version()}/${name}`, archive, { sizeMB: b === "vulkan" ? 45 : 30, onProgress });
    await ctx.fs.create(dir, true).catch(() => {});
    await unpack(archive, dir);
    await ctx.fs.delete(archive, { trash: false }).catch(() => {});
    const bin = await findServer(dir);
    if (!bin) throw new Error(`llama-server is not in ${name}`);
    if ((await platform()).os !== "win") await run("chmod", ["+x", bin]).catch(() => {});
  };

  const installModel = async (id, onProgress) => {
    const m = CATALOG[id];
    if (!m) throw new Error(`unknown model ${id}`);
    await download(`https://huggingface.co/${m.repo}/resolve/main/${m.file}`, await modelPath(id), { sizeMB: m.sizeMB, onProgress });
  };

  /** Downloads what is missing for these models. onProgress({ label, fraction, step, steps }). */
  const install = async (ids, onProgress) => {
    const key = [...ids].sort().join("+");
    if (installing.has(key)) return installing.get(key);
    const job = (async () => {
      const todo = await missing(ids);
      let step = 0;
      for (const item of todo) {
        step++;
        const report = (fraction) => onProgress?.({ label: item.label, fraction, step, steps: todo.length });
        report(0);
        if (item.kind === "engine") await installEngine(item.id, report);
        else await installModel(item.id, report);
        report(1);
      }
      onChange?.();
    })();
    installing.set(key, job);
    try {
      await job;
    } finally {
      installing.delete(key);
    }
  };

  const stop = (id) => {
    const s = servers.get(id);
    if (!s) return;
    servers.delete(id);
    try {
      s.proc?.kill();
    } catch {}
    try {
      s.watchdog?.kill();
    } catch {}
    onChange?.();
  };

  const idleMinutes = () => Math.max(1, Number(settings("idleMinutes", 5)) || 5);

  /**
   * A watchdog for one engine: a tiny script AICode starts next to it that ends the engine as soon
   * as AICode itself is gone (a crash, Ctrl+C on a dev build, a forced quit) — the mod's own idle
   * timer dies with AICode, the watchdog does not. It finds the engine by its port, remembers the
   * engine's parent (AICode) and checks both every 15 s; it ends by itself when the engine does.
   */
  const watch = async (port) => {
    const p = await platform();
    if (p.os === "win") {
      const script = `
Start-Sleep -Seconds 1
$srv = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.CommandLine -match '--port ${port}(\\s|$)' } | Select-Object -First 1
if (-not $srv) { exit }
$app = $srv.ParentProcessId
while ($true) {
  Start-Sleep -Seconds 15
  if (-not (Get-Process -Id $srv.ProcessId -ErrorAction SilentlyContinue)) { exit }
  if (-not (Get-Process -Id $app -ErrorAction SilentlyContinue)) { Stop-Process -Id $srv.ProcessId -Force -ErrorAction SilentlyContinue; exit }
}`;
      return ctx.process.spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", utf16Base64(script)], {});
    }
    const script = `
sleep 1
srv=$(ps -eo pid=,args= | grep -- '--port ${port}' | grep llama-server | grep -v grep | awk '{print $1}' | head -n 1)
[ -z "$srv" ] && exit 0
app=$(ps -o ppid= -p "$srv" | tr -d ' ')
while sleep 15; do
  kill -0 "$srv" 2>/dev/null || exit 0
  kill -0 "$app" 2>/dev/null || { kill "$srv"; exit 0; }
done`;
    return ctx.process.spawn("sh", ["-c", script], {});
  };
  const stopAll = () => [...servers.keys()].forEach(stop);

  /** Starts llama-server for a model with one build of the engine; resolves to its URL. */
  const launch = async (id, entry, b) => {
    const p = await platform();
    const bin = await findServer(await engineDir(b));
    if (!bin) throw new NotInstalled(await missing([id]));
    const model = await modelPath(id);
    const port = 39000 + Math.floor(Math.random() * 900);
    const url = `http://127.0.0.1:${port}`;
    entry.log = "";
    entry.backend = b;
    const args = [
      "-m", model, "--host", "127.0.0.1", "--port", String(port),
      "-c", String(Number(settings("contextSize", 8192)) || 8192),
      "-ngl", String(settings("gpu", true) && b !== "cpu" ? 99 : 0),
      "-np", "1", "--cache-reuse", "256",
      // Safety net: even if nothing else stops it, an idle engine lets go of the model's memory.
      "--sleep-idle-seconds", String(idleMinutes() * 60 + 30),
      ...(CATALOG[id]?.args ?? []),
    ];
    if (b !== "cpu") args.push("-fa", "auto"); // flash attention where the GPU supports it
    const threads = Number(settings("threads", 0)) || 0;
    if (threads > 0) args.push("-t", String(threads));
    const env = p.os === "linux" ? { LD_LIBRARY_PATH: dirname(bin) } : undefined;
    let exited = null;
    entry.proc = await ctx.process.spawn(bin, args, {
      cwd: dirname(bin),
      env,
      onData: (d) => (entry.log = (entry.log + d).slice(-4000)),
    });
    entry.proc.done.then((code) => {
      exited = code;
      if (servers.get(id) === entry && entry.url) servers.delete(id);
      onChange?.();
    });
    // Wait for the model to load (/health is 503 while loading).
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (exited !== null) {
        const tail = entry.log.split(/\r?\n/).filter(Boolean).slice(-4).join(" · ");
        throw Object.assign(new Error(`the engine stopped (exit ${exited})${tail ? `: ${tail}` : ""}`), { engineExited: true });
      }
      try {
        const res = await ctx.http.get(`${url}/health`, { timeoutMs: 1500 });
        if (res.ok) {
          entry.url = url;
          entry.watchdog = await watch(port).catch(() => null);
          // The engine stopped on its own while the watchdog started: nothing left to watch.
          if (exited !== null) entry.watchdog?.kill();
          onChange?.();
          return url;
        }
      } catch {}
      await sleep(300);
    }
    try {
      entry.proc.kill();
    } catch {}
    throw new Error("the engine took too long to load the model");
  };

  /** Engines left behind when AICode was killed (a crash, Ctrl+C on a dev build) keep their memory
   *  — gigabytes of RAM or VRAM. Before starting one, end those: only llama-server processes run
   *  from this mod's own folder whose parent is gone, so another open window's engine is safe. */
  let reaped = false;
  const reapOrphans = async () => {
    if (reaped) return;
    reaped = true;
    const p = await platform();
    const dir = joinPath(await data(), "engine");
    try {
      if (p.os === "win") {
        const script = `
$dir = '${dir.replace(/'/g, "''").replace(/\//g, "\\")}'
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) -and
  -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        await run("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", utf16Base64(script)]);
      } else {
        // An orphan is adopted by init/launchd (parent 1).
        const r = await run("ps", ["-eo", "pid=,ppid=,args="]);
        for (const line of r.out.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (m && m[2] === "1" && m[3].includes(dir) && /llama-server/.test(m[3])) await run("kill", [m[1]]).catch(() => {});
        }
      }
    } catch {}
  };

  const start = async (id, entry) => {
    const need = await missing([id]);
    if (need.length) throw new NotInstalled(need);
    await reapOrphans();
    const b = await backend();
    try {
      return await launch(id, entry, b);
    } catch (e) {
      // The GPU build did not start (no Vulkan driver, a GPU it can't use, out of video memory):
      // remember it and use the CPU build from now on, downloading it if needed (~30 MB).
      if (b !== "vulkan" || settings("engineBackend", "auto") !== "auto" || e?.notInstalled) throw e;
      await ctx.fs.create(joinPath(await data(), "engine"), true).catch(() => {});
      await ctx.fs.writeText(await gpuFailedFile(), `${new Date().toISOString()}\n${String(e?.message ?? e)}\n`).catch(() => {});
      onChange?.({ fellBack: String(e?.message ?? e) });
      if (!(await engineInstalled("cpu"))) await installEngine("cpu");
      return await launch(id, entry, "cpu");
    }
  };

  /** The base URL of a running server for this model, starting it if needed. */
  const url = async (id) => {
    let s = servers.get(id);
    if (!s) {
      s = { url: null, proc: null, last: Date.now(), log: "", ready: null, backend: null };
      servers.set(id, s);
      s.ready = start(id, s);
      s.ready.catch(() => servers.get(id) === s && servers.delete(id));
    }
    await s.ready;
    if (servers.get(id) !== s || !s.url) throw new Error("the engine stopped");
    s.last = Date.now();
    return s.url;
  };

  /** Try the GPU again (after a driver update, say): forget that it failed. */
  const retryGpu = async () => {
    try {
      await ctx.fs.delete(await gpuFailedFile(), { trash: false });
    } catch {}
    stopAll();
  };

  // Free the memory of models nobody used for a while.
  const idle = setInterval(() => {
    const ms = idleMinutes() * 60_000;
    for (const [id, s] of servers) if (s.url && Date.now() - s.last > ms) stop(id);
  }, 30_000);
  ctx.subscriptions.push({ dispose: () => (clearInterval(idle), stopAll()) });

  return {
    platform,
    hardware,
    reprobe,
    backend,
    retryGpu,
    missing,
    install,
    url,
    stop,
    stopAll,
    running: () => [...servers.entries()].filter(([, s]) => s.url).map(([id, s]) => ({ id, backend: s.backend })),
    isInstalling: () => installing.size > 0,
    dataDir: data,
  };
}
