//! Mods: discovery, profiles, permissions and the `aimod://` protocol that serves their files.
//!
//! A mod is a folder with a `mod.json` (which can be all there is: a mod can be one JSON file).
//! Three places hold them, later ones replacing earlier ones with the same id:
//! - **bundled** — shipped inside the app (`resources/mods`), read-only;
//! - **shared** — `AICode/mods/<id>`, installed for every profile;
//! - **profile** — `AICode/profiles/<profile>/mods/<id>`, installed only in that profile, and
//!   exported and imported with it.
//!
//! Installed is not enabled, and enabled is not running: the active **profile** lists the enabled
//! ids, and the window only loads a mod's code when one of its activation events fires.
//!
//! Permissions are declared in the manifest to tell the user what a mod does (the Mods view and the
//! install prompt show them); they do not limit it. A mod can do anything the editor can: mods run in
//! the window's JavaScript realm, and AICode is meant to be changed without limits. The only check on
//! every command is that the mod is installed and enabled.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::paths;

/// The mod API version this core implements. A mod declares the one it was written against.
pub const API_VERSION: u32 = 1;

pub const PERMISSIONS: &[(&str, &str)] = &[
    ("fs:read", "Read files and folders"),
    ("fs:write", "Create and change files and folders"),
    ("process", "Run programs installed on this machine"),
    ("pty", "Open terminals"),
    ("mcp-server", "Serve AICode's tools to agents on 127.0.0.1"),
    ("open-external", "Open links and other apps"),
    ("network", "Make HTTP requests to any address"),
    ("secrets", "Keep passwords and tokens in the system's password store (Keychain, Credential Manager, Secret Service)"),
    ("app", "Keep running in the background: menu bar icons, the Dock, hiding windows, global shortcuts"),
    ("native", "Run native code: JavaScript for Automation inside AICode on macOS, PowerShell on Windows, Python 3 on Linux"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// Entry module, relative to the mod folder. None for a purely declarative mod (a theme).
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default = "default_api")]
    pub api: u32,
    #[serde(default)]
    pub activation: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default, rename = "optionalDependencies")]
    pub optional_dependencies: Vec<String>,
    #[serde(default)]
    pub contributes: Value,
    #[serde(default)]
    pub icon: Option<String>,
}

fn default_api() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct ModInfo {
    #[serde(flatten)]
    pub manifest: Manifest,
    pub source: &'static str,
    pub dir: String,
    pub enabled: bool,
    pub problems: Vec<String>,
}

/// A profile is a space of its own: which mods are on, their settings and the editor's (under
/// `core`), the user's keybindings, its own mods (in its folder), and its own windows and sessions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub enabled: Vec<String>,
    #[serde(default)]
    pub settings: Map<String, Value>,
    /// `[{ "key": "mod+k t", "command": "preferences.theme", "args": … }]`, applied over the mods' own.
    #[serde(default)]
    pub keybindings: Vec<Value>,
    /// The mods of [`DEFAULT_ON`] this profile has already been given. Each is turned on once (a
    /// new profile, or an old one the first time this AICode reads it), so one turned off stays off.
    #[serde(default, rename = "defaultsOffered", skip_serializing_if = "Vec::is_empty")]
    pub defaults_offered: Vec<String>,
}

/// Mods every profile starts with, because they do what the core itself used to (or what an editor
/// is expected to): the file icons (Seti) were built in before they became `aicode.icons`, the
/// JSON/YAML keys in the breadcrumbs before they became `aicode.json-yaml`, and images open as
/// images with `aicode.image-preview`.
pub const DEFAULT_ON: &[&str] = &["aicode.icons", "aicode.json-yaml", "aicode.image-preview"];

/// Mods split out of another one: a profile that had the first on gets the others, once, so it
/// keeps what it had (the AI Chat carried every agent; Glass carried pill tabs and the cursor).
pub const SPLIT_FROM: &[(&str, &[&str])] = &[
    (
        "aicode.agents",
        &[
            "aicode.agent-claude",
            "aicode.agent-codex",
            "aicode.agent-gemini",
            "aicode.agent-grok",
            "aicode.agent-opencode",
            "aicode.agent-cline",
            "aicode.agent-ollama",
            "aicode.agent-custom",
        ],
    ),
    ("aicode.glass", &["aicode.soft-look"]),
];

impl Profile {
    /// Turns on the default mods this profile was never given. True when something changed.
    pub fn offer_defaults(&mut self) -> bool {
        let mut changed = false;
        for id in DEFAULT_ON {
            if self.defaults_offered.iter().any(|d| d == id) {
                continue;
            }
            self.defaults_offered.push(id.to_string());
            if !self.enabled.iter().any(|e| e == id) {
                self.enabled.push(id.to_string());
            }
            changed = true;
        }
        for (from, parts) in SPLIT_FROM {
            let had = self.enabled.iter().any(|e| e == from);
            for id in *parts {
                if self.defaults_offered.iter().any(|d| d == id) {
                    continue;
                }
                // Recorded either way: a one-time move, not a rule that fires when the user later
                // turns the original mod on.
                self.defaults_offered.push(id.to_string());
                if had && !self.enabled.iter().any(|e| e == id) {
                    self.enabled.push(id.to_string());
                }
                changed = true;
            }
        }
        changed
    }
}

pub struct ModsState {
    pub profile_name: Mutex<String>,
    pub profile: Mutex<Profile>,
    pub mods: Mutex<Vec<ModInfo>>,
}

impl ModsState {
    pub fn load() -> Self {
        let name = std::fs::read_to_string(paths::state().join("active-profile"))
            .ok()
            .and_then(|s| paths::safe_name(s.trim()))
            .unwrap_or_else(|| "default".into());
        let profile = read_profile(&name);
        Self { profile_name: Mutex::new(name), profile: Mutex::new(profile), mods: Mutex::new(Vec::new()) }
    }
}

/// `profiles/<name>/` holds `profile.json` and `mods/`.
pub fn profile_dir(name: &str) -> PathBuf {
    paths::profiles().join(name)
}

pub fn profile_path(name: &str) -> PathBuf {
    profile_dir(name).join("profile.json")
}

pub fn profile_mods_dir(name: &str) -> PathBuf {
    profile_dir(name).join("mods")
}

/// Profiles used to be a single `profiles/<name>.json`; move one into its folder the first time.
fn migrate(name: &str) {
    let legacy = paths::profiles().join(format!("{name}.json"));
    if legacy.is_file() && !profile_path(name).exists() {
        let _ = std::fs::create_dir_all(profile_dir(name));
        let _ = std::fs::rename(&legacy, profile_path(name));
    }
}

pub fn read_profile(name: &str) -> Profile {
    migrate(name);
    let parsed: Option<Profile> = std::fs::read_to_string(profile_path(name)).ok().and_then(|s| serde_json::from_str(&s).ok());
    let on_disk = parsed.is_some();
    let mut profile = parsed.unwrap_or_default();
    // The default mods, once per profile. Saved only over a profile.json that read fine: one that
    // does not parse is the user's to fix, not to overwrite.
    if profile.offer_defaults() && on_disk {
        let _ = write_profile(name, &profile);
    }
    profile
}

pub fn write_profile(name: &str, profile: &Profile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(profile_mods_dir(name));
    crate::fsops::write_atomic(&profile_path(name), text.as_bytes())
}

/// Every profile on disk (folders with a profile.json, and not yet migrated files).
pub fn profile_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(paths::profiles())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if path.is_dir() && path.join("profile.json").is_file() {
                Some(name)
            } else {
                name.strip_suffix(".json").filter(|_| path.is_file()).map(String::from)
            }
        })
        .filter(|n| paths::safe_name(n).is_some())
        .collect();
    names.sort();
    names.dedup();
    names
}

pub fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    // In a debug build the mods come straight from the source tree, so editing one and reloading
    // the window is the whole development loop.
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../mods"));
        if dev.is_dir() {
            return Some(dev);
        }
    }
    #[allow(unreachable_code)]
    app.path().resource_dir().ok().map(|d| d.join("mods")).filter(|d| d.is_dir())
}

pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(dir.join("mod.json")).map_err(|e| format!("mod.json: {e}"))?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("mod.json: {e}"))?;
    if paths::safe_name(&manifest.id).is_none() {
        return Err(format!("invalid id {:?}", manifest.id));
    }
    Ok(manifest)
}

fn scan_dir(dir: &Path, source: &'static str, out: &mut BTreeMap<String, ModInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        match read_manifest(&path) {
            Ok(manifest) => {
                out.insert(
                    manifest.id.clone(),
                    ModInfo { manifest, source, dir: crate::paths::ui(&path), enabled: false, problems: vec![] },
                );
            }
            Err(e) => eprintln!("[aicode] skipping mod at {}: {e}", path.display()),
        }
    }
}

/// Every installed mod, with what the profile says and what is wrong with it.
pub fn scan(app: &AppHandle, profile_name: &str, profile: &Profile) -> Vec<ModInfo> {
    let mut found = BTreeMap::new();
    if let Some(dir) = bundled_dir(app) {
        scan_dir(&dir, "bundled", &mut found);
    }
    scan_dir(&paths::user_mods(), "shared", &mut found);
    scan_dir(&profile_mods_dir(profile_name), "profile", &mut found);
    let ids: HashSet<String> = found.keys().cloned().collect();
    let known: HashSet<&str> = PERMISSIONS.iter().map(|(p, _)| *p).collect();
    for info in found.values_mut() {
        info.enabled = profile.enabled.contains(&info.manifest.id);
        if info.manifest.api > API_VERSION {
            info.problems.push(format!("needs mod API {}, this AICode has {API_VERSION}", info.manifest.api));
        }
        for dep in &info.manifest.dependencies {
            if !ids.contains(dep) {
                info.problems.push(format!("needs {dep}, which is not installed"));
            }
        }
        for perm in &info.manifest.permissions {
            if !known.contains(perm.as_str()) {
                info.problems.push(format!("asks for unknown permission {perm:?}"));
            }
        }
    }
    found.into_values().collect()
}

pub fn refresh(app: &AppHandle, state: &ModsState) -> Vec<ModInfo> {
    let profile = state.profile.lock().unwrap().clone();
    let name = state.profile_name.lock().unwrap().clone();
    let mods = scan(app, &name, &profile);
    *state.mods.lock().unwrap() = mods.clone();
    mods
}

/// What every mod-facing command checks: the mod is installed and on. `core` is the editor itself.
/// `permission` names what the command does; an enabled mod may use any, declared or not.
pub fn require(state: &ModsState, mod_id: &str, _permission: &str) -> Result<(), String> {
    if mod_id == "core" {
        return Ok(());
    }
    let mods = state.mods.lock().unwrap();
    let Some(info) = mods.iter().find(|m| m.manifest.id == mod_id) else {
        return Err(format!("unknown mod {mod_id}"));
    };
    if !info.enabled {
        return Err(format!("{mod_id} is not enabled"));
    }
    Ok(())
}

#[tauri::command]
pub fn mods_list(app: AppHandle, state: State<'_, ModsState>) -> Vec<ModInfo> {
    refresh(&app, &state)
}

#[tauri::command]
pub fn mods_permissions() -> Vec<(String, String)> {
    PERMISSIONS.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

/// Turns a mod on or off. Turning one on also turns on what it needs; turning one off also turns
/// off what needs it. Returns the ids whose state changed, so the window can say so.
#[tauri::command]
pub fn profile_set_enabled(
    app: AppHandle,
    state: State<'_, ModsState>,
    id: String,
    enabled: bool,
) -> Result<Vec<String>, String> {
    let mods = refresh(&app, &state);
    let by_id: BTreeMap<&str, &ModInfo> = mods.iter().map(|m| (m.manifest.id.as_str(), m)).collect();
    if !by_id.contains_key(id.as_str()) {
        return Err(format!("{id} is not installed"));
    }
    let mut profile = state.profile.lock().unwrap();
    let mut on: Vec<String> = profile.enabled.clone();
    let before: HashSet<String> = on.iter().cloned().collect();
    if enabled {
        let mut stack = vec![id.clone()];
        while let Some(next) = stack.pop() {
            let Some(info) = by_id.get(next.as_str()) else {
                return Err(format!("{next} is needed but not installed"));
            };
            if !on.contains(&next) {
                on.push(next.clone());
            }
            stack.extend(info.manifest.dependencies.iter().filter(|d| !on.contains(d)).cloned());
        }
    } else {
        let mut off = vec![id.clone()];
        let mut i = 0;
        while i < off.len() {
            let target = off[i].clone();
            for info in &mods {
                if on.contains(&info.manifest.id)
                    && info.manifest.dependencies.contains(&target)
                    && !off.contains(&info.manifest.id)
                {
                    off.push(info.manifest.id.clone());
                }
            }
            i += 1;
        }
        on.retain(|m| !off.contains(m));
    }
    let after: HashSet<String> = on.iter().cloned().collect();
    let changed: Vec<String> = before.symmetric_difference(&after).cloned().collect();
    profile.enabled = on;
    let name = state.profile_name.lock().unwrap().clone();
    write_profile(&name, &profile)?;
    drop(profile);
    refresh(&app, &state);
    Ok(changed)
}

/// A mod's settings, or the editor's own under `core`. Each mod reads only its own.
#[tauri::command]
pub fn settings_get(state: State<'_, ModsState>, mod_id: String) -> Value {
    state.profile.lock().unwrap().settings.get(&mod_id).cloned().unwrap_or(Value::Object(Map::new()))
}

/// Every owner's settings at once (the editor's under `core`): the user layer of the configuration.
#[tauri::command]
pub fn settings_all(state: State<'_, ModsState>) -> Value {
    Value::Object(state.profile.lock().unwrap().settings.clone())
}

/// A core setting as the window should start with it: the user's value, else the last enabled
/// mod's `contributes.configurationDefaults` (as in the frontend's layers), else `None`.
pub fn effective_core_setting(state: &ModsState, key: &str) -> Option<Value> {
    if let Some(v) = state.profile.lock().unwrap().settings.get("core").and_then(|c| c.get(key)).filter(|v| !v.is_null()) {
        return Some(v.clone());
    }
    let mods = state.mods.lock().unwrap();
    let mut found = None;
    for m in mods.iter().filter(|m| m.enabled && m.problems.is_empty()) {
        let defaults = m.manifest.contributes.get("configurationDefaults");
        let v = defaults.and_then(|d| d.get("core")).and_then(|c| c.get(key)).or_else(|| defaults.and_then(|d| d.get(key)));
        if let Some(v) = v.filter(|v| !v.is_null()) {
            found = Some(v.clone());
        }
    }
    found
}

#[tauri::command]
pub fn settings_set(app: AppHandle, window: tauri::Window, state: State<'_, ModsState>, mod_id: String, key: String, value: Value) -> Result<(), String> {
    let menu_shows = mod_id == "core" && key == "files.autoSave";
    settings_write(&state, mod_id, key, value)?;
    if menu_shows {
        crate::menu::refresh(&app);
    }
    // Every other window rereads the settings, so a change shows everywhere at once.
    use tauri::Emitter;
    let _ = app.emit("settings://changed", window.label());
    Ok(())
}

fn settings_write(state: &ModsState, mod_id: String, key: String, value: Value) -> Result<(), String> {
    let mut profile = state.profile.lock().unwrap();
    let entry = profile.settings.entry(mod_id).or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(map) = entry {
        if value.is_null() {
            map.remove(&key);
        } else {
            map.insert(key, value);
        }
    }
    let name = state.profile_name.lock().unwrap().clone();
    write_profile(&name, &profile)
}

/// Where an install goes: this profile's own mods (the default), or every profile's.
pub fn install_root(state: &ModsState, scope: Option<&str>) -> PathBuf {
    match scope {
        Some("shared") => paths::user_mods(),
        _ => profile_mods_dir(&state.profile_name.lock().unwrap()),
    }
}

#[derive(Serialize)]
pub struct Installed {
    pub id: String,
    pub dir: String,
    pub permissions: Vec<String>,
}

/// Installs a mod from a folder on disk: validated, then copied into the profile (or shared) mods.
#[tauri::command]
pub fn mod_install_folder(app: AppHandle, state: State<'_, ModsState>, path: String, scope: Option<String>) -> Result<Installed, String> {
    let src = PathBuf::from(&path);
    let manifest = read_manifest(&src)?;
    let dest = install_root(&state, scope.as_deref()).join(&manifest.id);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir(&src, &dest).map_err(|e| e.to_string())?;
    refresh(&app, &state);
    Ok(Installed { id: manifest.id, dir: crate::paths::ui(&dest), permissions: manifest.permissions })
}

/// Removes an installed mod (never a bundled one) and turns it off.
#[tauri::command]
pub fn mod_uninstall(app: AppHandle, state: State<'_, ModsState>, id: String) -> Result<(), String> {
    let id = paths::safe_name(&id).ok_or("invalid id")?;
    let dir = {
        let mods = state.mods.lock().unwrap();
        mods.iter().find(|m| m.manifest.id == id && m.source != "bundled").map(|m| PathBuf::from(&m.dir))
    };
    let Some(dir) = dir.filter(|d| d.is_dir()) else {
        return Err(format!("{id} is not an installed mod"));
    };
    let _ = profile_set_enabled(app.clone(), state.clone(), id.clone(), false);
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    refresh(&app, &state);
    Ok(())
}

/// The folder new mods of this profile go in.
#[tauri::command]
pub fn mods_folder(state: State<'_, ModsState>, scope: Option<String>) -> String {
    let dir = install_root(&state, scope.as_deref());
    let _ = std::fs::create_dir_all(&dir);
    crate::paths::ui(&dir)
}

pub fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let from = entry.path();
        let to = dest.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "md" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `aimod://localhost/<mod id>/<file>` — a file of an enabled mod, and nothing outside its folder.
pub fn serve(app: &AppHandle, path: &str) -> (u16, &'static str, Vec<u8>) {
    let not_found = (404, "text/plain", b"not found".to_vec());
    let path = path.trim_start_matches('/');
    let decoded = percent_decode(path);
    let Some((id, rest)) = decoded.split_once('/') else { return not_found };
    let state = app.state::<ModsState>();
    let dir = {
        let mods = state.mods.lock().unwrap();
        match mods.iter().find(|m| m.manifest.id == id && m.enabled) {
            Some(m) => PathBuf::from(&m.dir),
            None => return (403, "text/plain", b"mod not enabled".to_vec()),
        }
    };
    let (Ok(root), Ok(file)) = (dir.canonicalize(), dir.join(rest).canonicalize()) else { return not_found };
    if !file.starts_with(&root) || !file.is_file() {
        return not_found;
    }
    match std::fs::read(&file) {
        Ok(bytes) => (200, content_type(&file), bytes),
        Err(_) => not_found,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mods_are_offered_once() {
        // A profile from before aicode.icons existed gets it, once…
        let mut p: Profile = serde_json::from_str(r#"{"enabled":["aicode.explorer"]}"#).unwrap();
        assert!(p.offer_defaults());
        assert!(p.enabled.contains(&"aicode.icons".to_string()));
        // …and one that turned it off keeps it off.
        p.enabled.retain(|e| e != "aicode.icons");
        assert!(!p.offer_defaults());
        assert!(!p.enabled.contains(&"aicode.icons".to_string()));
        let saved = serde_json::to_string(&p).unwrap();
        assert!(saved.contains("defaultsOffered"));
        let mut again: Profile = serde_json::from_str(&saved).unwrap();
        assert!(!again.offer_defaults());
    }

    #[test]
    fn split_mods_follow_the_original_once() {
        let mut p: Profile = serde_json::from_str(r#"{"enabled":["aicode.agents"]}"#).unwrap();
        assert!(p.offer_defaults());
        assert!(p.enabled.contains(&"aicode.agent-claude".to_string()));
        assert!(!p.enabled.contains(&"aicode.soft-look".to_string()));
        // Turning Glass on later does not pull Soft Look in: the move happened once.
        p.enabled.push("aicode.glass".into());
        p.enabled.retain(|e| e != "aicode.agent-claude");
        assert!(!p.offer_defaults());
        assert!(!p.enabled.contains(&"aicode.soft-look".to_string()));
        assert!(!p.enabled.contains(&"aicode.agent-claude".to_string()));
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b/c%2Fd"), "a b/c/d");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("trail%2"), "trail%2");
    }

    #[test]
    fn manifest_defaults() {
        let m: Manifest = serde_json::from_str(r#"{"id":"x.y","name":"Y","version":"1.0.0"}"#).unwrap();
        assert_eq!(m.api, 1);
        assert!(m.main.is_none());
        assert!(m.permissions.is_empty());
    }

    #[test]
    fn permission_gate() {
        let state = ModsState {
            profile_name: Mutex::new("t".into()),
            profile: Mutex::new(Profile::default()),
            mods: Mutex::new(vec![ModInfo {
                manifest: serde_json::from_str(
                    r#"{"id":"a.b","name":"B","version":"1","permissions":["fs:read"]}"#,
                )
                .unwrap(),
                source: "user",
                dir: ".".into(),
                enabled: true,
                problems: vec![],
            }]),
        };
        assert!(require(&state, "core", "pty").is_ok());
        assert!(require(&state, "a.b", "fs:read").is_ok());
        // Undeclared is allowed: permissions describe a mod, they do not limit it.
        assert!(require(&state, "a.b", "fs:write").is_ok());
        assert!(require(&state, "a.b", "process").is_ok());
        assert!(require(&state, "nope", "fs:read").is_err());
        state.mods.lock().unwrap()[0].enabled = false;
        assert!(require(&state, "a.b", "fs:read").is_err());
    }
}
