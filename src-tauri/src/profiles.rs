//! Profiles: separate spaces, each with its own mods (on/off and installed), settings, keybindings,
//! windows and sessions. One is active at a time, for every window; switching closes the windows
//! of the old profile (their sessions kept) and brings back the new one's.
//!
//! ```text
//! profiles/<name>/profile.json   enabled mods, settings (editor's under "core"), keybindings
//! profiles/<name>/mods/<id>/     mods installed only in this profile
//! state/windows-<name>.json      its windows; state/session-<name>[-<window>].json their sessions
//! ```

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::bundle;
use crate::mods::{self, ModsState, Profile};
use crate::paths;
use crate::windows;

fn valid(name: &str) -> Result<String, String> {
    paths::safe_name(name.trim()).ok_or_else(|| "a profile name uses letters, digits, '.', '-' and '_'".to_string())
}

#[derive(Serialize)]
pub struct ProfileView {
    name: String,
    description: String,
    icon: Option<String>,
    enabled: Vec<String>,
    keybindings: Vec<Value>,
    available: Vec<String>,
    /// The profile.json, for "Open Profile Settings (JSON)".
    path: String,
    #[serde(rename = "modsDir")]
    mods_dir: String,
}

#[derive(Serialize)]
pub struct ProfileSummary {
    name: String,
    description: String,
    icon: Option<String>,
    active: bool,
    enabled: usize,
    /// Mods installed in this profile only.
    own: Vec<String>,
    keybindings: usize,
    windows: usize,
}

#[tauri::command]
pub fn profile_get(state: State<'_, ModsState>) -> ProfileView {
    let name = state.profile_name.lock().unwrap().clone();
    let mut available = mods::profile_names();
    if !available.contains(&name) {
        available.push(name.clone());
        available.sort();
    }
    let p = state.profile.lock().unwrap().clone();
    ProfileView {
        description: p.description,
        icon: p.icon,
        enabled: p.enabled,
        keybindings: p.keybindings,
        available,
        path: mods::profile_path(&name).to_string_lossy().into(),
        mods_dir: mods::profile_mods_dir(&name).to_string_lossy().into(),
        name,
    }
}

fn own_mods(name: &str) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(mods::profile_mods_dir(name))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("mod.json").is_file() && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids
}

#[tauri::command]
pub fn profile_list(state: State<'_, ModsState>) -> Vec<ProfileSummary> {
    let active = state.profile_name.lock().unwrap().clone();
    let mut names = mods::profile_names();
    if !names.contains(&active) {
        names.push(active.clone());
        names.sort();
    }
    names
        .into_iter()
        .map(|name| {
            let p = if name == active { state.profile.lock().unwrap().clone() } else { mods::read_profile(&name) };
            ProfileSummary {
                description: p.description,
                icon: p.icon,
                active: name == active,
                enabled: p.enabled.len(),
                own: own_mods(&name),
                keybindings: p.keybindings.len(),
                windows: windows::registry_for(&name).len().max(1),
                name,
            }
        })
        .collect()
}

/// A new profile: empty (a plain notepad), or a copy of another one, mods included.
#[tauri::command]
pub fn profile_create(name: String, copy_from: Option<String>, description: Option<String>) -> Result<String, String> {
    let name = valid(&name)?;
    if mods::profile_names().contains(&name) {
        return Err(format!("there is already a profile called {name}"));
    }
    let mut profile = match &copy_from {
        Some(from) => {
            let from = valid(from)?;
            let src_mods = mods::profile_mods_dir(&from);
            if src_mods.is_dir() {
                mods::copy_dir(&src_mods, &mods::profile_mods_dir(&name)).map_err(|e| e.to_string())?;
            }
            mods::read_profile(&from)
        }
        None => Profile::default(),
    };
    if let Some(d) = description {
        profile.description = d;
    }
    mods::write_profile(&name, &profile)?;
    Ok(name)
}

#[tauri::command]
pub fn profile_rename(app: AppHandle, state: State<'_, ModsState>, from: String, to: String) -> Result<String, String> {
    let from = valid(&from)?;
    let to = valid(&to)?;
    if from == to {
        return Ok(to);
    }
    if mods::profile_names().contains(&to) {
        return Err(format!("there is already a profile called {to}"));
    }
    mods::read_profile(&from); // migrates an old single-file profile into its folder
    std::fs::rename(mods::profile_dir(&from), mods::profile_dir(&to)).map_err(|e| e.to_string())?;
    windows::rename_profile_state(&from, &to);
    let was_active = {
        let mut active = state.profile_name.lock().unwrap();
        let was = *active == from;
        if was {
            *active = to.clone();
        }
        was
    };
    if was_active {
        crate::fsops::write_atomic(&paths::state().join("active-profile"), to.as_bytes())?;
        mods::refresh(&app, &state);
    }
    Ok(to)
}

#[tauri::command]
pub fn profile_delete(state: State<'_, ModsState>, name: String) -> Result<(), String> {
    let name = valid(&name)?;
    if *state.profile_name.lock().unwrap() == name {
        return Err("switch to another profile before deleting this one".into());
    }
    let dir = mods::profile_dir(&name);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(paths::profiles().join(format!("{name}.json")));
    windows::forget_profile_state(&name);
    Ok(())
}

/// Switches every window to another profile (creating it, empty, if it does not exist).
#[tauri::command]
pub fn profile_switch(app: AppHandle, state: State<'_, ModsState>, name: String) -> Result<(), String> {
    let name = valid(&name)?;
    if !mods::profile_path(&name).exists() && !paths::profiles().join(format!("{name}.json")).exists() {
        mods::write_profile(&name, &Profile::default())?;
    }
    if *state.profile_name.lock().unwrap() == name {
        return Ok(());
    }
    windows::switch_profile(&app, name);
    Ok(())
}

/// Activates a profile in the state (used once its old windows are gone).
pub fn activate(app: &AppHandle, state: &ModsState, name: &str) {
    let profile = mods::read_profile(name);
    let _ = crate::fsops::write_atomic(&paths::state().join("active-profile"), name.as_bytes());
    *state.profile_name.lock().unwrap() = name.to_string();
    *state.profile.lock().unwrap() = profile;
    mods::refresh(app, state);
}

/// Re-reads the active profile.json after it was edited by hand.
#[tauri::command]
pub fn profile_reload(app: AppHandle, window: tauri::Window, state: State<'_, ModsState>) -> Result<(), String> {
    let name = state.profile_name.lock().unwrap().clone();
    let text = std::fs::read_to_string(mods::profile_path(&name)).map_err(|e| e.to_string())?;
    let profile: Profile = serde_json::from_str(&text).map_err(|e| format!("profile.json: {e}"))?;
    *state.profile.lock().unwrap() = profile;
    mods::refresh(&app, &state);
    // The other windows apply the saved file too.
    use tauri::Emitter;
    let _ = app.emit("settings://changed", window.label());
    Ok(())
}

#[tauri::command]
pub fn profile_set_info(state: State<'_, ModsState>, description: Option<String>, icon: Option<String>) -> Result<(), String> {
    let mut p = state.profile.lock().unwrap();
    if let Some(d) = description {
        p.description = d;
    }
    if let Some(i) = icon {
        p.icon = if i.is_empty() { None } else { Some(i) };
    }
    let name = state.profile_name.lock().unwrap().clone();
    mods::write_profile(&name, &p)
}

#[tauri::command]
pub fn profile_set_keybindings(state: State<'_, ModsState>, keybindings: Vec<Value>) -> Result<(), String> {
    let mut p = state.profile.lock().unwrap();
    p.keybindings = keybindings;
    let name = state.profile_name.lock().unwrap().clone();
    mods::write_profile(&name, &p)
}

#[tauri::command]
pub fn profile_export(app: AppHandle, state: State<'_, ModsState>, name: String, path: String, include_shared: Option<bool>) -> Result<usize, String> {
    let name = valid(&name)?;
    let bundle = bundle::pack_profile(&app, &state, &name, include_shared.unwrap_or(true))?;
    let count = bundle.mods.len();
    let text = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    crate::fsops::write_atomic(Path::new(&path), text.as_bytes())?;
    Ok(count)
}

#[tauri::command]
pub fn profile_import(app: AppHandle, path: String, name: Option<String>) -> Result<bundle::ImportedProfile, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    bundle::unpack_profile(&app, &text, name)
}
