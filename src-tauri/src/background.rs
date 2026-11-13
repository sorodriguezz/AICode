//! The app beyond its windows, for mods: icons in the menu bar (status items, "tray icons"), the
//! Dock (shown or not, its badge), quitting, and what clicking the Dock icon does when every
//! window is hidden. AICode adds none of these itself; a mod does (`ctx.app` in mods.ts).
//!
//! A window a mod hides keeps running — its mods, programs and terminals — so "keep working after
//! the window closes" is a mod that hides the window instead of closing it and puts an icon in the
//! menu bar to bring it back.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::mods::{require, ModsState};

/// Menu item ids of tray menus: `aicode.tray:<key>\u{1f}<item id>` (routed by menu::on_event).
pub const TRAY_PREFIX: &str = "aicode.tray:";
const SEP: char = '\u{1f}';

#[derive(Default)]
pub struct BgState {
    /// "<mod id>:<tray id>" → the window that receives its events, and the icon.
    trays: Mutex<HashMap<String, (String, TrayIcon<Wry>)>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TraySpec {
    /// A PNG as a `data:` URL or base64, or a path to a PNG; "app" (or nothing) is the app's icon.
    icon: Option<String>,
    /// macOS draws the icon in the menu bar's color (for a black-on-transparent icon). Default true
    /// for a custom icon.
    template: Option<bool>,
    /// Text beside the icon in the menu bar.
    title: Option<String>,
    tooltip: Option<String>,
    menu: Option<Vec<TrayItem>>,
    /// Whether a left click opens the menu (default true when there is a menu).
    menu_on_left_click: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrayItem {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    separator: Option<bool>,
    accelerator: Option<String>,
    submenu: Option<Vec<TrayItem>>,
}

fn icon_from(app: &AppHandle, spec: Option<&str>) -> Result<Option<Image<'static>>, String> {
    match spec.map(str::trim) {
        None | Some("") | Some("app") => Ok(app.default_window_icon().cloned().map(|i| i.to_owned())),
        Some(s) => {
            let bytes = if let Some(i) = s.find("base64,") {
                base64::engine::general_purpose::STANDARD.decode(&s[i + 7..]).map_err(|e| format!("icon: {e}"))?
            } else if s.starts_with('/') {
                std::fs::read(s).map_err(|e| format!("icon {s}: {e}"))?
            } else {
                base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| format!("icon: {e}"))?
            };
            Image::from_bytes(&bytes).map(|i| Some(i.to_owned())).map_err(|e| format!("icon: {e}"))
        }
    }
}

fn build_items(app: &AppHandle, key: &str, items: &[TrayItem]) -> Result<Vec<MenuItemKind<Wry>>, String> {
    let mut out = Vec::new();
    for (n, it) in items.iter().enumerate() {
        if it.separator.unwrap_or(false) {
            out.push(MenuItemKind::Predefined(PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?));
            continue;
        }
        let label = it.label.clone().unwrap_or_default();
        let id = format!("{TRAY_PREFIX}{key}{SEP}{}", it.id.clone().unwrap_or_else(|| n.to_string()));
        let enabled = it.enabled.unwrap_or(true);
        if let Some(sub) = &it.submenu {
            let children = build_items(app, key, sub)?;
            let refs: Vec<&dyn IsMenuItem<Wry>> = children.iter().map(|c| c as &dyn IsMenuItem<Wry>).collect();
            out.push(MenuItemKind::Submenu(Submenu::with_id_and_items(app, id, label, enabled, &refs).map_err(|e| e.to_string())?));
        } else if let Some(checked) = it.checked {
            out.push(MenuItemKind::Check(CheckMenuItem::with_id(app, id, label, enabled, checked, it.accelerator.as_deref()).map_err(|e| e.to_string())?));
        } else {
            out.push(MenuItemKind::MenuItem(MenuItem::with_id(app, id, label, enabled, it.accelerator.as_deref()).map_err(|e| e.to_string())?));
        }
    }
    Ok(out)
}

fn build_menu(app: &AppHandle, key: &str, items: &[TrayItem]) -> Result<Menu<Wry>, String> {
    let built = build_items(app, key, items)?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|c| c as &dyn IsMenuItem<Wry>).collect();
    Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

fn owner_of(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<BgState>().trays.lock().unwrap().get(key).map(|(label, _)| label.clone())
}

/// Creates or updates a mod's icon in the menu bar. Its clicks and menu picks go to the window that
/// set it last (`tray://event`).
#[tauri::command]
pub fn app_tray_set(app: AppHandle, window: tauri::Window, mods: State<'_, ModsState>, mod_id: String, id: String, spec: TraySpec) -> Result<(), String> {
    require(&mods, &mod_id, "app")?;
    let key = format!("{mod_id}:{id}");
    let custom_icon = spec.icon.as_deref().is_some_and(|s| !s.trim().is_empty() && s.trim() != "app");
    let icon = icon_from(&app, spec.icon.as_deref())?;
    let template = spec.template.unwrap_or(custom_icon);
    let menu = match &spec.menu {
        Some(items) if !items.is_empty() => Some(build_menu(&app, &key, items)?),
        _ => None,
    };
    let left_menu = spec.menu_on_left_click.unwrap_or(menu.is_some());
    let label = window.label().to_string();
    let state = app.state::<BgState>();
    let mut trays = state.trays.lock().unwrap();
    if let Some((owner, tray)) = trays.get_mut(&key) {
        *owner = label;
        tray.set_icon(icon).map_err(|e| e.to_string())?;
        tray.set_icon_as_template(template).map_err(|e| e.to_string())?;
        tray.set_title(spec.title.as_deref()).map_err(|e| e.to_string())?;
        tray.set_tooltip(spec.tooltip.as_deref()).map_err(|e| e.to_string())?;
        tray.set_menu(menu).map_err(|e| e.to_string())?;
        tray.set_show_menu_on_left_click(left_menu).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut builder = TrayIconBuilder::with_id(key.clone()).icon_as_template(template).show_menu_on_left_click(left_menu);
    if let Some(i) = icon {
        builder = builder.icon(i);
    }
    if let Some(t) = &spec.title {
        builder = builder.title(t);
    }
    if let Some(t) = &spec.tooltip {
        builder = builder.tooltip(t);
    }
    if let Some(m) = &menu {
        builder = builder.menu(m);
    }
    let event_key = key.clone();
    let tray = builder
        .on_tray_icon_event(move |tray, event| {
            let app = tray.app_handle();
            let (kind, button, pos) = match event {
                TrayIconEvent::Click { button, button_state: MouseButtonState::Up, position, .. } => ("click", button, position),
                TrayIconEvent::DoubleClick { button, position, .. } => ("doubleClick", button, position),
                _ => return,
            };
            let button = match button {
                MouseButton::Left => "left",
                MouseButton::Right => "right",
                MouseButton::Middle => "middle",
            };
            if let Some(label) = owner_of(app, &event_key) {
                let _ = app.emit_to(label.as_str(), "tray://event", json!({ "key": event_key, "kind": kind, "button": button, "x": pos.x, "y": pos.y }));
            }
        })
        .build(&app)
        .map_err(|e| e.to_string())?;
    trays.insert(key, (label, tray));
    Ok(())
}

#[tauri::command]
pub fn app_tray_remove(app: AppHandle, mod_id: String, id: String) {
    let key = format!("{mod_id}:{id}");
    if let Some((_, tray)) = app.state::<BgState>().trays.lock().unwrap().remove(&key) {
        let _ = tray.set_visible(false);
        drop(tray);
        let _ = app.remove_tray_by_id(&key);
    }
}

/// A window that loads again (Reload Window) starts with no icons of its own: its mods put back
/// the ones they still want.
#[tauri::command]
pub fn app_tray_reset(app: AppHandle, window: tauri::Window) {
    drop_owned_by(&app, window.label());
}

/// Removes the icons a window set (it closed).
pub fn drop_owned_by(app: &AppHandle, label: &str) {
    let removed: Vec<String> = {
        let state = app.state::<BgState>();
        let mut trays = state.trays.lock().unwrap();
        let keys: Vec<String> = trays.iter().filter(|(_, (owner, _))| owner == label).map(|(k, _)| k.clone()).collect();
        for k in &keys {
            if let Some((_, tray)) = trays.remove(k) {
                let _ = tray.set_visible(false);
            }
        }
        keys
    };
    for k in removed {
        let _ = app.remove_tray_by_id(&k);
    }
}

/// A tray menu item was picked: to the window that owns the icon.
pub fn on_menu(app: &AppHandle, rest: &str) {
    let Some((key, item)) = rest.split_once(SEP) else { return };
    if let Some(label) = owner_of(app, key) {
        let _ = app.emit_to(label.as_str(), "tray://event", json!({ "key": key, "kind": "menu", "item": item }));
    }
}

/// The Dock icon (and the app in ⌘Tab): shown, or not (an app that lives in the menu bar).
#[tauri::command]
pub fn app_set_dock_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.set_dock_visibility(visible).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
        Ok(())
    }
}

/// The Dock icon's badge (a count, a word), or none.
#[tauri::command]
pub fn app_set_badge(window: tauri::Window, text: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.set_badge_label(text.filter(|t| !t.is_empty())).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, text);
        Ok(())
    }
}

/// Quits AICode (every window keeps its session, as with ⌘Q).
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// Clicking the Dock icon with no window on screen: hidden windows come back, and every window
/// hears it (`app://reopen`), so a mod can do something else.
pub fn on_reopen(app: &AppHandle, has_visible_windows: bool) {
    let _ = app.emit("app://reopen", json!({ "hasVisibleWindows": has_visible_windows }));
    if has_visible_windows {
        return;
    }
    for w in app.webview_windows().values() {
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}
