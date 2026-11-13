// `ctx.native` on Windows and Linux. macOS runs JavaScript for Automation inside AICode (native.rs);
// the other systems have no such bridge, so a mod writes its native code in the system's own
// scripting language instead, run in a helper process:
//
//   Windows  PowerShell (powershell.exe): .NET and, through Add-Type, any Win32 API
//   Linux    Python 3 (python3): D-Bus, GTK (gi), X11/Wayland tools, ctypes
//
// The API is the same on every system: `eval(source, { args })` (the body of a function: `return`
// a value), `open(source)` (functions that stay, `call(name, ...args)`, `emit(channel, data)`) and
// `spawn(source)` (`send`, `receive`, `keepAlive`). `ctx.native.language` says which one runs.
//
// The protocol: the script goes as the first line on the helper's standard input (one JSON
// string); after it, one JSON request per line. The helper answers with one JSON object per line
// on standard output: { __aicode: "result" | "ready" | "emit", ... }. In `spawn`, the lines are
// the script's own messages.

import { IS_WINDOWS } from "./ui";

export type NativeLanguage = "jxa" | "powershell" | "python";
export const NATIVE_LANGUAGE: NativeLanguage = navigator.platform.toLowerCase().includes("mac") ? "jxa" : IS_WINDOWS ? "powershell" : "python";

type Proc = { done: Promise<number | null>; kill(): Promise<unknown>; write(data: string): Promise<void>; end(): Promise<void> };
export type SpawnProc = (
  program: string,
  args: string[],
  opts: { keepStdin?: boolean; onData?: (data: any, stream: "stdout" | "stderr") => void; onExit?: (code: number | null) => void },
) => Promise<Proc>;

type Mode = "eval" | "open" | "spawn";

// ---------- PowerShell ----------

// Reads the script (a JSON string) from the first line of stdin and runs it in this scope, so
// the functions it defines stay. UTF-8 both ways whatever the console code page. No `"` in it:
// Windows PowerShell 5.1 mangles double quotes in its command line.
const PS_BOOT =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  "$__in=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false));" +
  "$__out=[IO.StreamWriter]::new([Console]::OpenStandardOutput(),[Text.UTF8Encoding]::new($false));$__out.AutoFlush=$true;" +
  ". ([scriptblock]::Create(($__in.ReadLine() | ConvertFrom-Json)))";

/** JSON in a PowerShell single-quoted string: ASCII only (no curly quotes, which PowerShell also reads as quotes), `'` doubled. */
const psJson = (value: unknown) =>
  `'${(JSON.stringify(value ?? null) ?? "null").replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).replace(/'/g, "''")}'`;

function psScript(mode: Mode, source: string, args: unknown): string {
  const prelude = `
function __aicode_write($o) { $__out.WriteLine((ConvertTo-Json -InputObject $o -Depth 32 -Compress)) }
$Arguments = ${args == null ? "$null" : `ConvertFrom-Json -InputObject ${psJson(args)}`}
function emit($channel, $data) { __aicode_write @{ __aicode = 'emit'; channel = [string]$channel; data = $data } }
`;
  if (mode === "eval") {
    return `${prelude}
try { $__r = & {
${source}
}; __aicode_write @{ __aicode = 'result'; ok = $true; value = $__r } }
catch { __aicode_write @{ __aicode = 'result'; ok = $false; error = [string]$_ } }
`;
  }
  if (mode === "open") {
    return `${prelude}
try {
${source}
} catch { __aicode_write @{ __aicode = 'ready'; ok = $false; error = [string]$_ }; exit 1 }
__aicode_write @{ __aicode = 'ready'; ok = $true }
while ($null -ne ($__line = $__in.ReadLine())) {
  if (-not $__line.Trim()) { continue }
  $__req = ConvertFrom-Json -InputObject $__line
  try {
    $__fn = Get-Command -Name $__req.name -CommandType Function -ErrorAction Stop
    $__a = @($__req.args)
    $__r = & $__fn @__a
    __aicode_write @{ __aicode = 'result'; id = $__req.id; ok = $true; value = $__r }
  } catch { __aicode_write @{ __aicode = 'result'; id = $__req.id; ok = $false; error = [string]$_ } }
}
if (Get-Command -Name dispose -CommandType Function -ErrorAction SilentlyContinue) { dispose }
`;
  }
  return `${prelude}
function send($data) { __aicode_write $data }
$script:__receive = $null
function receive([scriptblock]$fn) { $script:__receive = $fn }
function keepAlive {
  while ($null -ne ($__line = $__in.ReadLine())) {
    if (-not $__line.Trim() -or -not $script:__receive) { continue }
    try { & $script:__receive (ConvertFrom-Json -InputObject $__line) } catch { send @{ error = [string]$_ } }
  }
  exit 0
}
${source}
`;
}

// ---------- Python ----------

const PY_BOOT = "import sys,json;exec(compile(json.loads(sys.stdin.readline()),'<aicode>','exec'))";

function pyScript(mode: Mode, source: string, args: unknown): string {
  // JSON.stringify gives a valid Python string literal.
  const prelude = `import sys, json
args = json.loads(${JSON.stringify(JSON.stringify(args ?? null))})
def __aicode_write(o):
    sys.stdout.write(json.dumps(o, default=str) + "\\n")
    sys.stdout.flush()
def emit(channel, data=None):
    __aicode_write({"__aicode": "emit", "channel": str(channel), "data": data})
def __aicode_error(e):
    return f"{type(e).__name__}: {e}"
__aicode_src = ${JSON.stringify(source)}
`;
  if (mode === "eval") {
    // The source is the body of a function (it may \`return\`), kept exactly as written.
    return `${prelude}
import ast
try:
    __m = ast.parse(__aicode_src, "<aicode>")
    __f = ast.parse("def __aicode_main():\\n    pass").body[0]
    __f.body = __m.body or [ast.Pass()]
    __mod = ast.Module(body=[__f], type_ignores=[])
    ast.fix_missing_locations(__mod)
    exec(compile(__mod, "<aicode>", "exec"))
    __aicode_write({"__aicode": "result", "ok": True, "value": __aicode_main()})
except BaseException as e:
    __aicode_write({"__aicode": "result", "ok": False, "error": __aicode_error(e)})
`;
  }
  if (mode === "open") {
    return `${prelude}
try:
    exec(compile(__aicode_src, "<aicode>", "exec"), globals())
except BaseException as e:
    __aicode_write({"__aicode": "ready", "ok": False, "error": __aicode_error(e)})
    sys.exit(1)
__aicode_write({"__aicode": "ready", "ok": True})
for __line in sys.stdin:
    if not __line.strip():
        continue
    __req = json.loads(__line)
    try:
        __fn = globals().get(__req["name"])
        if not callable(__fn):
            raise NameError("no function " + __req["name"])
        __aicode_write({"__aicode": "result", "id": __req["id"], "ok": True, "value": __fn(*(__req.get("args") or []))})
    except BaseException as e:
        __aicode_write({"__aicode": "result", "id": __req["id"], "ok": False, "error": __aicode_error(e)})
if callable(globals().get("dispose")):
    dispose()
`;
  }
  return `${prelude}
__aicode_receive = None
def send(data):
    __aicode_write(data)
def receive(fn):
    global __aicode_receive
    __aicode_receive = fn
def keepAlive():
    for line in sys.stdin:
        if line.strip() and __aicode_receive:
            try:
                __aicode_receive(json.loads(line))
            except Exception as e:
                send({"error": __aicode_error(e)})
    sys.exit(0)
exec(compile(__aicode_src, "<aicode>", "exec"), globals())
`;
}

// ---------- running ----------

async function start(spawnProc: SpawnProc, mode: Mode, source: string, args: unknown, onLine: (line: string) => void, onExit: (code: number | null, stderr: string) => void): Promise<Proc> {
  const [program, argv] = IS_WINDOWS
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_BOOT]]
    : ["python3", ["-u", "-c", PY_BOOT]];
  const script = IS_WINDOWS ? psScript(mode, source, args) : pyScript(mode, source, args);
  let out = "";
  let err = "";
  const proc = await spawnProc(program, argv, {
    keepStdin: true,
    onData: (data: string, stream) => {
      if (stream === "stderr") {
        err = (err + data).slice(-8000);
        return;
      }
      out += data;
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.replace(/\r$/, ""));
    },
    onExit: (code) => onExit(code, err.trim()),
  }).catch((e) => {
    throw new Error(IS_WINDOWS ? `native code runs in PowerShell, which could not start: ${e}` : `native code on Linux runs in Python 3: install python3 (${e})`);
  });
  await proc.write(JSON.stringify(script) + "\n");
  return proc;
}

type Message = { __aicode?: string; id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; data?: unknown };
const parse = (line: string): Message | null => {
  try {
    const m = JSON.parse(line);
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
};
const failed = (stderr: string, code: number | null) => new Error(stderr || `the native helper ended (code ${code})`);

export function nativeEval(spawnProc: SpawnProc, source: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    start(spawnProc, "eval", source, args, (line) => {
      const m = parse(line);
      if (m?.__aicode !== "result" || settled) return;
      settled = true;
      if (m.ok) resolve(m.value ?? null);
      else reject(new Error(m.error ?? "the script failed"));
    }, (code, stderr) => {
      if (!settled) reject(failed(stderr, code));
      settled = true;
    })
      .then((proc) => proc.end())
      .catch((e) => {
        if (!settled) reject(e);
        settled = true;
      });
  });
}

export async function nativeOpen(spawnProc: SpawnProc, source: string, args: unknown, onEvent: (channel: string, data: unknown) => void) {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  let exited = false;
  let ready!: { resolve: () => void; reject: (e: Error) => void };
  const isReady = new Promise<void>((resolve, reject) => (ready = { resolve, reject }));
  const proc = await start(spawnProc, "open", source, args, (line) => {
    const m = parse(line);
    if (!m) return;
    if (m.__aicode === "emit") onEvent(String(m.channel ?? ""), m.data ?? null);
    else if (m.__aicode === "ready") m.ok ? ready.resolve() : ready.reject(new Error(m.error ?? "the script failed"));
    else if (m.__aicode === "result" && typeof m.id === "number") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p?.resolve(m.value ?? null);
      else p?.reject(new Error(m.error ?? "the call failed"));
    }
  }, (code, stderr) => {
    exited = true;
    const e = failed(stderr, code);
    ready.reject(e);
    pending.forEach((p) => p.reject(e));
    pending.clear();
  });
  await isReady;
  return {
    call: <T = unknown>(name: string, ...callArgs: unknown[]) =>
      new Promise<T>((resolve, reject) => {
        if (exited) return reject(new Error("the native context is closed"));
        const id = next++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        proc.write(JSON.stringify({ id, name, args: callArgs }) + "\n").catch(reject);
      }),
    /** Closes its input (its `dispose()` runs), and ends it if it has not ended in 2 s. */
    close: async () => {
      if (exited) return;
      await proc.end().catch(() => {});
      const timer = setTimeout(() => void proc.kill().catch(() => {}), 2000);
      await proc.done.catch(() => null);
      clearTimeout(timer);
    },
  };
}

export async function nativeSpawn(
  spawnProc: SpawnProc,
  source: string,
  opts: { args?: unknown; onMessage?: (data: unknown) => void; onStderr?: (text: string) => void; onExit?: (code: number | null) => void },
) {
  let resolveDone!: (code: number | null) => void;
  const done = new Promise<number | null>((r) => (resolveDone = r));
  const proc = await start(spawnProc, "spawn", source, opts.args, (line) => {
    let m: unknown = line;
    try {
      m = JSON.parse(line);
    } catch {}
    opts.onMessage?.(m);
  }, (code, stderr) => {
    if (stderr) opts.onStderr?.(stderr);
    opts.onExit?.(code);
    resolveDone(code);
  });
  return {
    send: (data: unknown) => proc.write(JSON.stringify(data) + "\n"),
    kill: () => proc.kill(),
    done,
  };
}
