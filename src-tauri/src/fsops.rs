//! Files: what the editor and the mods read and write. Every command names the mod asking, and the
//! mod must have declared `fs:read` / `fs:write`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::mods::{require, ModsState};

/// Files bigger than this are not opened as text.
const MAX_TEXT: u64 = 64 * 1024 * 1024;

/// Writes through a temporary file next to the target and a rename, so a crash or a full disk never
/// leaves half a file behind. Keeps the target's permissions.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().ok_or("no file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.aicode-{}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Serialize)]
pub struct TextFile {
    text: String,
    /// The file had a UTF-8 byte order mark (kept on save).
    bom: bool,
    /// The bytes were not valid UTF-8; `text` replaced what could not be read.
    lossy: bool,
    binary: bool,
    size: u64,
    /// "\r\n" or "\n": what the file mostly uses.
    eol: &'static str,
}

/// A file as a `data:` URL (images for backgrounds, fonts for custom CSS), up to 40 MB. `~` works.
#[tauri::command]
pub fn fs_read_data_url(state: State<'_, ModsState>, mod_id: String, path: String) -> Result<String, String> {
    use base64::Engine;
    require(&state, &mod_id, "fs:read")?;
    let path = match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest).to_string_lossy().into_owned()).unwrap_or(path),
        None => path,
    };
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder"));
    }
    if meta.len() > 40 * 1024 * 1024 {
        return Err(format!("{path} is larger than 40 MB"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "css" => "text/css",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn fs_read_text(state: State<'_, ModsState>, mod_id: String, path: String) -> Result<TextFile, String> {
    require(&state, &mod_id, "fs:read")?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder"));
    }
    if meta.len() > MAX_TEXT {
        return Ok(TextFile { text: String::new(), bom: false, lossy: false, binary: true, size: meta.len(), eol: "\n" });
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let sniff = &bytes[..bytes.len().min(8192)];
    if sniff.contains(&0) {
        return Ok(TextFile { text: String::new(), bom: false, lossy: false, binary: true, size: meta.len(), eol: "\n" });
    }
    let (bom, body) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (true, rest),
        None => (false, &bytes[..]),
    };
    let (text, lossy) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(body).into_owned(), true),
    };
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let eol = if crlf > 0 && crlf * 2 >= lf { "\r\n" } else { "\n" };
    Ok(TextFile { text, bom, lossy, binary: false, size: meta.len(), eol })
}

#[tauri::command]
pub fn fs_write_text(
    state: State<'_, ModsState>,
    mod_id: String,
    path: String,
    text: String,
    bom: Option<bool>,
) -> Result<(), String> {
    require(&state, &mod_id, "fs:write")?;
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom.unwrap_or(false) {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(text.as_bytes());
    write_atomic(Path::new(&path), &bytes)
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
}

#[tauri::command]
pub fn fs_read_dir(state: State<'_, ModsState>, mod_id: String, path: String) -> Result<Vec<DirEntry>, String> {
    require(&state, &mod_id, "fs:read")?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        let file_type = entry.file_type().ok();
        let is_symlink = file_type.map(|t| t.is_symlink()).unwrap_or(false);
        // A symlink to a folder opens like a folder.
        let is_dir = std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false);
        out.push(DirEntry { name, path: crate::paths::ui(entry.path()), is_dir, is_symlink });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize)]
pub struct Stat {
    exists: bool,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

#[tauri::command]
pub fn fs_stat(state: State<'_, ModsState>, mod_id: String, path: String) -> Result<Stat, String> {
    require(&state, &mod_id, "fs:read")?;
    Ok(match std::fs::metadata(&path) {
        Ok(m) => Stat {
            exists: true,
            is_dir: m.is_dir(),
            size: m.len(),
            modified_ms: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        },
        Err(_) => Stat { exists: false, is_dir: false, size: 0, modified_ms: 0 },
    })
}

#[tauri::command]
pub fn fs_create(state: State<'_, ModsState>, mod_id: String, path: String, dir: bool) -> Result<(), String> {
    require(&state, &mod_id, "fs:write")?;
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    if dir {
        std::fs::create_dir_all(&p).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::File::create(&p).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn fs_rename(state: State<'_, ModsState>, mod_id: String, from: String, to: String) -> Result<(), String> {
    require(&state, &mod_id, "fs:write")?;
    // On a case-insensitive disk "a.txt" → "A.txt" finds the file itself at the new name.
    let same_file = from.to_lowercase() == to.to_lowercase() && from != to;
    if Path::new(&to).exists() && !same_file {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Deletes a file or a folder: to the Trash (or Recycle Bin) unless `trash` is false.
#[tauri::command]
pub fn fs_delete(state: State<'_, ModsState>, mod_id: String, path: String, trash: Option<bool>) -> Result<(), String> {
    require(&state, &mod_id, "fs:write")?;
    let p = Path::new(&path);
    if p.parent().is_none() || path.trim().is_empty() {
        return Err("refusing to delete a root folder".into());
    }
    if trash.unwrap_or(true) {
        return ::trash::delete(p).map_err(|e| format!("could not move {} to the Trash: {e}", p.display()));
    }
    let meta = std::fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(|e| e.to_string())
}

fn copy_any(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(from)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, to);
        #[cfg(not(unix))]
        return std::fs::copy(from, to).map(|_| ()).map_err(|e| { let _ = target; e });
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_any(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Copies a file or a folder (with everything in it) to a path that must not exist yet.
#[tauri::command]
pub fn fs_copy(state: State<'_, ModsState>, mod_id: String, from: String, to: String) -> Result<(), String> {
    require(&state, &mod_id, "fs:read")?;
    require(&state, &mod_id, "fs:write")?;
    let (src, dst) = (Path::new(&from), Path::new(&to));
    if dst.exists() {
        return Err(format!("{to} already exists"));
    }
    if dst.starts_with(src) {
        return Err("cannot copy a folder into itself".into());
    }
    copy_any(src, dst).map_err(|e| e.to_string())
}

/// Shows a file in Finder / Explorer / the file manager, selected.
#[tauri::command]
pub fn fs_reveal(state: State<'_, ModsState>, mod_id: String, path: String) -> Result<(), String> {
    require(&state, &mod_id, "fs:read")?;
    let mut cmd;
    #[cfg(target_os = "macos")]
    {
        cmd = std::process::Command::new("open");
        cmd.arg("-R").arg(&path);
    }
    #[cfg(target_os = "windows")]
    {
        // Explorer reads `/` as the start of an option: the path goes with `\`.
        use std::os::windows::process::CommandExt;
        cmd = std::process::Command::new("explorer");
        cmd.raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        cmd = std::process::Command::new("xdg-open");
        let p = Path::new(&path);
        cmd.arg(if p.is_dir() { p } else { p.parent().unwrap_or(p) });
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Folders being watched (not recursively): each change in one is sent to every window as
/// `fs://change { dir }`, at most every 150 ms per folder.
#[derive(Default)]
pub struct WatchState {
    inner: std::sync::Mutex<Option<WatchInner>>,
}

struct WatchInner {
    watcher: notify::RecommendedWatcher,
    /// folder → how many watch() calls hold it
    dirs: std::collections::HashMap<PathBuf, usize>,
    ids: std::collections::HashMap<u64, PathBuf>,
    next: u64,
}

#[tauri::command]
pub fn fs_watch(app: tauri::AppHandle, state: State<'_, ModsState>, watch: State<'_, WatchState>, mod_id: String, path: String) -> Result<u64, String> {
    use notify::Watcher;
    require(&state, &mod_id, "fs:read")?;
    let mut guard = watch.inner.lock().unwrap();
    if guard.is_none() {
        let pending = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::<PathBuf>::new()));
        let flush = pending.clone();
        let emitter = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let dirs: Vec<PathBuf> = flush.lock().unwrap().drain().collect();
            for dir in dirs {
                use tauri::Emitter;
                let _ = emitter.emit("fs://change", serde_json::json!({ "dir": crate::paths::ui(&dir) }));
            }
        });
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let mut set = pending.lock().unwrap();
                for p in event.paths {
                    if let Some(parent) = p.parent() {
                        set.insert(parent.to_path_buf());
                    }
                    set.insert(p);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        *guard = Some(WatchInner { watcher, dirs: Default::default(), ids: Default::default(), next: 1 });
    }
    let inner = guard.as_mut().unwrap();
    let dir = PathBuf::from(&path);
    let count = inner.dirs.entry(dir.clone()).or_insert(0);
    if *count == 0 {
        inner.watcher.watch(&dir, notify::RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    }
    *count += 1;
    let id = inner.next;
    inner.next += 1;
    inner.ids.insert(id, dir);
    Ok(id)
}

#[tauri::command]
pub fn fs_unwatch(watch: State<'_, WatchState>, id: u64) {
    use notify::Watcher;
    let mut guard = watch.inner.lock().unwrap();
    let Some(inner) = guard.as_mut() else { return };
    let Some(dir) = inner.ids.remove(&id) else { return };
    if let Some(count) = inner.dirs.get_mut(&dir) {
        *count -= 1;
        if *count == 0 {
            inner.dirs.remove(&dir);
            let _ = inner.watcher.unwatch(&dir);
        }
    }
}

/// What a search looks at: "files to include" / "files to exclude" (comma-separated globs, VS
/// Code style: `src`, `*.ts`, `src/**/test`), and whether .gitignore and the usual heavy folders
/// are skipped.
struct SearchFilter {
    overrides: Option<ignore::overrides::Override>,
    use_ignore: bool,
}

/// `src` → `src`, `src/**` (and anywhere below when it has no slash); `*.ts` → `**/*.ts`.
fn expand_glob(raw: &str) -> Vec<String> {
    let p = raw.trim().trim_start_matches("./").trim_end_matches('/');
    if p.is_empty() {
        return vec![];
    }
    let anchored = p.starts_with('/') || p.starts_with("**");
    let p = p.trim_start_matches('/');
    let base = if anchored || p.contains('/') { p.to_string() } else { format!("**/{p}") };
    if base.ends_with("/**") {
        vec![base]
    } else {
        vec![base.clone(), format!("{base}/**")]
    }
}

impl SearchFilter {
    fn new(root: &str, include: Option<&str>, exclude: Option<&str>, use_ignore: bool) -> Result<Self, String> {
        let includes: Vec<String> = include.unwrap_or("").split(',').flat_map(expand_glob).collect();
        let excludes: Vec<String> = exclude.unwrap_or("").split(',').flat_map(expand_glob).collect();
        if includes.is_empty() && excludes.is_empty() {
            return Ok(SearchFilter { overrides: None, use_ignore });
        }
        let mut b = ignore::overrides::OverrideBuilder::new(root);
        for g in &includes {
            b.add(g).map_err(|e| format!("files to include: {e}"))?;
        }
        for g in &excludes {
            b.add(&format!("!{g}")).map_err(|e| format!("files to exclude: {e}"))?;
        }
        Ok(SearchFilter { overrides: Some(b.build().map_err(|e| e.to_string())?), use_ignore })
    }

    fn walk(&self, root: &str) -> ignore::Walk {
        let mut b = ignore::WalkBuilder::new(root);
        let skip_heavy = self.use_ignore;
        b.hidden(false)
            .git_ignore(self.use_ignore)
            .git_global(self.use_ignore)
            .git_exclude(self.use_ignore)
            .ignore(self.use_ignore)
            .parents(self.use_ignore)
            .require_git(false)
            .filter_entry(move |e| {
                let name = e.file_name();
                name != ".git" && name != ".DS_Store" && !(skip_heavy && (name == "node_modules" || name == "target"))
            });
        if let Some(o) = &self.overrides {
            b.overrides(o.clone());
        }
        b.build()
    }
}

fn walker(root: &str) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| {
            let name = e.file_name();
            name != ".git" && name != "node_modules" && name != ".DS_Store" && name != "target"
        })
        .build()
}

/// Every file under `root` that `.gitignore` does not hide, relative to it, up to `limit`.
#[tauri::command]
pub async fn fs_list_files(
    state: State<'_, ModsState>,
    mod_id: String,
    root: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    require(&state, &mod_id, "fs:read")?;
    let limit = limit.unwrap_or(20_000);
    let base = PathBuf::from(&root);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in walker(&root).flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Ok(rel) = entry.path().strip_prefix(&base) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
                if out.len() >= limit {
                    break;
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct SearchHit {
    path: String,
    line: usize,
    column: usize,
    length: usize,
    text: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    hits: Vec<SearchHit>,
    files_searched: usize,
    truncated: bool,
}

/// Text search under `root`, the way the Search view asks for it.
#[tauri::command]
pub async fn fs_search(
    state: State<'_, ModsState>,
    mod_id: String,
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    max_results: Option<usize>,
    include: Option<String>,
    exclude: Option<String>,
    use_ignore: Option<bool>,
    paths: Option<Vec<String>>,
) -> Result<SearchResult, String> {
    require(&state, &mod_id, "fs:read")?;
    let filter = SearchFilter::new(&root, include.as_deref(), exclude.as_deref(), use_ignore.unwrap_or(true))?;
    if query.is_empty() {
        return Ok(SearchResult { hits: vec![], files_searched: 0, truncated: false });
    }
    let mut pattern = if regex { query.clone() } else { regex::escape(&query) };
    if whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    let max = max_results.unwrap_or(2_000);
    tauri::async_runtime::spawn_blocking(move || {
        let mut hits = Vec::new();
        let mut files_searched = 0;
        let mut truncated = false;
        // Only some files (the open editors), or every file the filter lets through.
        let files: Box<dyn Iterator<Item = PathBuf>> = match paths {
            Some(list) => Box::new(list.into_iter().map(PathBuf::from).filter(|p| p.is_file())),
            None => Box::new(filter.walk(&root).flatten().filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).map(|e| e.into_path())),
        };
        'files: for path in files {
            if std::fs::metadata(&path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if bytes[..bytes.len().min(8192)].contains(&0) {
                continue;
            }
            let Ok(text) = std::str::from_utf8(&bytes) else { continue };
            files_searched += 1;
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    let column = line[..m.start()].chars().count();
                    let preview: String = line.chars().take(400).collect();
                    hits.push(SearchHit {
                        path: crate::paths::ui(&path),
                        line: i + 1,
                        column: column + 1,
                        length: m.as_str().chars().count(),
                        text: preview,
                    });
                    if hits.len() >= max {
                        truncated = true;
                        break 'files;
                    }
                }
            }
        }
        SearchResult { hits, files_searched, truncated }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn home_dir() -> String {
    dirs::home_dir().map(crate::paths::ui).unwrap_or_default()
}

/// A folder of the mod's own for what it downloads or builds up (models, binaries, caches):
/// `AICode/data/<mod id>/`, created on first use. It outlives updates of the mod and is shared by
/// every profile. Needs no permission: it is the mod's own place.
#[tauri::command]
pub fn mod_data_dir(mod_id: String) -> Result<String, String> {
    let id = crate::paths::safe_name(&mod_id).ok_or_else(|| format!("not a mod id: {mod_id}"))?;
    let dir = crate::paths::root().join("data").join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(crate::paths::ui(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_keeps_no_temp() {
        let dir = std::env::temp_dir().join(format!("aicode-test-{}", std::process::id()));
        let file = dir.join("a.txt");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn globs_expand_like_vscode() {
        assert_eq!(expand_glob("src"), vec!["**/src", "**/src/**"]);
        assert_eq!(expand_glob("src/core/"), vec!["src/core", "src/core/**"]);
        assert_eq!(expand_glob("*.ts"), vec!["**/*.ts", "**/*.ts/**"]);
        assert_eq!(expand_glob("**/test/**"), vec!["**/test/**"]);
        assert!(expand_glob("  ").is_empty());
    }

    #[test]
    fn include_and_exclude_filter_the_walk() {
        let dir = std::env::temp_dir().join(format!("aicode-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/core")).unwrap();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        for f in ["src/a.ts", "src/core/b.ts", "src/core/c.md", "docs/d.ts"] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        let root = dir.to_string_lossy().to_string();
        let files = |inc: Option<&str>, exc: Option<&str>| {
            let f = SearchFilter::new(&root, inc, exc, true).unwrap();
            let mut v: Vec<String> = f
                .walk(&root)
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| e.path().strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/"))
                .collect();
            v.sort();
            v
        };
        assert_eq!(files(Some("src"), None), vec!["src/a.ts", "src/core/b.ts", "src/core/c.md"]);
        assert_eq!(files(Some("*.ts"), Some("core")), vec!["docs/d.ts", "src/a.ts"]);
        assert_eq!(files(None, Some("docs, *.md")), vec!["src/a.ts", "src/core/b.ts"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
