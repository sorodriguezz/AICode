//! Moving mods and profiles between machines as single JSON files:
//!
//! - `<id>.aicode-mod` — `{ "format": "aicode-mod", "version": 1, "id", "files": { "mod.json": { "text": … }, "icon.png": { "base64": … } } }`
//! - `<name>.aicode-profile` — `{ "format": "aicode-profile", "version": 1, "name", "profile": { enabled, settings, keybindings, … }, "mods": [ <aicode-mod>… ] }`
//!
//! A plain `mod.json` is also a mod: a declarative one, with nothing but JSON (see
//! `docs/MOD-GUIDE.md`). So "install from file" takes any of the three.
//!
//! Imports only ever write inside the destination folder: every path in a bundle must be relative
//! and plain (no `..`, no absolute paths), and the whole bundle is unpacked into a temporary folder
//! that replaces the old one only once it is complete.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::mods::{self, Installed, Manifest, ModsState, Profile};
use crate::paths;

const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Default)]
pub struct FileEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ModBundle {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub files: BTreeMap<String, FileEntry>,
}

#[derive(Serialize, Deserialize)]
pub struct ProfileBundle {
    pub format: String,
    pub version: u32,
    pub name: String,
    #[serde(default, rename = "exportedBy")]
    pub exported_by: String,
    pub profile: Profile,
    #[serde(default)]
    pub mods: Vec<ModBundle>,
}

fn collect(dir: &Path, rel: &str, files: &mut BTreeMap<String, FileEntry>, total: &mut u64) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let key = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if path.is_dir() {
            collect(&path, &key, files, total)?;
        } else if path.is_file() {
            let bytes = std::fs::read(&path).map_err(|e| format!("{key}: {e}"))?;
            *total += bytes.len() as u64;
            if *total > MAX_BUNDLE_BYTES {
                return Err("the mod is larger than 64 MB".into());
            }
            let entry = match String::from_utf8(bytes) {
                Ok(text) if !text.contains('\0') => FileEntry { text: Some(text), base64: None },
                Ok(text) => FileEntry { text: None, base64: Some(base64::engine::general_purpose::STANDARD.encode(text.as_bytes())) },
                Err(e) => FileEntry { text: None, base64: Some(base64::engine::general_purpose::STANDARD.encode(e.into_bytes())) },
            };
            files.insert(key, entry);
        }
    }
    Ok(())
}

pub fn pack_mod(dir: &Path) -> Result<ModBundle, String> {
    let manifest = mods::read_manifest(dir)?;
    let mut files = BTreeMap::new();
    collect(dir, "", &mut files, &mut 0)?;
    Ok(ModBundle { format: "aicode-mod".into(), version: 1, id: manifest.id, files })
}

/// A relative path made only of plain names.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    if path.is_empty() || path.contains('\\') || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(p.to_path_buf())
}

/// Unpacks a mod into `root/<id>`, replacing what was there. Returns its manifest.
pub fn unpack_mod(bundle: &ModBundle, root: &Path) -> Result<(Manifest, PathBuf), String> {
    let manifest_text = bundle
        .files
        .get("mod.json")
        .and_then(|f| f.text.as_ref())
        .ok_or("the bundle has no mod.json")?;
    let manifest: Manifest = serde_json::from_str(manifest_text).map_err(|e| format!("mod.json: {e}"))?;
    let id = paths::safe_name(&manifest.id).ok_or_else(|| format!("invalid id {:?}", manifest.id))?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = root.join(format!(".{id}.importing"));
    let _ = std::fs::remove_dir_all(&tmp);
    let mut total = 0u64;
    let result = (|| {
        for (path, entry) in &bundle.files {
            let rel = safe_relative(path).ok_or_else(|| format!("unsafe path in bundle: {path:?}"))?;
            let bytes = match (&entry.text, &entry.base64) {
                (Some(t), _) => t.clone().into_bytes(),
                (None, Some(b)) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("{path}: {e}"))?,
                (None, None) => Vec::new(),
            };
            total += bytes.len() as u64;
            if total > MAX_BUNDLE_BYTES {
                return Err("the mod is larger than 64 MB".to_string());
            }
            let dest = tmp.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&dest, bytes).map_err(|e| format!("{path}: {e}"))?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let dest = root.join(&id);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok((manifest, dest))
}

/// A mod from text: an `aicode-mod` bundle, or a mod.json on its own (a declarative mod).
fn install_text(text: &str, root: &Path) -> Result<(Manifest, PathBuf), String> {
    let text = text.trim_start_matches('\u{feff}');
    let value: Value = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
    if value.get("format").and_then(|f| f.as_str()) == Some("aicode-profile") {
        return Err("this is a profile — use Import Profile".into());
    }
    if value.get("format").and_then(|f| f.as_str()) == Some("aicode-mod") {
        let bundle: ModBundle = serde_json::from_value(value).map_err(|e| e.to_string())?;
        return unpack_mod(&bundle, root);
    }
    let manifest: Manifest = serde_json::from_value(value).map_err(|e| format!("not a mod.json: {e}"))?;
    let mut files = BTreeMap::new();
    files.insert("mod.json".to_string(), FileEntry { text: Some(text.to_string()), base64: None });
    let _ = manifest;
    unpack_mod(&ModBundle { format: "aicode-mod".into(), version: 1, id: String::new(), files }, root)
}

fn installed(app: &AppHandle, state: &ModsState, (manifest, dir): (Manifest, PathBuf)) -> Installed {
    mods::refresh(app, state);
    Installed { id: manifest.id, dir: crate::paths::ui(&dir), permissions: manifest.permissions }
}

// ---------- mod commands ----------

/// Installs `.aicode-mod`, or a single mod.json, from a file.
#[tauri::command]
pub fn mod_install_file(app: AppHandle, state: State<'_, ModsState>, path: String, scope: Option<String>) -> Result<Installed, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BUNDLE_BYTES * 2 {
        return Err("the file is too large".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let root = mods::install_root(&state, scope.as_deref());
    let done = install_text(&text, &root)?;
    Ok(installed(&app, &state, done))
}

/// Installs a mod.json (or bundle) given as text — the JSON an AI wrote, pasted into a tab.
#[tauri::command]
pub fn mod_install_json(app: AppHandle, state: State<'_, ModsState>, text: String, scope: Option<String>) -> Result<Installed, String> {
    let root = mods::install_root(&state, scope.as_deref());
    let done = install_text(&text, &root)?;
    Ok(installed(&app, &state, done))
}

/// Writes one installed mod (bundled ones too) to an `.aicode-mod` file.
#[tauri::command]
pub fn mod_export(state: State<'_, ModsState>, id: String, path: String) -> Result<(), String> {
    let dir = {
        let mods = state.mods.lock().unwrap();
        mods.iter().find(|m| m.manifest.id == id).map(|m| PathBuf::from(&m.dir)).ok_or_else(|| format!("{id} is not installed"))?
    };
    let bundle = pack_mod(&dir)?;
    let text = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    crate::fsops::write_atomic(Path::new(&path), text.as_bytes())
}

/// The guide to writing mods, written so a person or any AI can follow it.
#[tauri::command]
pub fn mod_guide() -> &'static str {
    include_str!("../../docs/MOD-GUIDE.md")
}

/// JSON Schema of mod.json.
#[tauri::command]
pub fn mod_schema() -> &'static str {
    include_str!("../../docs/mod.schema.json")
}

// ---------- profiles ----------

/// A profile and the mods that are its own — plus, if asked, the shared mods it has enabled, so
/// it works the same on a machine that does not have them. Bundled mods travel by id only.
pub fn pack_profile(app: &AppHandle, state: &ModsState, name: &str, include_shared: bool) -> Result<ProfileBundle, String> {
    let profile = mods::read_profile(name);
    let all = mods::scan(app, name, &profile);
    let mut bundles = Vec::new();
    for m in &all {
        let take = match m.source {
            "profile" => true,
            "shared" => include_shared && profile.enabled.contains(&m.manifest.id),
            _ => false,
        };
        if take {
            bundles.push(pack_mod(Path::new(&m.dir))?);
        }
    }
    let _ = state;
    Ok(ProfileBundle {
        format: "aicode-profile".into(),
        version: 1,
        name: name.to_string(),
        exported_by: format!("AICode {}", env!("CARGO_PKG_VERSION")),
        profile,
        mods: bundles,
    })
}

fn unique_name(wanted: &str) -> String {
    let base: String = wanted.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' }).collect();
    let base = base.trim_start_matches('.').chars().take(80).collect::<String>();
    let base = if base.is_empty() { "imported".to_string() } else { base };
    let existing = mods::profile_names();
    if !existing.contains(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|n| !existing.contains(n)).unwrap()
}

#[derive(Serialize)]
pub struct ImportedProfile {
    pub name: String,
    pub mods: Vec<String>,
    /// Enabled in the profile, but neither bundled with AICode nor inside the file.
    pub missing: Vec<String>,
}

pub fn unpack_profile(app: &AppHandle, text: &str, rename: Option<String>) -> Result<ImportedProfile, String> {
    let bundle: ProfileBundle = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("not an AICode profile: {e}"))?;
    if bundle.format != "aicode-profile" {
        return Err("not an AICode profile".into());
    }
    if bundle.version > 1 {
        return Err(format!("made by a newer AICode (profile format {})", bundle.version));
    }
    let name = unique_name(rename.as_deref().unwrap_or(&bundle.name));
    let mods_dir = mods::profile_mods_dir(&name);
    let mut ids = Vec::new();
    let result = (|| {
        std::fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;
        for m in &bundle.mods {
            let (manifest, _) = unpack_mod(m, &mods_dir)?;
            ids.push(manifest.id);
        }
        mods::write_profile(&name, &bundle.profile)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(mods::profile_dir(&name));
        return Err(e);
    }
    let found: Vec<String> = mods::scan(app, &name, &bundle.profile).into_iter().map(|m| m.manifest.id).collect();
    let missing = bundle.profile.enabled.iter().filter(|id| !found.contains(id)).cloned().collect();
    Ok(ImportedProfile { name, mods: ids, missing })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_paths() {
        assert!(safe_relative("main.js").is_some());
        assert!(safe_relative("vendor/x.mjs").is_some());
        assert!(safe_relative("../evil").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("a/../../b").is_none());
        assert!(safe_relative("").is_none());
        assert!(safe_relative("a\\..\\b").is_none());
    }

    #[test]
    fn single_json_and_bundle_round_trip() {
        let root = std::env::temp_dir().join(format!("aicode-bundle-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let json = r#"{ "id": "me.hello", "name": "Hello", "version": "1.0.0", "contributes": { "commands": [{ "id": "hello.say", "title": "Say hello", "run": { "type": "notify", "message": "hi" } }] } }"#;
        let (m, dir) = install_text(json, &root).unwrap();
        assert_eq!(m.id, "me.hello");
        std::fs::write(dir.join("logo.png"), [0u8, 159, 146, 150]).unwrap();
        let bundle = pack_mod(&dir).unwrap();
        assert!(bundle.files["logo.png"].base64.is_some());
        let text = serde_json::to_string(&bundle).unwrap();
        let other = root.join("other");
        let (m2, dir2) = install_text(&text, &other).unwrap();
        assert_eq!(m2.id, "me.hello");
        assert_eq!(std::fs::read(dir2.join("logo.png")).unwrap(), vec![0u8, 159, 146, 150]);
        let evil = r#"{ "format": "aicode-mod", "version": 1, "id": "x", "files": { "mod.json": { "text": "{\"id\":\"x.y\",\"name\":\"x\",\"version\":\"1\"}" }, "../../escape.txt": { "text": "no" } } }"#;
        assert!(install_text(evil, &other).is_err());
        assert!(!other.join("x.y").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
