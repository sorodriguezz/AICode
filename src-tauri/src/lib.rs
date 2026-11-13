//! AICode's core: a window, the file and process commands mods are allowed to use, the mod
//! registry, and the `aimod://` protocol their code is loaded from. Everything a user sees beyond
//! a single text editor comes from a mod.

mod bundle;
#[cfg(target_os = "macos")]
mod dock;
mod fsops;
mod mcp;
mod menu;
mod mods;
mod paths;
mod procs;
mod profiles;
mod updater;
mod windows;

use tauri::Manager;

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

/// A folder or file opened from AICode, for the Dock icon's "recent" list.
#[tauri::command]
fn recent_add(app: tauri::AppHandle, path: String) {
    // File ▸ Open Recent keeps its own list; the Dock's is the system's.
    menu::recent_add(&app, path.clone());
    #[cfg(target_os = "macos")]
    dock::note_recent(&app, path);
}

#[tauri::command]
fn recent_clear(app: tauri::AppHandle) {
    menu::recent_clear(&app);
    #[cfg(target_os = "macos")]
    dock::clear_recent(&app);
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
            app.set_menu(menu::build(app.handle())?)?;
            // A menu command is for the window in front (Open Recent and the profiles are handled in Rust).
            app.on_menu_event(menu::on_event);
            // Paths given on the command line open in the first window.
            let args: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).collect();
            let mut initial = windows::to_paths(args.into_iter().map(|a| {
                if a.starts_with('/') { a } else { std::env::current_dir().map(|d| d.join(&a).to_string_lossy().into_owned()).unwrap_or(a) }
            }));
            // A launch by dropping something on the Dock icon delivers it before setup runs: it
            // waited in `launch_paths` and opens in the first window, like the command line.
            let wins = app.state::<windows::WindowsState>();
            initial.extend(wins.launch_paths.lock().unwrap().drain(..));
            // A clean start (the default): one empty window; the last session waits for "Reopen Last Session".
            // After installing an update the restart restores everything once, whatever the setting.
            let restore_once = std::fs::remove_file(paths::state().join("restore-once")).is_ok();
            let restore_all = restore_once || mods::effective_core_setting(&state, "window.restoreOnStartup").and_then(|v| v.as_str().map(String::from)).as_deref() == Some("all");
            if !restore_all {
                windows::stash_sessions(app.handle());
            }
            windows::restore(app.handle(), initial)?;
            wins.started.store(true, std::sync::atomic::Ordering::SeqCst);
            #[cfg(target_os = "macos")]
            dock::install(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            menu::menu_context,
            core_info,
            core_log,
            recent_add,
            recent_clear,
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
            mods::settings_all,
            mods::mod_install_folder,
            mods::mod_uninstall,
            fsops::fs_read_text,
            fsops::fs_read_data_url,
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
            windows::window_take_spec,
            windows::window_is_transparent,
            windows::window_reopen,
            windows::session_previous_info,
            windows::session_restore_previous,
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
                let state = app.state::<windows::WindowsState>();
                if !state.started.load(std::sync::atomic::Ordering::SeqCst) {
                    // Launched by this: no window exists yet, and setup will create them.
                    state.launch_paths.lock().unwrap().extend(paths);
                } else if !paths.is_empty() {
                    windows::open_in_front(app, paths);
                }
            }
            _ => {}
        });
}
