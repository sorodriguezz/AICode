//! Updates, like VS Code's "Check for Updates…": AICode asks the GitHub release feed
//! (`plugins.updater.endpoints` in tauri.conf.json) only when the user asks, or at startup if
//! *Settings → Updates → Check on Startup* is on. An update is a signed archive of the new app;
//! the signature is checked against the public key in tauri.conf.json before anything is replaced.
//!
//! Installing replaces the app on disk, then restarts it the way quitting does (hot exit), so
//! every window comes back with its tabs and unsaved text.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    /// The update the last check found, kept until it is installed.
    pending: Mutex<Option<Update>>,
    /// An install is running (from any window): a second one waits for nothing.
    installing: Mutex<bool>,
    /// The check at startup is made once per launch, by the first window that asks.
    startup_claimed: AtomicBool,
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    /// "downloading" → "installing" → "restarting"
    phase: &'static str,
}

/// True for the first window that asks in this launch: that one makes the check at startup, so
/// several restored windows (or a profile switch) do not each ask the feed.
#[tauri::command]
pub fn update_claim_startup_check(state: State<'_, UpdateState>) -> bool {
    !state.startup_claimed.swap(true, Ordering::SeqCst)
}

/// Asks the release feed for a newer version. `None`: this one is the latest.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(describe)?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.map(|d| d.date().to_string()),
    });
    *state.pending.lock().unwrap() = found;
    Ok(info)
}

/// Downloads and installs the update the last check found, then restarts AICode. Progress goes
/// to every window as `update-progress`.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Updates install only in the built app (pnpm tauri build), not in a dev build.".into());
    }
    let update = state.pending.lock().unwrap().clone().ok_or("Check for updates first.")?;
    {
        let mut busy = state.installing.lock().unwrap();
        if *busy {
            return Err("The update is already being installed.".into());
        }
        *busy = true;
    }
    let downloaded = AtomicU64::new(0);
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let result = update
        .download_and_install(
            |chunk, total| {
                let done = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                // A few events a second is enough for a progress bar.
                if last_emit.elapsed() >= std::time::Duration::from_millis(100) || Some(done) == total {
                    last_emit = std::time::Instant::now();
                    let _ = app.emit("update-progress", Progress { downloaded: done, total, phase: "downloading" });
                }
            },
            || {
                let _ = app.emit("update-progress", Progress { downloaded: downloaded.load(Ordering::Relaxed), total: None, phase: "installing" });
            },
        )
        .await;
    if let Err(e) = result {
        *app.state::<UpdateState>().installing.lock().unwrap() = false;
        return Err(describe(e));
    }
    let _ = app.emit("update-progress", Progress { downloaded: downloaded.load(Ordering::Relaxed), total: None, phase: "restarting" });
    restart(&app);
    Ok(())
}

/// Every window saves its session (as when switching profiles), then AICode restarts through the
/// normal quit path, which keeps sessions (see `RunEvent::ExitRequested` in lib.rs).
fn restart(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = app.emit("session-flush", ());
        std::thread::sleep(std::time::Duration::from_millis(500));
        app.request_restart();
    });
}

/// Errors in words a user can act on.
fn describe(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(_) | E::Network(_) => format!("Could not reach the update server. Check your connection. ({e})"),
        E::ReleaseNotFound => "No release was found on the update server.".into(),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => "The latest release has no build for this platform yet.".into(),
        E::Minisign(_) | E::SignatureUtf8(_) | E::Base64(_) => format!("The update's signature is not valid, so it was not installed. ({e})"),
        E::Io(ref io) if io.kind() == std::io::ErrorKind::PermissionDenied || io.raw_os_error() == Some(30) => {
            format!("AICode cannot replace itself where it is. Move AICode to the Applications folder (not run from the disk image) and try again. ({e})")
        }
        other => other.to_string(),
    }
}
