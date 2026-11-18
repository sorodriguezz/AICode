//! `aicode`, the command line, as VS Code has `code`:
//!
//! ```text
//! aicode .                 the current folder        aicode -g src/main.ts:12:5   at a line
//! aicode notes.md          a file (made if missing)  aicode -d left.txt right.txt a diff
//! aicode -n / -r           a new window / this one   git config core.editor "aicode -w"
//! ```
//!
//! Three parts:
//!
//! - **The client** ([`client_main`]): the same executable, started with `--cli` (by the shim
//!   below) or with one of its options. It turns its arguments into a request, hands it to the
//!   running AICode — starting it if needed — and, with `-w`, waits until AICode says the files are
//!   closed. It ends before anything of the app starts: no window, no Dock icon.
//! - **The server** ([`serve`]): AICode listens on 127.0.0.1 on a port it picks, and writes the port
//!   and a token to `state/cli.json`, readable only by this user. A request without the token is
//!   refused. Each request goes to one window (`cli-request`), which opens what it names.
//! - **The shell command** ([`shell_command_install`]): a small script named `aicode` in a folder of
//!   the PATH (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`; `AICode/bin` added to the
//!   user's PATH on Windows) that runs this executable with `--cli`. The Shell Command mod installs
//!   it at startup; Linux packages already put the executable itself at `/usr/bin/aicode`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::paths;

/// In every shim AICode writes: what makes one ours to update or remove.
const MARKER: &str = "aicode-shell-command";

const USAGE: &str = "\
Usage: aicode [options] [paths...]

  aicode .                   open the current folder
  aicode notes.md            open a file (an empty one is made if it does not exist)
  aicode -g src/app.ts:12:5  open a file at line 12, column 5
  aicode -d left right       compare two files
  echo hello | aicode -      open what comes on stdin

Options:
  -n, --new-window     open in a new window
  -r, --reuse-window   open in the window in front (a folder replaces its folder)
  -g, --goto           paths may end in :line or :line:column
  -d, --diff           compare two files side by side
  -w, --wait           return only when the files (or the window) are closed: git config core.editor \"aicode -w\"
  -                    read the text to open from stdin
  -v, --version        print AICode's version
  -h, --help           print this help
";

// ---------- arguments ----------

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub new_window: bool,
    pub reuse_window: bool,
    pub goto: bool,
    pub diff: bool,
    pub wait: bool,
    pub stdin: bool,
    pub help: bool,
    pub version: bool,
    pub items: Vec<String>,
}

/// An option of the command line: one of them (or `--cli`) makes a launch a command-line one.
fn option(arg: &str) -> Option<fn(&mut Args)> {
    let set: fn(&mut Args) = match arg {
        "-n" | "--new-window" => |a| a.new_window = true,
        "-r" | "--reuse-window" => |a| a.reuse_window = true,
        "-g" | "--goto" => |a| a.goto = true,
        "-d" | "--diff" => |a| a.diff = true,
        "-w" | "--wait" => |a| a.wait = true,
        "-" => |a| a.stdin = true,
        "-h" | "--help" => |a| a.help = true,
        "-v" | "--version" => |a| a.version = true,
        "--cli" => |_| {},
        _ => return None,
    };
    Some(set)
}

/// Whether these arguments are for the client. A launch from Finder, Explorer or a file manager
/// passes paths only, and keeps going the old way (straight into the app).
pub fn is_cli(args: &[String]) -> bool {
    args.iter().take_while(|a| *a != "--").any(|a| option(a).is_some())
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut out = Args::default();
    let mut rest = false;
    for arg in args {
        if rest {
            out.items.push(arg.clone());
        } else if arg == "--" {
            rest = true;
        } else if let Some(set) = option(arg) {
            set(&mut out);
        } else if arg.starts_with('-') {
            return Err(format!("unknown option {arg}"));
        } else {
            out.items.push(arg.clone());
        }
    }
    if out.new_window && out.reuse_window {
        return Err("-n and -r cannot go together".into());
    }
    if out.diff && out.items.len() != 2 {
        return Err("-d takes two files".into());
    }
    Ok(out)
}

/// `file:12:5` → (`file`, 12, 5). Only the trailing numbers go: `C:/x` keeps its drive.
pub fn split_position(arg: &str) -> (String, Option<u32>, Option<u32>) {
    let mut path = arg;
    let mut numbers = Vec::new();
    while numbers.len() < 2 {
        match path.rsplit_once(':') {
            Some((head, tail)) if !head.is_empty() && !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => {
                numbers.push(tail.parse::<u32>().unwrap_or(1).max(1));
                path = head;
            }
            _ => break,
        }
    }
    numbers.reverse();
    (path.to_string(), numbers.first().copied(), numbers.get(1).copied())
}

/// `cwd` joined with `path`, `.` and `..` resolved without touching the disk.
pub fn absolute(cwd: &Path, path: &str) -> PathBuf {
    let joined = if Path::new(path).is_absolute() { PathBuf::from(path) } else { cwd.join(path) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// What the window is asked to do: `{ files: [{ path, line, column }], folders, diff, newWindow,
/// reuseWindow, wait }`.
fn request(args: &Args, cwd: &Path) -> Result<Value, String> {
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let mut diff = Vec::new();
    for item in &args.items {
        let (raw, line, column) = if args.goto { split_position(item) } else { (item.clone(), None, None) };
        let path = absolute(cwd, &raw);
        if args.diff {
            if !path.is_file() {
                return Err(format!("{} is not a file", path.display()));
            }
            diff.push(paths::ui(&path));
            continue;
        }
        if path.is_dir() {
            folders.push(paths::ui(&path));
            continue;
        }
        if !path.exists() {
            // As `code new.md` does, the file is there to edit; it is made empty now, so it opens.
            match path.parent() {
                Some(dir) if dir.is_dir() => {
                    std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                }
                _ => return Err(format!("{}: no such folder", path.parent().unwrap_or(&path).display())),
            }
        }
        files.push(json!({ "path": paths::ui(&path), "line": line, "column": column }));
    }
    if args.stdin {
        let mut text = Vec::new();
        std::io::stdin().read_to_end(&mut text).map_err(|e| format!("stdin: {e}"))?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = std::env::temp_dir().join(format!("aicode-stdin-{stamp}.txt"));
        std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        files.push(json!({ "path": paths::ui(&path), "line": null, "column": null }));
    }
    Ok(json!({
        "files": files,
        "folders": folders,
        "diff": if args.diff { json!(diff) } else { Value::Null },
        "newWindow": args.new_window,
        "reuseWindow": args.reuse_window,
        "wait": args.wait,
    }))
}

// ---------- the client ----------

/// The process was started as the command line: does what it asks and returns the exit code.
/// `None`: it is the app.
pub fn client_main() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !is_cli(&args) {
        return None;
    }
    #[cfg(windows)]
    attach_console();
    let parsed = match parse(&args) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("aicode: {e}\nRun aicode --help for the options.");
            return Some(2);
        }
    };
    if parsed.help {
        print!("AICode {}\n\n{USAGE}", env!("CARGO_PKG_VERSION"));
        return Some(0);
    }
    if parsed.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Some(0);
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let result = request(&parsed, &cwd).and_then(|req| send(&req, parsed.wait));
    match result {
        Ok(()) => Some(0),
        Err(e) => {
            eprintln!("aicode: {e}");
            Some(1)
        }
    }
}

/// A Windows app has no console of its own: it borrows the terminal's to print.
#[cfg(windows)]
fn attach_console() {
    extern "system" {
        fn AttachConsole(process: u32) -> i32;
    }
    // ATTACH_PARENT_PROCESS
    unsafe {
        AttachConsole(u32::MAX);
    }
}

fn info_path() -> PathBuf {
    paths::state().join("cli.json")
}

fn connect() -> Option<(TcpStream, String)> {
    let info: Value = serde_json::from_str(&std::fs::read_to_string(info_path()).ok()?).ok()?;
    let port = info.get("port")?.as_u64()? as u16;
    let token = info.get("token")?.as_str()?.to_string();
    let stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(800)).ok()?;
    Some((stream, token))
}

/// Starts AICode (in the background of this terminal: it outlives it).
fn launch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        // Inside AICode.app: through Launch Services, as a click on the app would.
        if let Some(bundle) = exe.ancestors().nth(3).filter(|b| b.extension().is_some_and(|e| e == "app")) {
            let status = std::process::Command::new("/usr/bin/open").arg(bundle).status().map_err(|e| e.to_string())?;
            return if status.success() { Ok(()) } else { Err(format!("could not start {}", bundle.display())) };
        }
    }
    let exe = std::env::var_os("APPIMAGE").map(PathBuf::from).unwrap_or(exe);
    let mut cmd = std::process::Command::new(&exe);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("could not start {}: {e}", exe.display()))
}

/// Hands `req` to the running AICode (started if it is not) and, with `wait`, blocks until it says
/// the files are closed — or until it quits.
fn send(req: &Value, wait: bool) -> Result<(), String> {
    let (mut stream, token) = match connect() {
        Some(found) => found,
        None => {
            launch()?;
            let started = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(120));
                if let Some(found) = connect() {
                    break found;
                }
                if started.elapsed() > Duration::from_secs(40) {
                    return Err("AICode did not start in time".into());
                }
            }
        }
    };
    let message = json!({ "token": token, "request": req });
    stream.write_all(format!("{message}\n").as_bytes()).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| format!("AICode did not answer: {e}"))?;
    let reply: Value = serde_json::from_str(line.trim()).map_err(|_| "AICode did not answer".to_string())?;
    if let Some(error) = reply.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    if wait {
        let _ = reader.get_ref().set_read_timeout(None);
        // `{"done":true}`, or the connection closed because AICode quit: either way, done.
        line.clear();
        let _ = reader.read_line(&mut line);
    }
    Ok(())
}

// ---------- the server ----------

#[derive(Default)]
pub struct CliState {
    /// `aicode -w` requests not answered yet: id → (window, the client's connection).
    waits: Mutex<HashMap<u64, (String, mpsc::Sender<()>)>>,
    next: AtomicU64,
    shell_startup_claimed: AtomicBool,
}

/// Listens for the command line; called once the first windows exist.
pub fn serve(app: &AppHandle) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => return eprintln!("[cli] cannot listen: {e}"),
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let bytes: [u8; 24] = rand::Rng::random(&mut rand::rng());
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let info = json!({ "port": port, "token": token, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") });
    let path = info_path();
    let write = move || {
        crate::fsops::write_atomic(&path, info.to_string().as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok::<(), String>(())
    };
    if let Err(e) = write() {
        return eprintln!("[cli] cannot write {}: {e}", info_path().display());
    }
    // Another AICode with the same data folder (started by hand) may have put its own port there
    // and quit: this one writes its own back, so `aicode` keeps reaching the AICode that runs.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let current = std::fs::read_to_string(info_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let theirs = current.as_ref().and_then(|v| v.get("pid")).and_then(Value::as_u64).filter(|p| *p != std::process::id() as u64);
        let alive = theirs.is_some_and(|pid| pid_alive(pid as u32));
        if current.is_none() || theirs.is_some() && !alive {
            let _ = write();
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || handle(&app, stream, &token));
        }
    });
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        let _ = pid;
        // Windows has one AICode per user (the single-instance plugin): another pid is a dead one.
        false
    }
}

/// Quitting: the next `aicode` starts AICode instead of calling a port nobody listens on.
pub fn forget() {
    let path = info_path();
    let mine = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("pid").and_then(Value::as_u64))
        == Some(std::process::id() as u64);
    if mine {
        let _ = std::fs::remove_file(path);
    }
}

fn reply(stream: &mut TcpStream, value: Value) {
    let _ = stream.write_all(format!("{value}\n").as_bytes());
}

fn handle(app: &AppHandle, mut stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    let Ok(clone) = stream.try_clone() else { return };
    if BufReader::new(clone).take(4 << 20).read_line(&mut line).is_err() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { return reply(&mut stream, json!({ "error": "not a request" })) };
    if message.get("token").and_then(Value::as_str) != Some(token) {
        return reply(&mut stream, json!({ "error": "not allowed" }));
    }
    let mut request = message.get("request").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let wait = request.get("wait").and_then(Value::as_bool).unwrap_or(false);
    let label = match route(app, &request) {
        Ok(label) => label,
        Err(e) => return reply(&mut stream, json!({ "error": e })),
    };
    let done = wait.then(|| {
        let state = app.state::<CliState>();
        let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        state.waits.lock().unwrap().insert(id, (label.clone(), tx));
        request["id"] = json!(id);
        rx
    });
    crate::windows::deliver_cli(app, &label, request);
    reply(&mut stream, json!({ "ok": true }));
    if let Some(rx) = done {
        // Answered by `cli_done`, or the sender dropped with its window.
        let _ = rx.recv();
        reply(&mut stream, json!({ "done": true }));
    }
}

/// Which window a request goes to, as VS Code decides: `-n` a new one, `-r` the one in front; a
/// folder goes to the window that has it, else to the one in front when that has no folder, else to
/// a new window; files go to the window in front.
fn route(app: &AppHandle, req: &Value) -> Result<String, String> {
    use crate::windows;
    let flag = |k: &str| req.get(k).and_then(Value::as_bool).unwrap_or(false);
    let front = windows::front_label(app);
    if flag("newWindow") {
        return windows::open_new(app, vec![]);
    }
    if flag("reuseWindow") {
        return front.map(Ok).unwrap_or_else(|| windows::open_new(app, vec![]));
    }
    let list = |k: &str| req.get(k).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
    if let Some(folder) = req.get("folders").and_then(|f| f.get(0)).and_then(Value::as_str) {
        if let Some(label) = windows::window_with_folder(app, folder) {
            return Ok(label);
        }
        if let Some(label) = front.filter(|l| windows::window_folder(app, l).is_none()) {
            return Ok(label);
        }
        return windows::open_new(app, vec![]);
    }
    if list("files") == 0 && req.get("diff").is_none_or(Value::is_null) {
        // Just `aicode`: AICode comes to the front, hidden windows included.
        let visible = app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false));
        crate::background::on_reopen(app, visible);
    }
    front.map(Ok).unwrap_or_else(|| windows::open_new(app, vec![]))
}

/// The window closed what `aicode -w` (request `id`) opened.
#[tauri::command]
pub fn cli_done(state: State<'_, CliState>, id: u64) {
    if let Some((_, tx)) = state.waits.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

/// A window closed: every `aicode -w` waiting on it returns.
pub fn window_closed(app: &AppHandle, label: &str) {
    let state = app.state::<CliState>();
    state.waits.lock().unwrap().retain(|_, (l, _)| l != label);
}

// ---------- the shell command ----------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandStatus {
    /// This copy of AICode can have an `aicode` command (not a development build, not outside its bundle).
    pub supported: bool,
    pub reason: Option<String>,
    /// An `aicode` that runs this copy is where a terminal finds it.
    pub installed: bool,
    /// Where `aicode` is (the first one a terminal would run).
    pub path: Option<String>,
    /// Written by AICode: it can be updated and removed.
    pub ours: bool,
    /// It runs this copy of AICode (an old one may point to where the app was before it moved).
    pub current: bool,
    /// The system's package put it there (Linux: `/usr/bin/aicode` is the app itself).
    pub packaged: bool,
    /// Another program called `aicode`: AICode leaves it alone.
    pub foreign: bool,
    /// The folder installing writes to.
    pub dir: Option<String>,
    /// Writing there needs an administrator's password (macOS: `/usr/local/bin`).
    pub needs_admin: bool,
    /// That folder is on the PATH of new terminals.
    pub on_path: bool,
}

fn shim_name() -> &'static str {
    if cfg!(windows) {
        "aicode.cmd"
    } else {
        "aicode"
    }
}

/// The executable the shim runs, or why there is none.
fn launcher() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) && std::env::var_os("AICODE_CLI_DEV").is_none() {
        return Err("a development build does not install the aicode command (set AICODE_CLI_DEV=1 to try it)".into());
    }
    if let Some(image) = std::env::var_os("APPIMAGE") {
        return Ok(PathBuf::from(image));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    if cfg!(target_os = "macos") && !exe.ancestors().nth(3).is_some_and(|b| b.extension().is_some_and(|e| e == "app")) {
        return Err("AICode is not running from its app bundle".into());
    }
    if cfg!(target_os = "macos") && exe.to_string_lossy().contains("/AppTranslocation/") {
        return Err("move AICode to the Applications folder first (macOS runs it from a temporary copy)".into());
    }
    Ok(exe)
}

pub fn shim_text(exe: &Path) -> String {
    let exe = exe.to_string_lossy();
    if cfg!(windows) {
        format!(
            "@echo off\r\nrem {MARKER}: AICode's command line, written by AICode (Shell Command: Uninstall removes it).\r\n\"{}\" --cli %*\r\nexit /b %errorlevel%\r\n",
            exe.replace('%', "%%")
        )
    } else {
        format!(
            "#!/bin/sh\n# {MARKER}: AICode's command line, written by AICode (Shell Command: Uninstall removes it).\nexec '{}' --cli \"$@\"\n",
            exe.replace('\'', "'\\''")
        )
    }
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// Folders of the PATH a new terminal gets.
fn terminal_path() -> Vec<PathBuf> {
    let parts = crate::procs::shell_path();
    if parts.is_empty() {
        // The shell could not be asked: the folders every system has on it.
        return std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).chain([PathBuf::from("/usr/local/bin")]).collect();
    }
    parts.iter().map(PathBuf::from).collect()
}

/// Where installing puts the shim, best first: on the PATH and writable without a password.
fn candidates() -> Vec<PathBuf> {
    if cfg!(windows) {
        vec![paths::root().join("bin")]
    } else if cfg!(target_os = "macos") {
        vec!["/usr/local/bin".into(), "/opt/homebrew/bin".into(), home().join(".local/bin"), home().join("bin")]
    } else {
        vec![home().join(".local/bin"), home().join("bin"), "/usr/local/bin".into()]
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (a, b) = (canon(a), canon(b));
    if cfg!(windows) {
        a.to_string_lossy().trim_end_matches(['\\', '/']).eq_ignore_ascii_case(b.to_string_lossy().trim_end_matches(['\\', '/']))
    } else {
        a == b
    }
}

#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(windows)]
fn writable(_dir: &Path) -> bool {
    true
}

/// The user's PATH on Windows (the registry's `HKCU\Environment\Path`): `mode` is `check`
/// (prints 1 when `dir` is on it), `add` or `remove`.
#[cfg(windows)]
fn user_path(mode: &str, dir: &Path) -> Result<bool, String> {
    const SCRIPT: &str = r#"
$dir = $env:AICODE_BIN.TrimEnd('\')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($old -split ';' | Where-Object { $_ -ne '' })
$has = @($parts | Where-Object { $_.TrimEnd('\') -ieq $dir }).Count -gt 0
if ($env:AICODE_MODE -eq 'check') { if ($has) { '1' } else { '0' }; exit 0 }
if ($env:AICODE_MODE -eq 'add') { if ($has) { exit 0 }; $parts += $dir }
else { if (-not $has) { exit 0 }; $parts = @($parts | Where-Object { $_.TrimEnd('\') -ine $dir }) }
$key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
# Tells Explorer (and so new terminals) that the environment changed.
[Environment]::SetEnvironmentVariable('AICODE_PATH_CHANGED', '1', 'User')
[Environment]::SetEnvironmentVariable('AICODE_PATH_CHANGED', $null, 'User')
"#;
    let out = crate::procs::command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("AICODE_BIN", dir)
        .env("AICODE_MODE", mode)
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if !out.status.success() {
        return Err(format!("could not change the PATH: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim() == "1")
}

fn on_path(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        return user_path("check", dir).unwrap_or(false) || terminal_path().iter().any(|p| same_dir(p, dir));
    }
    #[allow(unreachable_code)]
    terminal_path().iter().any(|p| same_dir(p, dir))
}

/// What `aicode` at `path` is: (ours, current, packaged).
fn classify(path: &Path, exe: Option<&Path>) -> (bool, bool, bool) {
    let canon = path.canonicalize().ok();
    if let (Some(c), Some(exe)) = (&canon, exe) {
        if c == exe || exe.canonicalize().ok().as_ref() == Some(c) {
            return (false, true, true);
        }
    }
    let mut head = Vec::new();
    let _ = std::fs::File::open(path).and_then(|f| f.take(4096).read_to_end(&mut head));
    let text = String::from_utf8_lossy(&head);
    if !text.contains(MARKER) {
        return (false, false, false);
    }
    let current = exe.is_some_and(|exe| text == shim_text(exe));
    (true, current, false)
}

pub fn status() -> ShellCommandStatus {
    let exe = launcher();
    let mut st = ShellCommandStatus { supported: exe.is_ok(), reason: exe.as_ref().err().cloned(), ..Default::default() };
    let exe = exe.ok();
    // The first `aicode` a terminal runs; else one of ours where a terminal does not look.
    let path_dirs = terminal_path();
    let found = path_dirs
        .iter()
        .chain(candidates().iter())
        .map(|d| d.join(shim_name()))
        .find(|p| p.is_file());
    if let Some(found) = &found {
        let (ours, current, packaged) = classify(found, exe.as_deref());
        st.path = Some(paths::ui(found));
        st.ours = ours;
        st.current = current;
        st.packaged = packaged;
        st.foreign = !ours && !packaged;
    }
    let dir = match (&found, st.ours) {
        (Some(found), true) => found.parent().map(Path::to_path_buf),
        _ => {
            let cands = candidates();
            cands
                .iter()
                .find(|d| d.is_dir() && writable(d) && on_path(d))
                .or_else(|| if cfg!(target_os = "macos") { cands.first() } else { cands.iter().find(|d| writable(d) || !d.exists()) })
                .cloned()
        }
    };
    if let Some(dir) = dir {
        st.on_path = on_path(&dir);
        st.needs_admin = dir.exists() && !writable(&dir) || !dir.exists() && dir.parent().is_some_and(|p| !writable(p));
        st.dir = Some(paths::ui(&dir));
    }
    st.installed = st.packaged || st.current && st.on_path;
    st
}

/// macOS: a shell command as an administrator (the system's password dialog). Arguments are passed
/// as they are, never spliced into the script.
#[cfg(target_os = "macos")]
fn as_admin(script: &str, args: &[&str]) -> Result<(), String> {
    let quoted: Vec<String> = (1..=args.len()).map(|i| format!("quoted form of (item {i} of argv)")).collect();
    let mut shell = script.to_string();
    for (i, q) in quoted.iter().enumerate() {
        shell = shell.replace(&format!("${}", i + 1), &format!("\" & {q} & \""));
    }
    let apple = format!(
        "on run argv\ndo shell script \"{shell}\" with prompt \"AICode wants to change the aicode command in your PATH.\" with administrator privileges\nend run"
    );
    let out = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(apple).args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(if err.contains("-128") { "cancelled".into() } else { err.trim().to_string() })
}

fn install(admin: bool) -> Result<ShellCommandStatus, String> {
    let exe = launcher()?;
    let st = status();
    if st.packaged {
        return Ok(st);
    }
    if st.foreign {
        return Err(format!("{} is another program's: remove it to install AICode's", st.path.unwrap_or_default()));
    }
    let dir = PathBuf::from(st.dir.clone().ok_or("no folder to install the aicode command in")?);
    let target = dir.join(shim_name());
    let text = shim_text(&exe);
    if st.needs_admin {
        #[cfg(target_os = "macos")]
        if admin {
            let tmp = std::env::temp_dir().join(format!("aicode-shim-{}", std::process::id()));
            std::fs::write(&tmp, &text).map_err(|e| e.to_string())?;
            let result = as_admin("mkdir -p $1 && cp $2 $3 && chmod 755 $3", &[&dir.to_string_lossy(), &tmp.to_string_lossy(), &target.to_string_lossy()]);
            let _ = std::fs::remove_file(&tmp);
            result?;
            return Ok(status());
        }
        let _ = admin;
        return Err(format!("needs-admin: writing to {} needs an administrator's password", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    crate::fsops::write_atomic(&target, text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    user_path("add", &dir)?;
    Ok(status())
}

fn uninstall() -> Result<ShellCommandStatus, String> {
    let st = status();
    let Some(path) = st.path.clone().filter(|_| st.ours) else {
        return Err(if st.packaged { "the aicode command came with AICode's package: uninstall the package to remove it".into() } else { "AICode's aicode command is not installed".into() });
    };
    let path = PathBuf::from(path);
    if let Err(e) = std::fs::remove_file(&path) {
        #[cfg(target_os = "macos")]
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            as_admin("rm -f $1", &[&path.to_string_lossy()])?;
            return Ok(status());
        }
        return Err(format!("{}: {e}", path.display()));
    }
    #[cfg(windows)]
    if let Some(dir) = path.parent() {
        user_path("remove", dir)?;
    }
    Ok(status())
}

#[tauri::command]
pub async fn shell_command_status() -> ShellCommandStatus {
    tauri::async_runtime::spawn_blocking(status).await.unwrap_or_default()
}

/// `admin`: macOS may ask for the password to write to `/usr/local/bin`; without it, a folder that
/// needs one is an error starting with `needs-admin`.
#[tauri::command]
pub async fn shell_command_install(admin: Option<bool>) -> Result<ShellCommandStatus, String> {
    let admin = admin.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || install(admin)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_command_uninstall() -> Result<ShellCommandStatus, String> {
    tauri::async_runtime::spawn_blocking(uninstall).await.map_err(|e| e.to_string())?
}

/// True for the first window that asks in this launch: that one checks the command at startup.
#[tauri::command]
pub fn shell_command_claim_startup(state: State<'_, CliState>) -> bool {
    !state.shell_startup_claimed.swap(true, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn options_make_a_command_line_and_paths_alone_do_not() {
        assert!(is_cli(&args(&["--cli", "."])));
        assert!(is_cli(&args(&["-g", "a.txt:3"])));
        assert!(is_cli(&args(&["-"])));
        assert!(!is_cli(&args(&["/Users/me/notes.md"])), "Finder, Explorer: the app as before");
        assert!(!is_cli(&args(&["--", "-n"])), "after -- it is a path");
        assert!(!is_cli(&args(&["-psn_0_12345"])), "what macOS may add stays the app's");
    }

    #[test]
    fn options_and_paths_are_read() {
        let a = parse(&args(&["--cli", "-n", "-w", "a", "--", "-b"])).unwrap();
        assert!(a.new_window && a.wait && !a.reuse_window);
        assert_eq!(a.items, vec!["a", "-b"]);
        assert!(parse(&args(&["-x"])).is_err());
        assert!(parse(&args(&["-n", "-r"])).is_err());
        assert!(parse(&args(&["-d", "one"])).is_err());
        assert!(parse(&args(&["-d", "one", "two"])).is_ok());
    }

    #[test]
    fn positions_come_off_the_end() {
        assert_eq!(split_position("a.ts:12:5"), ("a.ts".into(), Some(12), Some(5)));
        assert_eq!(split_position("a.ts:12"), ("a.ts".into(), Some(12), None));
        assert_eq!(split_position("a.ts"), ("a.ts".into(), None, None));
        assert_eq!(split_position("C:/x/a.ts:7"), ("C:/x/a.ts".into(), Some(7), None));
        assert_eq!(split_position("C:/x/a.ts"), ("C:/x/a.ts".into(), None, None));
        assert_eq!(split_position("a:b.ts:3"), ("a:b.ts".into(), Some(3), None));
    }

    #[test]
    fn relative_paths_resolve_without_dots() {
        let cwd = Path::new("/home/me/project");
        assert_eq!(absolute(cwd, "."), PathBuf::from("/home/me/project"));
        assert_eq!(absolute(cwd, "../other/x.md"), PathBuf::from("/home/me/other/x.md"));
        assert_eq!(absolute(cwd, "/abs/y"), PathBuf::from("/abs/y"));
    }

    #[cfg(unix)]
    #[test]
    fn the_shim_runs_this_executable_quoted() {
        let text = shim_text(Path::new("/Apps/It's AICode.app/Contents/MacOS/aicode"));
        assert!(text.starts_with("#!/bin/sh\n") && text.contains(MARKER));
        assert!(text.contains("exec '/Apps/It'\\''s AICode.app/Contents/MacOS/aicode' --cli \"$@\""));
    }

    #[test]
    fn a_request_names_folders_files_and_positions() {
        let dir = std::env::temp_dir().join(format!("aicode-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let a = parse(&args(&["-g", "sub", "a.txt:4:2", "new.md"])).unwrap();
        let req = request(&a, &dir).unwrap();
        assert_eq!(req["folders"][0], json!(paths::ui(dir.join("sub"))));
        assert_eq!(req["files"][0], json!({ "path": paths::ui(dir.join("a.txt")), "line": 4, "column": 2 }));
        assert!(dir.join("new.md").is_file(), "a missing file is made, as `code new.md` opens one");
        assert!(request(&parse(&args(&["nowhere/x.md"])).unwrap(), &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
