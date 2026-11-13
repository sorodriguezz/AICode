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

use std::path::{Path, PathBuf};

/// A path as the window and mods see it. On Windows that is `C:/Users/me/file.txt`: `/` like
/// everywhere else (Windows takes it as well as `\`), the drive letter in capitals and no `\\?\`
/// prefix, so the window can split, join and compare paths the same way on every system.
pub fn ui(path: impl AsRef<Path>) -> String {
    let text = path.as_ref().to_string_lossy();
    if cfg!(windows) {
        ui_windows(&text)
    } else {
        text.into_owned()
    }
}

fn ui_windows(text: &str) -> String {
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text).to_string()
    };
    let mut out = text.replace('\\', "/");
    if out.len() >= 2 && out.as_bytes()[1] == b':' && out.as_bytes()[0].is_ascii_lowercase() {
        out[..1].make_ascii_uppercase();
    }
    out
}

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

#[cfg(test)]
mod tests {
    #[test]
    fn windows_paths_for_the_window() {
        assert_eq!(super::ui_windows(r"c:\Users\me\a.txt"), "C:/Users/me/a.txt");
        assert_eq!(super::ui_windows(r"\\?\C:\Users\me"), "C:/Users/me");
        assert_eq!(super::ui_windows(r"\\?\UNC\server\share\x"), "//server/share/x");
        assert_eq!(super::ui_windows("C:/already/fine"), "C:/already/fine");
    }
}
