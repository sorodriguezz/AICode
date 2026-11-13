//! Windows. Like VS Code, AICode can have several, each with its own folder, tabs and layout:
//!
//! - `state/windows-<profile>.json` lists the windows that were open; all of them come back at
//!   launch, each from `state/session-<profile>-<label>.json`.
//! - Closing a window while others stay open forgets it (its programs and terminals end with it).
//!   Quitting, or closing the last window, keeps every session — that is hot exit.
//! - Paths to open (a file dropped on the Dock icon, "Open With", `open -a AICode x`, the command
//!   line, "Open Folder in New Window") wait in [`WindowsState::pending`] until the window that should
//!   open them asks, so nothing is lost while a window is still loading.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindowBuilder};

use crate::mods::ModsState;
use crate::paths;

#[derive(Default)]
pub struct WindowsState {
    pub pending: Mutex<HashMap<String, Vec<String>>>,
    pub last_focused: Mutex<Option<String>>,
    pub quitting: AtomicBool,
    /// Windows whose page has asked for its pending paths: they get later ones as events.
    pub ready: Mutex<Vec<String>>,
    /// Closing every window to bring back another profile's: keep sessions, do not quit.
    pub switching: AtomicBool,
    /// Setup has created the first windows. Before that, paths the OS asks us to open (the drop on
    /// the Dock icon that launched AICode) wait in `launch_paths`.
    pub started: AtomicBool,
    pub launch_paths: Mutex<Vec<String>>,
    /// What a window was opened as (a layout, a view, a size, always on top…), until its page asks.
    pub specs: Mutex<HashMap<String, Value>>,
    /// Windows being closed only to be created again (transparency changed): keep their session.
    pub reopening: Mutex<HashSet<String>>,
    /// Windows created transparent (`window.transparent` when they were made).
    pub transparent: Mutex<HashSet<String>>,
    /// "Reopen Last Session" was already offered in this run (once per launch, not per reload).
    pub previous_offered: AtomicBool,
}

fn profile_name(app: &AppHandle) -> String {
    app.state::<ModsState>().profile_name.lock().unwrap().clone()
}

fn registry_path_for(profile: &str) -> std::path::PathBuf {
    paths::state().join(format!("windows-{profile}.json"))
}

fn registry_path(app: &AppHandle) -> std::path::PathBuf {
    registry_path_for(&profile_name(app))
}

pub fn session_path_for(profile: &str, label: &str) -> std::path::PathBuf {
    // The first window keeps the file name sessions had before there were several windows.
    if label == "main" {
        paths::state().join(format!("session-{profile}.json"))
    } else {
        paths::state().join(format!("session-{profile}-{label}.json"))
    }
}

pub fn session_path(app: &AppHandle, label: &str) -> std::path::PathBuf {
    session_path_for(&profile_name(app), label)
}

/// The windows a profile had open when it was last used.
pub fn registry_for(profile: &str) -> Vec<String> {
    std::fs::read_to_string(registry_path_for(profile))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|l| paths::safe_name(l).is_some())
        .collect()
}

fn read_registry(app: &AppHandle) -> Vec<String> {
    registry_for(&profile_name(app))
}

/// A renamed profile takes its windows and sessions along.
pub fn rename_profile_state(from: &str, to: &str) {
    let mut labels = registry_for(from);
    if !labels.contains(&"main".to_string()) {
        labels.push("main".into());
    }
    for label in &labels {
        let _ = std::fs::rename(session_path_for(from, label), session_path_for(to, label));
    }
    let _ = std::fs::rename(registry_path_for(from), registry_path_for(to));
}

pub fn forget_profile_state(profile: &str) {
    let mut labels = registry_for(profile);
    labels.push("main".into());
    for label in &labels {
        let _ = std::fs::remove_file(session_path_for(profile, label));
    }
    let _ = std::fs::remove_file(registry_path_for(profile));
}

/// Every window saves its session and closes; then the new profile's windows open. Runs on a
/// thread of its own, so the window that asked can be closed while it waits.
pub fn switch_profile(app: &AppHandle, name: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<WindowsState>();
        if state.switching.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = app.emit("session-flush", ());
        std::thread::sleep(std::time::Duration::from_millis(400));
        write_registry(&app, &open_labels(&app));
        for w in app.webview_windows().values() {
            let _ = w.destroy();
        }
        for _ in 0..100 {
            if app.webview_windows().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        state.ready.lock().unwrap().clear();
        state.pending.lock().unwrap().clear();
        *state.last_focused.lock().unwrap() = None;
        let mods = app.state::<ModsState>();
        crate::profiles::activate(&app, &mods, &name);
        if let Err(e) = restore(&app, Vec::new()) {
            eprintln!("[aicode] could not open the windows of profile {name}: {e}");
        }
        state.switching.store(false, Ordering::SeqCst);
    });
}

fn write_registry(app: &AppHandle, labels: &[String]) {
    let _ = crate::fsops::write_atomic(&registry_path(app), serde_json::to_string(labels).unwrap_or_default().as_bytes());
}

fn open_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels
}

/// Creates a window from the template in tauri.conf.json, a little down and right of the one in
/// front so it does not hide it exactly. `spec` (from `window_new`) can give it a size, a position,
/// a title, always-on-top and settings of its own; `window.transparent` is read here because a
/// window is made transparent when it is created, not later.
pub fn create(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let spec = app.state::<WindowsState>().specs.lock().unwrap().get(label).cloned();
    create_with(app, label, spec.as_ref())
}

fn create_with(app: &AppHandle, label: &str, spec: Option<&Value>) -> tauri::Result<()> {
    let template = app.config().app.windows.iter().find(|w| w.label == "main").cloned().unwrap_or_default();
    let mut config = template;
    config.label = label.to_string();
    config.create = true;
    let num = |k: &str| spec.and_then(|s| s.get(k)).and_then(|v| v.as_f64());
    if let (Some(w), Some(h)) = (num("width"), num("height")) {
        config.width = w.max(config.min_width.unwrap_or(200.0));
        config.height = h.max(config.min_height.unwrap_or(150.0));
    }
    if let Some(title) = spec.and_then(|s| s.get("title")).and_then(|v| v.as_str()) {
        config.title = title.to_string();
    }
    let window_setting = |key: &str| spec.and_then(|s| s.get("settings")).and_then(|s| s.get(key)).cloned();
    let on_top = spec.and_then(|s| s.get("alwaysOnTop")).and_then(|v| v.as_bool());
    let mods = app.state::<ModsState>();
    let transparent = window_setting("window.transparent")
        .or_else(|| crate::mods::effective_core_setting(&mods, "window.transparent"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // Linux cannot blur what is behind a window: with a material (window.vibrancy) the window
    // stays opaque, as glass is never see-through without the blur (appearance.ts does the same).
    #[cfg(target_os = "linux")]
    let transparent = transparent
        && window_setting("window.vibrancy")
            .or_else(|| crate::mods::effective_core_setting(&mods, "window.vibrancy"))
            .and_then(|v| v.as_str().map(String::from))
            .is_none_or(|m| m.is_empty() || m == "none");
    if transparent {
        config.transparent = true;
        config.background_color = None;
        app.state::<WindowsState>().transparent.lock().unwrap().insert(label.to_string());
    } else {
        app.state::<WindowsState>().transparent.lock().unwrap().remove(label);
    }
    if on_top == Some(true) || crate::mods::effective_core_setting(&mods, "window.alwaysOnTop").and_then(|v| v.as_bool()) == Some(true) {
        config.always_on_top = true;
    }
    // Outside macOS the title bar is AICode's own (menus, window buttons), as in VS Code: no frame.
    #[cfg(not(target_os = "macos"))]
    {
        config.decorations = false;
    }
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;
    if let (Some(x), Some(y)) = (num("x"), num("y")) {
        builder = builder.position(x, y);
    } else {
        let anchor = app
            .state::<WindowsState>()
            .last_focused
            .lock()
            .unwrap()
            .clone()
            .and_then(|l| app.get_webview_window(&l));
        if let Some(anchor) = anchor {
            if let (Ok(pos), Ok(scale)) = (anchor.outer_position(), anchor.scale_factor()) {
                builder = builder.position(pos.x as f64 / scale + 28.0, pos.y as f64 / scale + 28.0);
            }
        }
    }
    let _window = builder.build()?;
    // The app's menu stays on the window for its shortcuts; the title bar shows it instead.
    #[cfg(not(target_os = "macos"))]
    let _ = _window.hide_menu();
    Ok(())
}

// ---------- a clean start ----------
//
// With `window.restoreOnStartup` = "none" (the default), AICode opens with one empty window: no
// files, no folder. The last session is not thrown away: its files move to `state/previous/<profile>/`,
// where "Reopen Last Session" finds them (and the window offers it when there was unsaved text).

fn previous_dir(profile: &str) -> std::path::PathBuf {
    paths::state().join("previous").join(profile)
}

/// Whether a saved session has anything in it (open editors or a folder).
fn session_has_content(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .map(|v| v.get("folder").is_some_and(|f| !f.is_null()) || v.pointer("/editors/docs").and_then(|d| d.as_array()).is_some_and(|d| !d.is_empty()))
        .unwrap_or(false)
}

/// At launch, for a clean start: moves the last session aside and leaves one window to open.
/// A previous session is only replaced by one that has something in it, so launching twice
/// without restoring never loses the first one's unsaved text.
pub fn stash_sessions(app: &AppHandle) {
    let profile = profile_name(app);
    let mut labels = read_registry(app);
    if !labels.contains(&"main".to_string()) {
        labels.insert(0, "main".into());
    }
    let found: Vec<(String, String)> = labels
        .iter()
        .filter_map(|l| std::fs::read_to_string(session_path_for(&profile, l)).ok().map(|t| (l.clone(), t)))
        .collect();
    if found.iter().any(|(_, t)| session_has_content(t)) {
        let dir = previous_dir(&profile);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let mut kept = Vec::new();
        for (label, text) in &found {
            if session_has_content(text) && crate::fsops::write_atomic(&dir.join(format!("{label}.json")), text.as_bytes()).is_ok() {
                kept.push(label.clone());
            }
        }
        let _ = crate::fsops::write_atomic(&dir.join("windows.json"), serde_json::to_string(&kept).unwrap_or_default().as_bytes());
    }
    for label in &labels {
        let _ = std::fs::remove_file(session_path_for(&profile, label));
    }
    write_registry(app, &[]);
}

fn previous_labels(profile: &str) -> Vec<String> {
    std::fs::read_to_string(previous_dir(profile).join("windows.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|l| paths::safe_name(l).is_some() && previous_dir(profile).join(format!("{l}.json")).is_file())
        .collect()
}

/// What the last session had, for the window to offer it back: windows, files, unsaved files,
/// folders. `offer` is true only the first time it is asked in this run of AICode.
#[tauri::command]
pub fn session_previous_info(app: AppHandle) -> Value {
    let profile = profile_name(&app);
    let (mut files, mut unsaved, mut folders) = (0, 0, Vec::<String>::new());
    let labels = previous_labels(&profile);
    for l in &labels {
        let Ok(text) = std::fs::read_to_string(previous_dir(&profile).join(format!("{l}.json"))) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(f) = v.get("folder").and_then(|f| f.as_str()) {
            folders.push(f.to_string());
        }
        for d in v.pointer("/editors/docs").and_then(|d| d.as_array()).cloned().unwrap_or_default() {
            if d.get("restore").is_some() {
                continue;
            }
            files += 1;
            let untitled_text = d.get("path").is_none_or(|p| p.is_null()) && d.get("text").and_then(|t| t.as_str()).is_some_and(|t| !t.is_empty());
            if d.get("dirty").and_then(|x| x.as_bool()) == Some(true) || untitled_text {
                unsaved += 1;
            }
        }
    }
    let offer = !labels.is_empty() && !app.state::<WindowsState>().previous_offered.swap(true, Ordering::SeqCst);
    json!({ "windows": labels.len(), "files": files, "unsaved": unsaved, "folders": folders, "offer": offer })
}

/// Brings the last session back: the first window's session is returned for the asking window to
/// load; every other window of it opens again on its own.
#[tauri::command]
pub fn session_restore_previous(app: AppHandle) -> Result<Option<String>, String> {
    let profile = profile_name(&app);
    let dir = previous_dir(&profile);
    let mut labels = previous_labels(&profile);
    if labels.is_empty() {
        return Ok(None);
    }
    if let Some(i) = labels.iter().position(|l| l == "main") {
        let main = labels.remove(i);
        labels.insert(0, main);
    }
    let first = std::fs::read_to_string(dir.join(format!("{}.json", labels[0]))).ok();
    for label in labels.iter().skip(1) {
        let new_label = next_label(&app);
        let from = dir.join(format!("{label}.json"));
        if std::fs::rename(&from, session_path(&app, &new_label)).is_err() && std::fs::copy(&from, session_path(&app, &new_label)).is_err() {
            continue;
        }
        create(&app, &new_label).map_err(|e| e.to_string())?;
        let mut open = open_labels(&app);
        if !open.contains(&new_label) {
            open.push(new_label);
        }
        write_registry(&app, &open);
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(first)
}

/// At launch: every window of the last session, or one fresh window.
pub fn restore(app: &AppHandle, initial_paths: Vec<String>) -> tauri::Result<()> {
    let mut labels = read_registry(app);
    if labels.is_empty() {
        labels.push("main".into());
    }
    if !initial_paths.is_empty() {
        app.state::<WindowsState>().pending.lock().unwrap().entry(labels[0].clone()).or_default().extend(initial_paths);
    }
    for label in &labels {
        if app.get_webview_window(label).is_none() {
            create(app, label)?;
        }
    }
    write_registry(app, &labels);
    Ok(())
}

fn next_label(app: &AppHandle) -> String {
    let used: Vec<String> = open_labels(app).into_iter().chain(read_registry(app)).collect();
    (1..).map(|n| format!("w-{n}")).find(|l| !used.contains(l)).unwrap()
}

/// Opens paths in a new window ("New Window" has none).
pub fn open_new(app: &AppHandle, paths_to_open: Vec<String>) -> Result<String, String> {
    open_new_with(app, paths_to_open, None)
}

/// A new window, optionally opened as something (`spec`: layout, view, size, always on top…).
pub fn open_new_with(app: &AppHandle, paths_to_open: Vec<String>, spec: Option<Value>) -> Result<String, String> {
    let label = next_label(app);
    if !paths_to_open.is_empty() {
        app.state::<WindowsState>().pending.lock().unwrap().insert(label.clone(), paths_to_open);
    }
    if let Some(spec) = spec.filter(|s| s.is_object()) {
        app.state::<WindowsState>().specs.lock().unwrap().insert(label.clone(), spec);
    }
    create(app, &label).map_err(|e| e.to_string())?;
    let mut labels = open_labels(app);
    if !labels.contains(&label) {
        labels.push(label.clone());
    }
    write_registry(app, &labels);
    Ok(label)
}

/// Paths the OS asked us to open while running: the window in front opens them.
pub fn open_in_front(app: &AppHandle, paths_to_open: Vec<String>) {
    let state = app.state::<WindowsState>();
    let target = state
        .last_focused
        .lock()
        .unwrap()
        .clone()
        .filter(|l| app.get_webview_window(l).is_some())
        .or_else(|| open_labels(app).into_iter().next());
    match target {
        Some(label) if state.ready.lock().unwrap().contains(&label) => {
            let _ = app.emit_to(label.as_str(), "open-paths", json!(paths_to_open));
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Some(label) => state.pending.lock().unwrap().entry(label).or_default().extend(paths_to_open),
        None => {
            let _ = open_new(app, paths_to_open);
        }
    }
}

/// The window in front (or the first one), for things that belong to "the user's window": menu
/// commands, MCP tool calls.
pub fn front_label(app: &AppHandle) -> Option<String> {
    let last = app.state::<WindowsState>().last_focused.lock().unwrap().clone();
    last.filter(|l| app.get_webview_window(l).is_some()).or_else(|| open_labels(app).into_iter().next())
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    let state = app.state::<WindowsState>();
    match event {
        tauri::WindowEvent::Focused(true) => {
            *state.last_focused.lock().unwrap() = Some(window.label().to_string());
        }
        tauri::WindowEvent::Destroyed => {
            let label = window.label().to_string();
            // Its mods' icons in the menu bar go with it.
            crate::background::drop_owned_by(app, &label);
            crate::native::drop_owned_by(app, &label);
            if state.reopening.lock().unwrap().contains(&label) {
                // Closed only to be created again: its programs end, its session stays.
                crate::procs::kill_owned_by(app, &label);
                state.ready.lock().unwrap().retain(|l| l != &label);
                return;
            }
            crate::procs::kill_owned_by(app, &label);
            state.ready.lock().unwrap().retain(|l| l != &label);
            state.specs.lock().unwrap().remove(&label);
            let remaining: Vec<String> = open_labels(app).into_iter().filter(|l| l != &label).collect();
            // Closing one of several windows forgets it; quitting, or closing the last, keeps all.
            if !state.quitting.load(Ordering::SeqCst) && !state.switching.load(Ordering::SeqCst) && !remaining.is_empty() {
                let _ = std::fs::remove_file(session_path(app, &label));
                write_registry(app, &remaining);
            }
        }
        _ => {}
    }
}

/// The paths in a command line (options left out), relative ones from `cwd`.
pub fn launch_args(args: impl IntoIterator<Item = String>, cwd: &std::path::Path) -> Vec<String> {
    to_paths(args.into_iter().filter(|a| !a.starts_with('-')).map(|a| {
        if std::path::Path::new(&a).is_absolute() || a.starts_with("file://") { a } else { crate::paths::ui(cwd.join(&a)) }
    }))
}

/// Another AICode was started (Windows, Linux: a file opened from Explorer or the file manager,
/// `aicode x` in a terminal). It quit at once and handed over its command line: its paths open here,
/// in the window in front, as files dropped on the Dock icon do on macOS. With no path AICode comes
/// to the front, hidden windows included.
#[cfg(any(windows, target_os = "linux"))]
pub fn second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let paths = launch_args(argv.into_iter().skip(1), std::path::Path::new(&cwd));
    let state = app.state::<WindowsState>();
    if !state.started.load(Ordering::SeqCst) {
        // Still starting: setup opens these with the rest.
        state.launch_paths.lock().unwrap().extend(paths);
        return;
    }
    if !paths.is_empty() {
        return open_in_front(app, paths);
    }
    let visible = app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false));
    crate::background::on_reopen(app, visible);
    match front_label(app).and_then(|l| app.get_webview_window(&l)) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        None => {
            let _ = open_new(app, vec![]);
        }
    }
}

/// Turns `file://` URLs and plain paths into paths.
pub fn to_paths(items: impl IntoIterator<Item = String>) -> Vec<String> {
    items
        .into_iter()
        .filter_map(|s| {
            if let Some(rest) = s.strip_prefix("file://") {
                let path = percent_decode(rest.strip_prefix("localhost").unwrap_or(rest));
                // file:///C:/x is the path C:/x.
                let drive = path.len() > 2 && path.starts_with('/') && path.as_bytes()[2] == b':';
                Some(if drive { path[1..].to_string() } else { path })
            } else if s.starts_with('/') || s.starts_with(r"\\") || (s.len() > 2 && s.as_bytes()[1] == b':') {
                Some(s)
            } else {
                None
            }
        })
        .map(crate::paths::ui)
        // No trailing `/`, except for a root (`/`, `C:/`).
        .map(|p| {
            let trimmed = p.trim_end_matches('/');
            if trimmed.is_empty() || trimmed.ends_with(':') { p } else { trimmed.to_string() }
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- commands ----------

#[tauri::command]
pub fn window_new(app: AppHandle, paths: Option<Vec<String>>, spec: Option<Value>) -> Result<String, String> {
    open_new_with(&app, paths.unwrap_or_default(), spec)
}

/// Whether this window was created transparent (it can only change by reopening it).
#[tauri::command]
pub fn window_is_transparent(window: tauri::Window, state: State<'_, WindowsState>) -> bool {
    state.transparent.lock().unwrap().contains(window.label())
}

/// What this window was opened as (see `window_new`'s `spec`), or null.
#[tauri::command]
pub fn window_take_spec(window: tauri::Window, state: State<'_, WindowsState>) -> Option<Value> {
    state.specs.lock().unwrap().get(window.label()).cloned()
}

/// Closes this window and creates it again with the same label (its session is kept): for what a
/// window can only be given when it is created, like transparency. The page saves its session first.
#[tauri::command]
pub fn window_reopen(app: AppHandle, window: tauri::Window, spec: Option<Value>) -> Result<(), String> {
    let label = window.label().to_string();
    let state = app.state::<WindowsState>();
    if let Some(spec) = spec.filter(|s| s.is_object()) {
        state.specs.lock().unwrap().insert(label.clone(), spec);
    }
    state.reopening.lock().unwrap().insert(label.clone());
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
        for _ in 0..100 {
            if app.get_webview_window(&label).is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let state = app.state::<WindowsState>();
        let spec = state.specs.lock().unwrap().get(&label).cloned();
        let app2 = app.clone();
        let label2 = label.clone();
        // Windows are created on the main thread.
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = create_with(&app2, &label2, spec.as_ref()) {
                eprintln!("[aicode] could not reopen window {label2}: {e}");
            }
            app2.state::<WindowsState>().reopening.lock().unwrap().remove(&label2);
        });
    });
    Ok(())
}

/// What this window should open now that it is loaded; later paths arrive as `open-paths`.
#[tauri::command]
pub fn window_take_pending(window: tauri::Window, state: State<'_, WindowsState>) -> Vec<String> {
    let label = window.label().to_string();
    let mut ready = state.ready.lock().unwrap();
    if !ready.contains(&label) {
        ready.push(label.clone());
    }
    state.pending.lock().unwrap().remove(&label).unwrap_or_default()
}

#[tauri::command]
pub fn window_count(app: AppHandle) -> usize {
    app.webview_windows().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_become_paths() {
        let got = to_paths(vec![
            "file:///Users/me/My%20Project/".to_string(),
            "file://localhost/tmp/a.txt".to_string(),
            "/plain/path".to_string(),
            "https://example.com".to_string(),
        ]);
        assert_eq!(got, vec!["/Users/me/My Project", "/tmp/a.txt", "/plain/path"]);
        assert_eq!(to_paths(vec!["file:///C:/Users/me/".to_string(), "C:/".to_string(), "/".to_string()]), vec!["C:/Users/me", "C:/", "/"]);
    }

    #[test]
    fn command_lines_become_paths() {
        let args = ["--flag", "notes.md", "/abs/dir/", "file:///tmp/x.txt"].map(String::from);
        assert_eq!(launch_args(args, std::path::Path::new("/home/me")), vec!["/home/me/notes.md", "/abs/dir", "/tmp/x.txt"]);
    }
}
