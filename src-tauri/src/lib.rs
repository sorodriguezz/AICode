//! AICode's core: a window, the file and process commands mods are allowed to use, the mod
//! registry, and the `aimod://` protocol their code is loaded from. Everything a user sees beyond
//! a single text editor comes from a mod.

mod bundle;
mod fsops;
mod mcp;
mod mods;
mod paths;
mod procs;
mod profiles;
mod updater;
mod windows;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

/// A window's session (open tabs, unsaved text, layout, folder), per profile and window.
#[tauri::command]
fn session_load(app: tauri::AppHandle, window: tauri::Window) -> Option<String> {
    std::fs::read_to_string(windows::session_path(&app, window.label())).ok()
}

#[tauri::command]
fn session_save(app: tauri::AppHandle, window: tauri::Window, data: String) -> Result<(), String> {
    fsops::write_atomic(&windows::session_path(&app, window.label()), data.as_bytes())
}

/// Errors and warnings from the window, so they show up in the terminal that started AICode.
#[tauri::command]
fn core_log(level: String, message: String) {
    eprintln!("[window {level}] {}", message.chars().take(4000).collect::<String>());
}

#[tauri::command]
fn core_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "modApi": mods::API_VERSION,
        "platform": std::env::consts::OS,
        "dataDir": paths::root(),
        "diag": std::env::var_os("AICODE_DIAG").is_some(),
        // AICODE_DIAG_RUN="cmd.a,cmd.b": commands the diagnostics run, for checks without a screen.
        "diagRun": std::env::var("AICODE_DIAG_RUN").unwrap_or_default(),
    })
}

fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let item = |id: &str, text: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, text);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
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
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("file.new", "New File", Some("CmdOrCtrl+N"))?)
        .item(&item("workbench.newWindow", "New Window", Some("CmdOrCtrl+Shift+N"))?)
        .separator()
        .item(&item("file.open", "Open File…", Some("CmdOrCtrl+O"))?)
        .item(&item("workbench.openFolderNewWindow", "Open Folder in New Window…", None)?)
        .separator()
        .item(&item("file.save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item("editor.close", "Close Editor", Some("CmdOrCtrl+W"))?)
        .item(&item("window.close", "Close Window", Some("CmdOrCtrl+Shift+W"))?)
        .build()?;
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

pub fn run() {
    paths::ensure();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(mods::ModsState::load())
        .manage(procs::ProcState::default())
        .manage(mcp::McpState::default())
        .manage(windows::WindowsState::default())
        .manage(fsops::WatchState::default())
        .manage(updater::UpdateState::default())
        .on_window_event(windows::on_window_event)
        // Served off the main thread: a mod's files are read from disk while the window keeps
        // handling its own requests (IPC included) during startup.
        .register_asynchronous_uri_scheme_protocol("aimod", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let (status, content_type, body) = mods::serve(&app, request.uri().path());
                if status != 200 {
                    eprintln!("[aimod] {status} {}", request.uri());
                }
                responder.respond(
                    tauri::http::Response::builder()
                        .status(status)
                        .header("Content-Type", content_type)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "no-cache")
                        .body(body)
                        .unwrap(),
                );
            });
        })
        .setup(|app| {
            let state = app.state::<mods::ModsState>();
            let profile = state.profile.lock().unwrap().clone();
            let name = state.profile_name.lock().unwrap().clone();
            *state.mods.lock().unwrap() = mods::scan(app.handle(), &name, &profile);
            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            // A menu command is for the window in front.
            app.on_menu_event(|app, event| {
                if let Some(label) = windows::front_label(app) {
                    let _ = app.emit_to(label.as_str(), "menu", event.id().0.clone());
                }
            });
            // Paths given on the command line open in the first window.
            let args: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).collect();
            let initial = windows::to_paths(args.into_iter().map(|a| {
                if a.starts_with('/') { a } else { std::env::current_dir().map(|d| d.join(&a).to_string_lossy().into_owned()).unwrap_or(a) }
            }));
            windows::restore(app.handle(), initial)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_info,
            core_log,
            session_load,
            session_save,
            mods::mods_list,
            mods::mods_permissions,
            mods::mods_folder,
            mods::profile_set_enabled,
            profiles::profile_get,
            profiles::profile_list,
            profiles::profile_create,
            profiles::profile_rename,
            profiles::profile_delete,
            profiles::profile_switch,
            profiles::profile_reload,
            profiles::profile_set_info,
            profiles::profile_set_keybindings,
            profiles::profile_export,
            profiles::profile_import,
            bundle::mod_install_file,
            bundle::mod_install_json,
            bundle::mod_export,
            bundle::mod_guide,
            bundle::mod_schema,
            mods::settings_get,
            mods::settings_set,
            mods::mod_install_folder,
            mods::mod_uninstall,
            fsops::fs_read_text,
            fsops::fs_write_text,
            fsops::fs_read_dir,
            fsops::fs_stat,
            fsops::fs_create,
            fsops::fs_rename,
            fsops::fs_delete,
            fsops::fs_copy,
            fsops::fs_reveal,
            fsops::fs_watch,
            fsops::fs_unwatch,
            fsops::fs_list_files,
            fsops::fs_search,
            fsops::home_dir,
            procs::proc_which,
            procs::proc_spawn,
            procs::proc_kill,
            procs::pty_spawn,
            procs::pty_shells,
            procs::pty_write,
            procs::pty_resize,
            procs::pty_kill,
            procs::open_external,
            procs::app_installed,
            procs::clipboard_write,
            procs::resource_stats,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_set_tools,
            mcp::mcp_reply,
            windows::window_new,
            windows::window_take_pending,
            windows::window_count,
            updater::update_check,
            updater::update_install,
            updater::update_claim_startup_check,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AICode")
        .run(|app, event| match event {
            // Quitting keeps every window's session (hot exit), unlike closing one window.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                let state = app.state::<windows::WindowsState>();
                // Switching profiles closes every window for a moment; that is not quitting.
                if code.is_none() && state.switching.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                } else {
                    state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
            tauri::RunEvent::Exit => procs::kill_all(app),
            // A file or folder dropped on the Dock icon, "Open With" in Finder, `open -a AICode x`.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = windows::to_paths(urls.into_iter().map(|u| u.to_string()));
                if !paths.is_empty() {
                    windows::open_in_front(app, paths);
                }
            }
            _ => {}
        });
}
