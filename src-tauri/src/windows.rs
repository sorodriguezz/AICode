//! Windows. Like VS Code, AICode can have several, each with its own folder, tabs and layout:
//!
//! - `state/windows-<profile>.json` lists the windows that were open; all of them come back at
//!   launch, each from `state/session-<profile>-<label>.json`.
//! - Closing a window while others stay open forgets it (its programs and terminals end with it).
//!   Quitting, or closing the last window, keeps every session — that is hot exit.
//! - Paths to open (a file dropped on the Dock icon, "Open With", `open -a AICode x`, the command
//!   line, "Open Folder in New Window") wait in [`WindowsState::pending`] until the window that should
//!   open them asks, so nothing is lost while a window is still loading.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::json;
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
/// front so it does not hide it exactly.
pub fn create(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let template = app.config().app.windows.iter().find(|w| w.label == "main").cloned().unwrap_or_default();
    let mut config = template;
    config.label = label.to_string();
    config.create = true;
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;
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
    builder.build()?;
    Ok(())
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
        create(app, label)?;
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
    let label = next_label(app);
    if !paths_to_open.is_empty() {
        app.state::<WindowsState>().pending.lock().unwrap().insert(label.clone(), paths_to_open);
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
            crate::procs::kill_owned_by(app, &label);
            state.ready.lock().unwrap().retain(|l| l != &label);
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

/// Turns `file://` URLs and plain paths into paths.
pub fn to_paths(items: impl IntoIterator<Item = String>) -> Vec<String> {
    items
        .into_iter()
        .filter_map(|s| {
            if let Some(rest) = s.strip_prefix("file://") {
                let path = rest.strip_prefix("localhost").unwrap_or(rest);
                Some(percent_decode(path))
            } else if s.starts_with('/') || (s.len() > 2 && s.as_bytes()[1] == b':') {
                Some(s)
            } else {
                None
            }
        })
        .map(|p| if p.len() > 1 { p.trim_end_matches('/').to_string() } else { p })
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
pub fn window_new(app: AppHandle, paths: Option<Vec<String>>) -> Result<String, String> {
    open_new(&app, paths.unwrap_or_default())
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
    }
}
