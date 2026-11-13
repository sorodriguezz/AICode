//! The app's menu bar. Most items are command ids sent to the window in front (see `on_event`);
//! the parts that change (Open Recent, the profiles, the Auto Save check) are rebuilt with
//! [`refresh`] whenever what they show changes.

use std::path::Path;
use std::sync::Mutex;

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{fsops, mods, paths, profiles, windows};

/// Ids of items handled here rather than by a window: `recent:<path>`, `profile:<name>`.
const RECENT: &str = "recent:";
const PROFILE: &str = "profile:";
const MAX_RECENT: usize = 20;
const SHOWN_RECENT: usize = 10;

// ---------- what the window in front has open (items that do nothing are off, as in VS Code) ----------

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
pub struct Context {
    /// A folder is open (Close Folder, Duplicate Window).
    pub folder: bool,
    /// Any editor is open (Close Editor).
    pub editor: bool,
    /// The active editor is text (Save, Save As).
    pub text: bool,
    /// The active editor is a file on disk (Revert File).
    pub file: bool,
    /// Some text has unsaved changes (Save All).
    pub dirty: bool,
}

static CONTEXT: Mutex<Context> = Mutex::new(Context { folder: false, editor: false, text: false, file: false, dirty: false });

/// The window reports what it has open when that changes and when it comes to the front.
#[tauri::command]
pub fn menu_context(app: AppHandle, window: tauri::Window, context: Context) {
    // Only the window in front decides (a background window's change must not repaint the menu).
    if !window.is_focused().unwrap_or(false) && windows::front_label(&app).as_deref() != Some(window.label()) {
        return;
    }
    {
        let mut current = CONTEXT.lock().unwrap();
        if *current == context {
            return;
        }
        *current = context;
    }
    refresh(&app);
}

// ---------- the recent list (folders and files opened from AICode, newest first) ----------

fn recent_file() -> std::path::PathBuf {
    paths::state().join("recent.json")
}

pub fn recent_list() -> Vec<String> {
    std::fs::read_to_string(recent_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn recent_add(app: &AppHandle, path: String) {
    let mut list = recent_list();
    if list.first() == Some(&path) {
        return;
    }
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(MAX_RECENT);
    let _ = fsops::write_atomic(&recent_file(), serde_json::to_string(&list).unwrap_or_default().as_bytes());
    refresh(app);
}

pub fn recent_clear(app: &AppHandle) {
    let _ = std::fs::remove_file(recent_file());
    refresh(app);
}

// ---------- building ----------

fn home_relative(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&home) => format!("~{}", &path[home.len()..]),
        _ => path.to_string(),
    }
}

fn auto_save_on(app: &AppHandle) -> bool {
    let state = app.state::<mods::ModsState>();
    mods::effective_core_setting(&state, "files.autoSave").and_then(|v| v.as_str().map(String::from)).is_some_and(|v| v != "off")
}

fn open_recent(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let item = |id: &str, text: &str| MenuItemBuilder::with_id(id, text).build(app);
    let (mut folders, mut files) = (Vec::new(), Vec::new());
    for p in recent_list() {
        match std::fs::metadata(&p) {
            Ok(m) if m.is_dir() => folders.push(p),
            Ok(_) => files.push(p),
            Err(_) => {} // gone from disk: not offered
        }
    }
    let mut b = SubmenuBuilder::new(app, "Open Recent").item(&item("workbench.reopenLastSession", "Reopen Last Session")?);
    for group in [&folders, &files] {
        if group.is_empty() {
            continue;
        }
        b = b.separator();
        for p in group.iter().take(SHOWN_RECENT) {
            b = b.item(&item(&format!("{RECENT}{p}"), &home_relative(p))?);
        }
    }
    let clear = MenuItemBuilder::with_id("workbench.clearRecentlyOpened", "Clear Recently Opened").enabled(!folders.is_empty() || !files.is_empty()).build(app)?;
    b.separator().item(&clear).build()
}

fn switch_profile(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let state = app.state::<mods::ModsState>();
    let active = state.profile_name.lock().unwrap().clone();
    let mut names = mods::profile_names();
    if !names.contains(&active) {
        names.push(active.clone());
        names.sort();
    }
    let mut b = SubmenuBuilder::new(app, "Switch Profile");
    for name in &names {
        b = b.item(&CheckMenuItemBuilder::with_id(format!("{PROFILE}{name}"), name).checked(*name == active).build(app)?);
    }
    b.separator()
        .item(&MenuItemBuilder::with_id("profiles.create", "New Profile…").build(app)?)
        .item(&MenuItemBuilder::with_id("profiles.manage", "Manage Profiles…").build(app)?)
        .build()
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let ctx = *CONTEXT.lock().unwrap();
    let item_if = |id: &str, text: &str, accel: Option<&str>, enabled: bool| {
        let mut b = MenuItemBuilder::with_id(id, text).enabled(enabled);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let item = |id: &str, text: &str, accel: Option<&str>| item_if(id, text, accel, true);
    let app_menu = SubmenuBuilder::new(app, "AICode")
        .about(None)
        .item(&item("update.check", "Check for Updates…", None)?)
        .separator()
        .item(&item("preferences.settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .item(&item("profiles.manage", "Profiles…", None)?)
        .item(&item("mods.manage", "Mods…", Some("CmdOrCtrl+Shift+X"))?)
        .item(&item("preferences.theme", "Color Theme…", None)?)
        .item(&item("workbench.keybindings", "Keyboard Shortcuts", None)?)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    // Laid out like VS Code's File menu. AICode has one folder per window (no multi-root
    // workspaces), so "Duplicate Workspace" is "Duplicate Window", and profiles are app-wide, so
    // "New Window with Profile" is "Switch Profile".
    let share = SubmenuBuilder::new(app, "Share").item(&item("profiles.export", "Export Profile…", None)?).build()?;
    let auto_save = CheckMenuItemBuilder::with_id("files.toggleAutoSave", "Auto Save").checked(auto_save_on(app)).build(app)?;
    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("file.new", "New Text File", Some("CmdOrCtrl+N"))?)
        .item(&item("file.newFile", "New File…", Some("Ctrl+Alt+CmdOrCtrl+N"))?)
        .item(&item("workbench.newWindow", "New Window", Some("CmdOrCtrl+Shift+N"))?)
        .item(&switch_profile(app)?)
        .separator()
        .item(&item("file.open", "Open File…", Some("CmdOrCtrl+O"))?)
        .item(&item("workbench.openFolder", "Open Folder…", None)?)
        .item(&item("workbench.openFolderNewWindow", "Open Folder in New Window…", None)?)
        .item(&open_recent(app)?)
        .separator()
        .item(&item_if("workbench.duplicateWindow", "Duplicate Window", None, ctx.folder)?)
        .separator()
        .item(&item_if("file.save", "Save", Some("CmdOrCtrl+S"), ctx.text)?)
        .item(&item_if("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"), ctx.text)?)
        .item(&item_if("file.saveAll", "Save All", Some("CmdOrCtrl+Alt+S"), ctx.dirty)?)
        .separator()
        .item(&share)
        .separator()
        .item(&auto_save)
        .separator()
        .item(&item_if("file.revert", "Revert File", None, ctx.file)?)
        .item(&item_if("editor.close", "Close Editor", Some("CmdOrCtrl+W"), ctx.editor)?);
    // Only with a folder open, as in VS Code. A chord (⌘K F) cannot be a menu accelerator: the
    // window binds it and the title shows it.
    if ctx.folder {
        file = file.item(&item("workbench.closeFolder", "Close Folder [⌘K F]", None)?);
    }
    let file = file.item(&item("window.close", "Close Window", Some("CmdOrCtrl+Shift+W"))?).build()?;
    // Undo/Redo are the editor's own (Monaco keeps the undo stack), so they are plain items routed
    // to the window; Cut/Copy/Paste/Select All stay the system's, which is what makes the clipboard
    // work inside the web view.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("edit.undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item("edit.redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("edit.find", "Find", Some("CmdOrCtrl+F"))?)
        .item(&item("edit.replace", "Replace", Some("CmdOrCtrl+Alt+F"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("workbench.commandPalette", "Command Palette…", Some("CmdOrCtrl+Shift+P"))?)
        .item(&item("workbench.quickOpen", "Go to File…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("workbench.toggleSidebar", "Toggle Primary Side Bar", Some("CmdOrCtrl+B"))?)
        .item(&item("workbench.togglePanel", "Toggle Panel", Some("CmdOrCtrl+J"))?)
        .item(&item("workbench.toggleSecondary", "Toggle Secondary Side Bar", Some("CmdOrCtrl+Alt+B"))?)
        .separator()
        .item(&item("editor.zoomIn", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("editor.zoomOut", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("editor.zoomReset", "Reset Zoom", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&item("workbench.reload", "Reload Window", Some("CmdOrCtrl+R"))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().fullscreen().build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
}

/// Rebuilds the menu bar (the recent list, the profiles or Auto Save changed).
pub fn refresh(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || match build(&app2) {
        Ok(menu) => {
            let _ = app2.set_menu(menu);
        }
        Err(e) => eprintln!("[aicode] could not rebuild the menu: {e}"),
    });
}

/// A menu item was picked.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().0.as_str();
    if let Some(path) = id.strip_prefix(RECENT) {
        // Like a path dropped on the Dock icon: a folder goes to the window in front if it has
        // none (else to a window of its own), a file opens in it.
        if Path::new(path).exists() {
            windows::open_in_front(app, vec![path.to_string()]);
        }
        return;
    }
    if let Some(name) = id.strip_prefix(PROFILE) {
        let app2 = app.clone();
        let name = name.to_string();
        // Off the menu's own tracking, as the Dock menu does: switching closes and reopens windows.
        std::thread::spawn(move || {
            if let Err(e) = profiles::switch_to(&app2, &name) {
                eprintln!("[aicode] could not switch profile: {e}");
            }
            // Picking the profile already on unticks its item: put the ticks back.
            refresh(&app2);
        });
        return;
    }
    if let Some(label) = windows::front_label(app) {
        let _ = app.emit_to(label.as_str(), "menu", id.to_string());
    }
}
