//! The system's password store: the Keychain on macOS, the Credential Manager on Windows and the
//! Secret Service (GNOME Keyring, KWallet) on Linux. A secret is found by its service and key.
//! Plain functions, without Tauri, so this file builds on its own for other targets.

/// The secret, or `None` when there is none under this service and key.
pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
    imp::get(service, key)
}

pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
    imp::set(service, key, value)
}

/// Removing a secret that is not there is not an error.
pub fn delete(service: &str, key: &str) -> Result<(), String> {
    imp::delete(service, key)
}

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords;

    const NOT_FOUND: i32 = -25300; // errSecItemNotFound

    pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
        match passwords::get_generic_password(service, key) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        passwords::set_generic_password(service, key, value.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        match passwords::delete_generic_password(service, key) {
            Err(e) if e.code() != NOT_FOUND => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
mod imp {
    use keyring::{Entry, Error};

    fn entry(service: &str, key: &str) -> Result<Entry, String> {
        Entry::new(service, key).map_err(describe)
    }

    fn describe(e: Error) -> String {
        match e {
            Error::NoStorageAccess(_) | Error::PlatformFailure(_) if cfg!(target_os = "linux") => {
                format!("the system's password store could not be used (is GNOME Keyring or KWallet running?): {e}")
            }
            other => other.to_string(),
        }
    }

    pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
        match entry(service, key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        entry(service, key)?.set_password(value).map_err(describe)
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        match entry(service, key)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(e)),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod imp {
    const NONE: &str = "secrets are not available on this system";
    pub fn get(_: &str, _: &str) -> Result<Option<String>, String> {
        Err(NONE.into())
    }
    pub fn set(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
}
