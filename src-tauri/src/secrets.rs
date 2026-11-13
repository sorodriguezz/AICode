//! Secrets for mods (passwords, tokens, connection strings) in the system's password store (see
//! keystore.rs). Each mod gets its own service, "AICode: <mod id>", unless it names one (to share
//! a secret with another tool).

use tauri::State;

use crate::keystore;
use crate::mods::{require, ModsState};

fn service(mod_id: &str, service: Option<String>) -> String {
    service.filter(|s| !s.is_empty()).unwrap_or_else(|| format!("AICode: {mod_id}"))
}

#[tauri::command]
pub fn secret_get(mods: State<'_, ModsState>, mod_id: String, key: String, service: Option<String>) -> Result<Option<String>, String> {
    require(&mods, &mod_id, "secrets")?;
    keystore::get(&self::service(&mod_id, service), &key)
}

#[tauri::command]
pub fn secret_set(mods: State<'_, ModsState>, mod_id: String, key: String, value: String, service: Option<String>) -> Result<(), String> {
    require(&mods, &mod_id, "secrets")?;
    keystore::set(&self::service(&mod_id, service), &key, &value)
}

#[tauri::command]
pub fn secret_delete(mods: State<'_, ModsState>, mod_id: String, key: String, service: Option<String>) -> Result<(), String> {
    require(&mods, &mod_id, "secrets")?;
    keystore::delete(&self::service(&mod_id, service), &key)
}
