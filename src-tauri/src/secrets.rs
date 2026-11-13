//! Secrets for mods (passwords, tokens, connection strings) in the macOS Keychain. Each mod gets its
//! own service, "AICode: <mod id>", unless it names one (to share a secret with another tool).

use tauri::State;

use crate::mods::{require, ModsState};

fn service(mod_id: &str, service: Option<String>) -> String {
    service.filter(|s| !s.is_empty()).unwrap_or_else(|| format!("AICode: {mod_id}"))
}

#[cfg(target_os = "macos")]
const NOT_FOUND: i32 = -25300; // errSecItemNotFound

#[tauri::command]
pub fn secret_get(mods: State<'_, ModsState>, mod_id: String, key: String, service: Option<String>) -> Result<Option<String>, String> {
    require(&mods, &mod_id, "secrets")?;
    #[cfg(target_os = "macos")]
    {
        match security_framework::passwords::get_generic_password(&self::service(&mod_id, service), &key) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (key, service);
        Err("secrets are only available on macOS".into())
    }
}

#[tauri::command]
pub fn secret_set(mods: State<'_, ModsState>, mod_id: String, key: String, value: String, service: Option<String>) -> Result<(), String> {
    require(&mods, &mod_id, "secrets")?;
    #[cfg(target_os = "macos")]
    {
        security_framework::passwords::set_generic_password(&self::service(&mod_id, service), &key, value.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (key, value, service);
        Err("secrets are only available on macOS".into())
    }
}

#[tauri::command]
pub fn secret_delete(mods: State<'_, ModsState>, mod_id: String, key: String, service: Option<String>) -> Result<(), String> {
    require(&mods, &mod_id, "secrets")?;
    #[cfg(target_os = "macos")]
    {
        match security_framework::passwords::delete_generic_password(&self::service(&mod_id, service), &key) {
            Err(e) if e.code() != NOT_FOUND => Err(e.to_string()),
            _ => Ok(()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (key, service);
        Err("secrets are only available on macOS".into())
    }
}
