//! The app's menu bar. Most items are command ids sent to the window in front (see `on_event`);
//! the parts that change (Open Recent, the profiles, the Auto Save check) are rebuilt with
//! [`refresh`] whenever what they show changes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuEvent, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{fsops, mods, paths, profiles, windows};

/// Ids of items handled here rather than by a window: `recent:<path>`, `profile:<name>`.
const RECENT: &str = "recent:";
const PROFILE: &str = "profile:";
const MAX_RECENT: usize = 20;
const SHOWN_RECENT: usize = 10;

// ---------- what the window in front has open (items that do nothing are off, as in VS Code) ----------

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default)]
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
    pub sidebar: bool,
    pub panel: bool,
    pub secondary: bool,
}

static CONTEXT: Mutex<Context> = Mutex::new(Context { folder: false, editor: false, text: false, file: false, dirty: false, sidebar: false, panel: false, secondary: false });
static WINDOW_CONTEXTS: LazyLock<Mutex<HashMap<String, Context>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn window_context(label: &str) -> Context {
    WINDOW_CONTEXTS.lock().unwrap().get(label).copied().unwrap_or_default()
}

pub fn forget_window(label: &str) {
    WINDOW_CONTEXTS.lock().unwrap().remove(label);
}

/// The window reports what it has open when that changes and when it comes to the front.
#[tauri::command]
pub fn menu_context(app: AppHandle, window: tauri::Window, context: Context) {
    // Each workbench menu follows its own window, including when another window is in front.
    let changed = WINDOW_CONTEXTS.lock().unwrap().insert(window.label().to_string(), context) != Some(context);
    if changed && !cfg!(target_os = "macos") {
        let _ = app.emit_to(window.label(), "menu-entries", entries(&app, context));
    }
    // Native accelerators still follow the foreground window.
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
    rebuild(&app, false);
}

// ---------- items mods add to the menu bar ----------

/// An item a mod put in the menu bar: in one of the menus (File, Edit, View, Window, or a new one
/// of its own, placed before Window). Picking it runs `command` in the window in front.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraItem {
    pub menu: String,
    pub command: String,
    pub label: String,
    pub accelerator: Option<String>,
    #[serde(default)]
    pub separator_before: bool,
}

static EXTRA: Mutex<Vec<ExtraItem>> = Mutex::new(Vec::new());

/// The window sends every item its mods add (all of them, each time they change).
#[tauri::command]
pub fn menu_set_extra(app: AppHandle, items: Vec<ExtraItem>) {
    {
        let mut current = EXTRA.lock().unwrap();
        if *current == items {
            return;
        }
        *current = items;
    }
    refresh(&app);
}

/// Menus of the mods' own (any name that is not one of the app's), in the order first seen.
fn extra_menus(extra: &[ExtraItem]) -> Vec<MenuEntry> {
    let built_in = ["AICode", "File", "Edit", "View", "Window", "Help"];
    // macOS has no built-in Help menu, but mods can contribute one.
    let built_in = if cfg!(target_os = "macos") { &built_in[..5] } else { &built_in[..] };
    let mut names: Vec<&str> = Vec::new();
    for it in extra {
        if !built_in.iter().chain(&names).any(|n| n.eq_ignore_ascii_case(&it.menu)) {
            names.push(&it.menu);
        }
    }
    names.into_iter().map(|name| with_extras(name, Vec::new(), extra)).collect()
}

fn with_extras(label: &str, mut items: Vec<MenuEntry>, extra: &[ExtraItem]) -> MenuEntry {
    for (n, it) in extra.iter().filter(|i| i.menu.eq_ignore_ascii_case(label)).enumerate() {
        if !items.is_empty() && (n == 0 || it.separator_before) {
            items.push(MenuEntry::Separator);
        }
        items.push(item(&it.command, &it.label, it.accelerator.as_deref().filter(|a| !a.is_empty())));
    }
    submenu(label, items)
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

// The native menu owns keyboard shortcuts. Windows and Linux render the same entries in the
// workbench so the menus follow its theme and can switch as the pointer moves across the bar.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuEntry {
    Command { id: String, label: String, accelerator: Option<String>, enabled: bool },
    Check { id: String, label: String, checked: bool },
    Submenu { label: String, items: Vec<Self> },
    Separator,
    Role { role: MenuRole },
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MenuRole {
    About, Cut, Copy, Paste, SelectAll, Minimize, Fullscreen,
    #[cfg(target_os = "macos")]
    Hide,
    #[cfg(target_os = "macos")]
    HideOthers,
    #[cfg(target_os = "macos")]
    ShowAll,
    #[cfg(target_os = "macos")]
    Quit,
}

fn item_if(id: &str, label: &str, accelerator: Option<&str>, enabled: bool) -> MenuEntry {
    MenuEntry::Command { id: id.into(), label: label.into(), accelerator: accelerator.map(String::from), enabled }
}

fn item(id: &str, label: &str, accelerator: Option<&str>) -> MenuEntry {
    item_if(id, label, accelerator, true)
}

fn check(id: &str, label: &str, checked: bool) -> MenuEntry {
    MenuEntry::Check { id: id.into(), label: label.into(), checked }
}

fn submenu(label: &str, items: Vec<MenuEntry>) -> MenuEntry {
    MenuEntry::Submenu { label: label.into(), items }
}

fn role(role: MenuRole) -> MenuEntry {
    MenuEntry::Role { role }
}

fn native_item(app: &AppHandle, entry: &MenuEntry) -> tauri::Result<MenuItemKind<Wry>> {
    Ok(match entry {
        MenuEntry::Command { id, label, accelerator, enabled } => {
            let builder = || MenuItemBuilder::with_id(id.as_str(), label.as_str()).enabled(*enabled);
            let item = match accelerator {
                Some(a) => builder().accelerator(a).build(app).or_else(|e| {
                    eprintln!("[aicode] menu item {label:?}: shortcut {a:?} rejected ({e}); shown without it");
                    builder().build(app)
                })?,
                None => builder().build(app)?,
            };
            MenuItemKind::MenuItem(item)
        }
        MenuEntry::Check { id, label, checked } => {
            MenuItemKind::Check(CheckMenuItemBuilder::with_id(id.as_str(), label).checked(*checked).build(app)?)
        }
        MenuEntry::Submenu { label, items } => {
            let mut sub = SubmenuBuilder::new(app, label);
            for entry in items {
                sub = sub.item(&native_item(app, entry)?);
            }
            MenuItemKind::Submenu(sub.build()?)
        }
        MenuEntry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        MenuEntry::Role { role } => MenuItemKind::Predefined(match role {
            MenuRole::About => PredefinedMenuItem::about(app, None, None)?,
            MenuRole::Cut => PredefinedMenuItem::cut(app, None)?,
            MenuRole::Copy => PredefinedMenuItem::copy(app, None)?,
            MenuRole::Paste => PredefinedMenuItem::paste(app, None)?,
            MenuRole::SelectAll => PredefinedMenuItem::select_all(app, None)?,
            MenuRole::Minimize => PredefinedMenuItem::minimize(app, None)?,
            MenuRole::Fullscreen => PredefinedMenuItem::fullscreen(app, None)?,
            #[cfg(target_os = "macos")]
            MenuRole::Hide => PredefinedMenuItem::hide(app, None)?,
            #[cfg(target_os = "macos")]
            MenuRole::HideOthers => PredefinedMenuItem::hide_others(app, None)?,
            #[cfg(target_os = "macos")]
            MenuRole::ShowAll => PredefinedMenuItem::show_all(app, None)?,
            #[cfg(target_os = "macos")]
            MenuRole::Quit => PredefinedMenuItem::quit(app, None)?,
        }),
    })
}

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

fn open_recent() -> MenuEntry {
    let (mut folders, mut files) = (Vec::new(), Vec::new());
    for p in recent_list() {
        match std::fs::metadata(&p) {
            Ok(m) if m.is_dir() => folders.push(p),
            Ok(_) => files.push(p),
            Err(_) => {} // gone from disk: not offered
        }
    }
    let mut items = vec![item("workbench.reopenLastSession", "Reopen Last Session", None)];
    for group in [&folders, &files] {
        if group.is_empty() {
            continue;
        }
        items.push(MenuEntry::Separator);
        for p in group.iter().take(SHOWN_RECENT) {
            items.push(item(&format!("{RECENT}{p}"), &home_relative(p), None));
        }
    }
    items.push(MenuEntry::Separator);
    items.push(item_if("workbench.clearRecentlyOpened", "Clear Recently Opened", None, !folders.is_empty() || !files.is_empty()));
    submenu("Open Recent", items)
}

fn switch_profile(app: &AppHandle) -> MenuEntry {
    let state = app.state::<mods::ModsState>();
    let active = state.profile_name.lock().unwrap().clone();
    let mut names = mods::profile_names();
    if !names.contains(&active) {
        names.push(active.clone());
        names.sort();
    }
    let mut items: Vec<_> = names.iter().map(|name| check(&format!("{PROFILE}{name}"), name, *name == active)).collect();
    items.extend([
        MenuEntry::Separator,
        item("profiles.create", "New Profile…", None),
        item("profiles.manage", "Manage Profiles…", None),
    ]);
    submenu("Switch Profile", items)
}

#[tauri::command]
pub fn menu_entries(app: AppHandle, window: tauri::Window) -> Vec<MenuEntry> {
    entries(&app, window_context(window.label()))
}

fn entries(app: &AppHandle, ctx: Context) -> Vec<MenuEntry> {
    use MenuEntry::Separator;
    use MenuRole::*;

    let extra = EXTRA.lock().unwrap().clone();
    let mut menus = Vec::new();
    #[cfg(target_os = "macos")]
    menus.push(submenu("AICode", vec![
        role(About),
        item("update.check", "Check for Updates…", None),
        Separator,
        item("preferences.settings", "Settings…", Some("CmdOrCtrl+,")),
        item("profiles.manage", "Profiles…", None),
        item("mods.manage", "Mods…", Some("CmdOrCtrl+Shift+X")),
        item("preferences.theme", "Color Theme…", None),
        item("workbench.keybindings", "Keyboard Shortcuts", None),
        Separator,
        role(Hide),
        role(HideOthers),
        role(ShowAll),
        Separator,
        role(Quit),
    ]));

    let mut file = vec![
        item("file.new", "New Text File", Some("CmdOrCtrl+N")),
        item("file.newFile", "New File…", Some("Ctrl+Alt+CmdOrCtrl+N")),
        item("workbench.newWindow", "New Window", Some("CmdOrCtrl+Shift+N")),
        switch_profile(app),
        Separator,
        item("file.open", "Open File…", Some("CmdOrCtrl+O")),
        item("workbench.openFolder", "Open Folder…", None),
        item("workbench.openFolderNewWindow", "Open Folder in New Window…", None),
        open_recent(),
        Separator,
        item_if("workbench.duplicateWindow", "Duplicate Window", None, ctx.folder),
        Separator,
        item_if("file.save", "Save", Some("CmdOrCtrl+S"), ctx.text),
        item_if("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"), ctx.text),
        item_if("file.saveAll", "Save All", Some("CmdOrCtrl+Alt+S"), ctx.dirty),
        Separator,
        submenu("Share", vec![item("profiles.export", "Export Profile…", None)]),
        Separator,
        check("files.toggleAutoSave", "Auto Save", auto_save_on(app)),
        Separator,
        item_if("file.revert", "Revert File", None, ctx.file),
        item_if("editor.close", "Close Editor", Some("CmdOrCtrl+W"), ctx.editor),
    ];
    if ctx.folder {
        let label = if cfg!(target_os = "macos") { "Close Folder [⌘K F]" } else { "Close Folder [Ctrl+K F]" };
        file.push(item("workbench.closeFolder", label, None));
    }
    file.push(item("window.close", "Close Window", Some("CmdOrCtrl+Shift+W")));
    #[cfg(not(target_os = "macos"))]
    file.extend([
        Separator,
        submenu("Preferences", vec![
            item("preferences.settings", "Settings", Some("CmdOrCtrl+,")),
            item("profiles.manage", "Profiles", None),
            item("mods.manage", "Mods", Some("CmdOrCtrl+Shift+X")),
            item("workbench.keybindings", "Keyboard Shortcuts", None),
            Separator,
            item("preferences.theme", "Color Theme", None),
        ]),
        Separator,
        item("app.quit", "Exit", None),
    ]);

    let edit = vec![
        item("edit.undo", "Undo", Some("CmdOrCtrl+Z")),
        item("edit.redo", "Redo", Some("CmdOrCtrl+Shift+Z")),
        Separator,
        role(Cut),
        role(Copy),
        role(Paste),
        role(SelectAll),
        Separator,
        item("edit.find", "Find", Some("CmdOrCtrl+F")),
        item("edit.replace", "Replace", Some("CmdOrCtrl+Alt+F")),
    ];
    let view = vec![
        item("workbench.commandPalette", "Command Palette…", Some("CmdOrCtrl+Shift+P")),
        item("workbench.quickOpen", "Go to File…", Some("CmdOrCtrl+P")),
        Separator,
        item_if("workbench.toggleSidebar", "Toggle Primary Side Bar", Some("CmdOrCtrl+B"), ctx.sidebar),
        item_if("workbench.togglePanel", "Toggle Panel", Some("CmdOrCtrl+J"), ctx.panel),
        item_if("workbench.toggleSecondary", "Toggle Secondary Side Bar", Some("CmdOrCtrl+Alt+B"), ctx.secondary),
        Separator,
        item("editor.zoomIn", "Zoom In", Some("CmdOrCtrl+=")),
        item("editor.zoomOut", "Zoom Out", Some("CmdOrCtrl+-")),
        item("editor.zoomReset", "Reset Zoom", Some("CmdOrCtrl+0")),
        Separator,
        item("workbench.reload", "Reload Window", Some("CmdOrCtrl+R")),
    ];
    menus.extend([
        with_extras("File", file, &extra),
        with_extras("Edit", edit, &extra),
        with_extras("View", view, &extra),
    ]);
    menus.extend(extra_menus(&extra));
    menus.push(with_extras("Window", vec![role(Minimize), role(Fullscreen)], &extra));
    #[cfg(not(target_os = "macos"))]
    menus.push(with_extras("Help", vec![
        item("workbench.commandPalette", "Show All Commands", Some("CmdOrCtrl+Shift+P")),
        Separator,
        item("update.check", "Check for Updates…", None),
        Separator,
        role(About),
    ], &extra));
    menus
}

fn set_native_menu(app: &AppHandle, items: &[MenuEntry]) -> tauri::Result<()> {
    let mut builder = MenuBuilder::new(app);
    for entry in items {
        builder = builder.item(&native_item(app, entry)?);
    }
    app.set_menu(builder.build()?)?;
    Ok(())
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    set_native_menu(app, &entries(app, Context::default()))
}

/// Rebuilds the menu bar (the recent list, the profiles or Auto Save changed).
pub fn refresh(app: &AppHandle) {
    rebuild(app, true);
}

fn rebuild(app: &AppHandle, _shared_items_changed: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let context = *CONTEXT.lock().unwrap();
        let items = entries(&app2, context);
        if let Err(e) = set_native_menu(&app2, &items) {
            eprintln!("[aicode] could not rebuild the menu: {e}");
            return;
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Setting the menu puts a menu bar back on every window.
            for (label, w) in app2.webview_windows() {
                let _ = w.hide_menu();
                if _shared_items_changed {
                    let window = window_context(&label);
                    let entries = if window == context { items.clone() } else { entries(&app2, window) };
                    let _ = app2.emit_to(label.as_str(), "menu-entries", entries);
                }
            }
        }
    });
}

/// A menu item was picked.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().0.as_str();
    // A mod's icon in the menu bar: to the window that set it.
    if let Some(rest) = id.strip_prefix(crate::background::TRAY_PREFIX) {
        crate::background::on_menu(app, rest);
        return;
    }
    select(app, id, windows::front_label(app).as_deref(), "menu");
}

#[tauri::command]
pub async fn menu_select(app: AppHandle, window: tauri::Window, id: String) {
    select(&app, &id, Some(window.label()), "menu-picked");
}

fn select(app: &AppHandle, id: &str, label: Option<&str>, command_event: &str) {
    if id == "app.quit" {
        app.exit(0);
        return;
    }
    if let Some(path) = id.strip_prefix(RECENT) {
        // Like a path dropped on the Dock icon: a folder goes to the window in front if it has
        // none (else to a window of its own), a file opens in it.
        if Path::new(path).exists() {
            let paths = vec![path.to_string()];
            if let Some(label) = label {
                windows::open_in_window(app, label, paths);
            } else {
                windows::open_in_front(app, paths);
            }
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
    if let Some(label) = label {
        let _ = app.emit_to(label, command_event, id.to_string());
    }
}
