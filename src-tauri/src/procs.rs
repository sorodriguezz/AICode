//! Programs and terminals a mod starts. Nothing here runs until a mod asks, and everything that is
//! running is listed by [`resource_stats`] — the Mods view shows it, so "the terminal mod is
//! installed" never silently means "a shell is running".

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mods::{require, ModsState};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// A `Command` for a program that prints to pipes. On Windows a GUI app's console child would
/// otherwise open a console window of its own (a flash for every `git status`).
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

struct Pty {
    owner: String,
    window: String,
    pid: Option<u32>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

struct Proc {
    owner: String,
    window: String,
    program: String,
    pid: u32,
    child: Arc<Mutex<std::process::Child>>,
    /// Kept open when the mod asked to write to the program while it runs (`keepStdin`).
    stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
}

#[derive(Default)]
pub struct ProcState {
    ptys: Mutex<HashMap<u32, Pty>>,
    procs: Mutex<HashMap<u32, Proc>>,
}

/// The PATH a login shell would have. An app started from the Dock gets a minimal PATH, which would
/// hide every CLI installed with Homebrew, npm, cargo or a version manager.
pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut parts: Vec<String> = Vec::new();
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let out = Command::new(shell)
                    .args(["-ilc", "printf '__AICODE__%s__AICODE__' \"$PATH\""])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output();
                let _ = tx.send(out);
            });
            if let Ok(Ok(out)) = rx.recv_timeout(std::time::Duration::from_secs(4)) {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(path) = text.split("__AICODE__").nth(1) {
                    parts.extend(path.split(':').map(String::from));
                }
            }
        }
        if let Ok(current) = std::env::var("PATH") {
            parts.extend(std::env::split_paths(&current).map(|p| p.to_string_lossy().into_owned()));
        }
        if let Some(home) = dirs::home_dir() {
            for sub in [".local/bin", ".cargo/bin", ".bun/bin", ".npm-global/bin", ".volta/bin", ".opencode/bin"] {
                parts.push(home.join(sub).to_string_lossy().into_owned());
            }
        }
        parts.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from));
        let mut seen = std::collections::HashSet::new();
        parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
        std::env::join_paths(parts).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
    })
}

pub fn which(program: &str) -> Option<String> {
    if program.contains('/') || program.contains('\\') {
        return std::path::Path::new(program).is_file().then(|| program.to_string());
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    for dir in std::env::split_paths(login_path()) {
        for ext in exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(crate::paths::ui(&candidate));
            }
        }
    }
    None
}

/// Splits a byte stream into UTF-8 text without cutting a character in half between two reads.
struct Utf8Carry(Vec<u8>);

impl Utf8Carry {
    fn push(&mut self, chunk: &[u8]) -> String {
        self.0.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&self.0) {
            Ok(_) => self.0.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => self.0.len(),
        };
        let rest = self.0.split_off(valid);
        let text = String::from_utf8_lossy(&self.0).into_owned();
        self.0 = rest;
        text
    }
}

fn default_cwd(cwd: Option<String>) -> String {
    cwd.filter(|c| std::path::Path::new(c).is_dir())
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "/".into())
}

#[tauri::command]
pub fn proc_which(state: State<'_, ModsState>, mod_id: String, program: String) -> Result<Option<String>, String> {
    require(&state, &mod_id, "process")?;
    Ok(which(&program))
}

/// Starts a program. Its output arrives as `proc://data` events and its end as `proc://exit`.
/// `keep_stdin`: the input stays open for `proc_write` / `proc_end` (a REPL, a database client, a
/// helper the mod talks to over stdio). `encoding: "base64"`: output chunks as base64 (`data` is then
/// the bytes, encoded), for programs that print binary.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn proc_spawn(
    app: AppHandle,
    window: tauri::Window,
    mods: State<'_, ModsState>,
    procs: State<'_, ProcState>,
    mod_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    stdin: Option<String>,
    env: Option<HashMap<String, String>>,
    keep_stdin: Option<bool>,
    encoding: Option<String>,
) -> Result<u32, String> {
    require(&mods, &mod_id, "process")?;
    let keep_stdin = keep_stdin.unwrap_or(false);
    let base64_out = encoding.as_deref() == Some("base64");
    let resolved = which(&program).ok_or_else(|| format!("{program} was not found on this machine"))?;
    let mut cmd = command(&resolved);
    cmd.args(&args)
        .current_dir(default_cwd(cwd))
        .env("PATH", login_path())
        .stdin(if stdin.is_some() || keep_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut kept = None;
    if keep_stdin {
        kept = child.stdin.take();
        if let (Some(input), Some(pipe)) = (stdin, kept.as_mut()) {
            pipe.write_all(input.as_bytes()).map_err(|e| format!("{program}: {e}"))?;
            let _ = pipe.flush();
        }
    } else if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    let label = window.label().to_string();
    procs.procs.lock().unwrap().insert(id, Proc { owner: mod_id, window: label.clone(), program, pid, child: child.clone(), stdin: kept.map(|k| Arc::new(Mutex::new(k))) });

    let mut readers = Vec::new();
    for (stream, pipe) in [("stdout", stdout.map(|p| Box::new(p) as Box<dyn Read + Send>)), ("stderr", stderr.map(|p| Box::new(p) as Box<dyn Read + Send>))] {
        let Some(mut pipe) = pipe else { continue };
        let app = app.clone();
        let label = label.clone();
        readers.push(std::thread::spawn(move || {
            let mut carry = Utf8Carry(Vec::new());
            let mut buf = [0u8; 16 * 1024];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if base64_out {
                            use base64::Engine;
                            let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            let _ = app.emit_to(label.as_str(), "proc://data", json!({ "id": id, "stream": stream, "data": data, "base64": true }));
                            continue;
                        }
                        let data = carry.push(&buf[..n]);
                        if !data.is_empty() {
                            let _ = app.emit_to(label.as_str(), "proc://data", json!({ "id": id, "stream": stream, "data": data }));
                        }
                    }
                }
            }
        }));
    }
    std::thread::spawn(move || {
        for r in readers {
            let _ = r.join();
        }
        let code = loop {
            let status = child.lock().unwrap().try_wait();
            match status {
                Ok(Some(s)) => break s.code(),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(30)),
                Err(_) => break None,
            }
        };
        app.state::<ProcState>().procs.lock().unwrap().remove(&id);
        let _ = app.emit_to(label.as_str(), "proc://exit", json!({ "id": id, "code": code }));
    });
    Ok(id)
}

/// Writes to a running program's input (started with `keep_stdin`). `base64`: `data` is bytes, encoded.
#[tauri::command]
pub fn proc_write(procs: State<'_, ProcState>, id: u32, data: String, base64: Option<bool>) -> Result<(), String> {
    let bytes = if base64.unwrap_or(false) {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?
    } else {
        data.into_bytes()
    };
    // Taken out of the table first: a program slow to read must not hold up every other process.
    let pipe = {
        let map = procs.procs.lock().unwrap();
        let p = map.get(&id).ok_or("that program is no longer running")?;
        p.stdin.clone().ok_or("that program's input is closed (start it with keepStdin)")?
    };
    let mut pipe = pipe.lock().unwrap();
    pipe.write_all(&bytes).map_err(|e| e.to_string())?;
    pipe.flush().map_err(|e| e.to_string())
}

/// Closes a running program's input: it reads end-of-file (how many CLIs know to finish).
#[tauri::command]
pub fn proc_end(procs: State<'_, ProcState>, id: u32) -> Result<(), String> {
    if let Some(p) = procs.procs.lock().unwrap().get_mut(&id) {
        p.stdin.take();
    }
    Ok(())
}

#[tauri::command]
pub fn proc_kill(procs: State<'_, ProcState>, id: u32) -> Result<(), String> {
    if let Some(p) = procs.procs.lock().unwrap().get(&id) {
        let _ = p.child.lock().unwrap().kill();
    }
    Ok(())
}

/// Opens a terminal. Output arrives as `pty://data`, the end as `pty://exit`.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    window: tauri::Window,
    mods: State<'_, ModsState>,
    procs: State<'_, ProcState>,
    mod_id: String,
    cwd: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    require(&mods, &mod_id, "pty")?;
    let system = native_pty_system();
    let pair = system
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = match command {
        Some(program) => {
            let resolved = which(&program).ok_or_else(|| format!("{program} was not found on this machine"))?;
            let mut c = CommandBuilder::new(resolved);
            c.args(args.unwrap_or_default());
            c
        }
        None => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(windows) { "powershell.exe".into() } else { "/bin/zsh".into() });
            let mut c = CommandBuilder::new(shell);
            if cfg!(unix) {
                c.arg("-l");
            }
            c
        }
    };
    cmd.cwd(default_cwd(cwd));
    cmd.env("PATH", login_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "AICode");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();
    procs.ptys.lock().unwrap().insert(id, Pty { owner: mod_id, window: label.clone(), pid, writer, master: pair.master, killer });

    let mut child = child;
    std::thread::spawn(move || {
        let mut carry = Utf8Carry(Vec::new());
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = carry.push(&buf[..n]);
                    if !data.is_empty() {
                        let _ = app.emit_to(label.as_str(), "pty://data", json!({ "id": id, "data": data }));
                    }
                }
            }
        }
        let code = child.wait().ok().map(|s| s.exit_code());
        app.state::<ProcState>().ptys.lock().unwrap().remove(&id);
        let _ = app.emit_to(label.as_str(), "pty://exit", json!({ "id": id, "code": code }));
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(procs: State<'_, ProcState>, id: u32, data: String) -> Result<(), String> {
    let mut ptys = procs.ptys.lock().unwrap();
    let pty = ptys.get_mut(&id).ok_or("terminal closed")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(procs: State<'_, ProcState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = procs.ptys.lock().unwrap();
    let pty = ptys.get(&id).ok_or("terminal closed")?;
    pty.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(procs: State<'_, ProcState>, id: u32) -> Result<(), String> {
    if let Some(mut pty) = procs.ptys.lock().unwrap().remove(&id) {
        let _ = pty.killer.kill();
    }
    Ok(())
}

/// Opens a link, a file or another app with the system's own opener.
#[tauri::command]
pub fn open_external(mods: State<'_, ModsState>, mod_id: String, target: String, app: Option<String>) -> Result<(), String> {
    require(&mods, &mod_id, "open-external")?;
    let lower = target.to_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("data:") {
        return Err("that kind of link is not opened".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        if let Some(app) = &app {
            c.args(["-a", app]);
        }
        if !target.is_empty() {
            c.arg(&target);
        }
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let _ = &app;
        let mut c = Command::new("xdg-open");
        c.arg(&target);
        c
    };
    // Not `cmd /C start`: cmd would read `&`, `|` and `^` in a link as its own syntax.
    #[cfg(windows)]
    let mut cmd = {
        let _ = &app;
        let mut c = command("rundll32.exe");
        // A path (C:/x, //server/x) in Windows' own form; a link as it is.
        let local = target.as_bytes().get(1) == Some(&b':') || target.starts_with("//");
        c.args(["url.dll,FileProtocolHandler", &if local { target.replace('/', "\\") } else { target.clone() }]);
        c
    };
    let status = cmd.status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not open {target}"))
    }
}

/// Puts text on the system clipboard. A web view only lets a page do that right after a click,
/// and a mod often copies after an `await` (a server starting, a file read).
#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("pbcopy");
    #[cfg(windows)]
    let mut cmd = command("clip");
    #[cfg(target_os = "linux")]
    let mut cmd = if which("wl-copy").is_some() { Command::new("wl-copy") } else { let mut c = Command::new("xclip"); c.args(["-selection", "clipboard"]); c };
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    // clip.exe reads its input in the console code page unless it is UTF-16 with a byte-order mark.
    #[cfg(windows)]
    let bytes: Vec<u8> = [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect();
    #[cfg(not(windows))]
    let bytes = text.into_bytes();
    child.stdin.take().ok_or("no stdin")?.write_all(&bytes).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether an app is installed (macOS: anywhere Launch Services knows it).
#[tauri::command]
pub fn app_installed(name: String) -> bool {
    #[cfg(target_os = "macos")]
    {
        let bundle = format!("{name}.app");
        for dir in ["/Applications".to_string(), format!("{}/Applications", dirs::home_dir().unwrap_or_default().display())] {
            if std::path::Path::new(&dir).join(&bundle).exists() {
                return true;
            }
        }
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        which(&name.to_lowercase()).is_some()
    }
}

#[derive(Serialize)]
pub struct Running {
    kind: &'static str,
    window: String,
    id: u32,
    owner: String,
    label: String,
    pid: Option<u32>,
    rss_kb: Option<u64>,
}

#[derive(Serialize)]
pub struct Stats {
    pid: u32,
    rss_kb: Option<u64>,
    running: Vec<Running>,
    mcp: Option<serde_json::Value>,
}

fn rss_of(pids: &[u32]) -> HashMap<u32, u64> {
    let mut out = HashMap::new();
    if pids.is_empty() || cfg!(windows) {
        return out;
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    if let Ok(o) = Command::new("ps").args(["-o", "pid=,rss=", "-p", &list]).output() {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let mut it = line.split_whitespace();
            if let (Some(p), Some(r)) = (it.next(), it.next()) {
                if let (Ok(p), Ok(r)) = (p.parse(), r.parse()) {
                    out.insert(p, r);
                }
            }
        }
    }
    out
}

/// What AICode is running right now and what it costs: the app process and every program and
/// terminal a mod started. (The web view's own processes are the system's and are not counted.)
#[tauri::command]
pub fn resource_stats(app: AppHandle, procs: State<'_, ProcState>) -> Stats {
    let me = std::process::id();
    let mut running = Vec::new();
    for (id, p) in procs.ptys.lock().unwrap().iter() {
        running.push(Running { kind: "terminal", window: p.window.clone(), id: *id, owner: p.owner.clone(), label: "shell".into(), pid: p.pid, rss_kb: None });
    }
    for (id, p) in procs.procs.lock().unwrap().iter() {
        running.push(Running { kind: "process", window: p.window.clone(), id: *id, owner: p.owner.clone(), label: p.program.clone(), pid: Some(p.pid), rss_kb: None });
    }
    let mut pids: Vec<u32> = running.iter().filter_map(|r| r.pid).collect();
    pids.push(me);
    let rss = rss_of(&pids);
    for r in &mut running {
        r.rss_kb = r.pid.and_then(|p| rss.get(&p).copied());
    }
    Stats { pid: me, rss_kb: rss.get(&me).copied(), running, mcp: crate::mcp::status_value(&app) }
}

/// Ends the programs and terminals a window started, when that window closes.
pub fn kill_owned_by(app: &AppHandle, window: &str) {
    let state = app.state::<ProcState>();
    state.ptys.lock().unwrap().retain(|_, p| {
        if p.window == window {
            let _ = p.killer.kill();
            false
        } else {
            true
        }
    });
    for p in state.procs.lock().unwrap().values().filter(|p| p.window == window) {
        let _ = p.child.lock().unwrap().kill();
    }
}

pub fn kill_all(app: &AppHandle) {
    let state = app.state::<ProcState>();
    for (_, mut pty) in state.ptys.lock().unwrap().drain() {
        let _ = pty.killer.kill();
    }
    for (_, p) in state.procs.lock().unwrap().drain() {
        let _ = p.child.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_carry_keeps_split_characters() {
        let mut c = Utf8Carry(Vec::new());
        let bytes = "ñandú".as_bytes();
        let a = c.push(&bytes[..1]);
        let b = c.push(&bytes[1..]);
        assert_eq!(format!("{a}{b}"), "ñandú");
    }

    #[test]
    fn login_path_finds_sh() {
        assert!(which("sh").is_some());
    }
}

/// The shells a terminal can start: the user's login shell first, then the others installed.
#[tauri::command]
pub fn pty_shells(mods: State<'_, ModsState>, mod_id: String) -> Result<serde_json::Value, String> {
    require(&mods, &mod_id, "pty")?;
    let mut list: Vec<String> = Vec::new();
    let default = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
    if cfg!(windows) {
        for s in ["pwsh.exe", "powershell.exe", "cmd.exe", "bash.exe"] {
            if which(s).is_some() {
                list.push(s.to_string());
            }
        }
    } else {
        if let Some(d) = &default {
            list.push(d.clone());
        }
        let text = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        for line in text.lines().map(str::trim).filter(|l| l.starts_with('/')) {
            let name = std::path::Path::new(line).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            // One entry per shell name (/bin/bash and /usr/bin/bash are the same to the user).
            let seen = list.iter().any(|p| std::path::Path::new(p).file_name().map(|n| n.to_string_lossy() == name).unwrap_or(false));
            if !seen && std::path::Path::new(line).exists() {
                list.push(line.to_string());
            }
        }
    }
    Ok(json!({ "default": default.or_else(|| list.first().cloned()), "shells": list }))
}
