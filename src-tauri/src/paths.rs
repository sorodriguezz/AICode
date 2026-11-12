//! Where AICode keeps what it knows, all under one folder per user:
//!
//! ```text
//! ~/Library/Application Support/AICode/   (macOS; the platform data dir elsewhere)
//! ├── mods/        mods the user installed, one folder per mod id
//! ├── profiles/    one JSON per profile: which mods are on and their settings
//! └── state/       session (open tabs, unsaved text), the MCP token, the active profile
//! ```
//!
//! `AICODE_HOME` overrides the root, so a test or a second "portable" copy never touches the real one.

use std::path::PathBuf;

pub fn root() -> PathBuf {
    if let Some(home) = std::env::var_os("AICODE_HOME") {
        return PathBuf::from(home);
    }
    dirs::data_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AICode")
}

pub fn user_mods() -> PathBuf {
    root().join("mods")
}

pub fn profiles() -> PathBuf {
    root().join("profiles")
}

pub fn state() -> PathBuf {
    root().join("state")
}

pub fn ensure() {
    for dir in [user_mods(), profiles(), state()] {
        let _ = std::fs::create_dir_all(dir);
    }
}

/// A file name that is safe to put inside one of our folders: letters, digits, `.`, `-`, `_`.
pub fn safe_name(name: &str) -> Option<String> {
    let ok = !name.is_empty()
        && name.len() <= 96
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    ok.then(|| name.to_string())
}
