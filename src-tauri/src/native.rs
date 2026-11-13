//! Native code for mods, written in JavaScript: macOS's JavaScript for Automation (JXA), run inside
//! AICode's own process through OSAKit. JXA's ObjC bridge reaches every Cocoa API (`$.NSApplication`
//! is AICode itself, `$.NSApp.windows` its windows), JS functions work as blocks, and
//! `ObjC.registerSubclass` makes delegates and targets — so a mod can do natively whatever it wants
//! with no Rust and no compiling.
//!
//! - `native_eval`: runs a snippet once and returns its result (JSON).
//! - `native_open` / `native_call` / `native_close`: a context that stays (its functions, state,
//!   observers, timers, monitors), called by function name.
//! - From JXA back to the window: `emit(channel, data)` → `native://event`.
//!
//! JXA runs on the main thread (AppKit needs it): code that loops or waits belongs in a helper
//! process instead (`ctx.native.spawn` in mods.ts runs `osascript -l JavaScript`).
//!
//! Global keyboard shortcuts (`app_shortcut_*`) are here too: they work while AICode is in the
//! background and need no permission.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mods::{require, ModsState};

static APP: OnceLock<AppHandle> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Context id → (window label, mod id): where `emit` goes, and what a closing window takes along.
#[derive(Default)]
pub struct NativeState {
    owners: Mutex<HashMap<u64, (String, String)>>,
    /// Global shortcut (as registered) → (window label, mod id).
    shortcuts: Mutex<HashMap<String, (String, String)>>,
}

/// The JXA prelude: Foundation and AppKit, `args`, `emit`, and the call dispatcher.
fn prelude(id: u64, args: &Value) -> String {
    format!(
        "ObjC.import('Foundation'); ObjC.import('AppKit');\n\
         var __aicode_id = {id};\n\
         var args = {args};\n\
         function emit(channel, data) {{ $.AICodeNative.emitToPayload(String(__aicode_id) + '\\u001f' + String(channel), JSON.stringify(data === undefined ? null : data)); }}\n\
         function __aicode_call(name, json) {{ var f = eval(name); if (typeof f !== 'function') throw new Error('no function ' + name); var r = f.apply(null, JSON.parse(json)); return JSON.stringify(r === undefined ? null : r); }}\n\
         function __aicode_dispose() {{ if (typeof dispose === 'function') dispose(); return 'null'; }}\n",
        args = serde_json::to_string(args).unwrap_or_else(|_| "null".into())
    )
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, NSObject, Sel};
    use objc2::{msg_send, sel, ClassType};
    use objc2_foundation::NSString;

    #[link(name = "OSAKit", kind = "framework")]
    extern "C" {}

    thread_local! {
        // OSAScript objects live on the main thread only.
        static CONTEXTS: RefCell<HashMap<u64, Retained<AnyObject>>> = RefCell::new(HashMap::new());
    }

    extern "C-unwind" fn emit_to_payload(_cls: &AnyClass, _sel: Sel, target: *mut AnyObject, payload: *mut AnyObject) {
        let text = |p: *mut AnyObject| if p.is_null() { String::new() } else { unsafe { &*(p as *const NSString) }.to_string() };
        let target = text(target);
        let payload = text(payload);
        let Some(app) = APP.get() else { return };
        let Some((id, channel)) = target.split_once('\u{1f}') else { return };
        let Ok(id) = id.parse::<u64>() else { return };
        let owner = app.state::<NativeState>().owners.lock().unwrap().get(&id).cloned();
        if let Some((label, _)) = owner {
            let data: Value = serde_json::from_str(&payload).unwrap_or(Value::String(payload));
            let _ = app.emit_to(label.as_str(), "native://event", json!({ "id": id, "channel": channel, "data": data }));
        }
    }

    /// The class JXA calls to reach the window: `$.AICodeNative.emitToPayload(target, json)`.
    pub fn register_bridge() {
        if AnyClass::get(c"AICodeNative").is_some() {
            return;
        }
        let Some(mut b) = ClassBuilder::new(c"AICodeNative", NSObject::class()) else { return };
        unsafe {
            b.add_class_method(sel!(emitTo:payload:), emit_to_payload as extern "C-unwind" fn(_, _, _, _));
        }
        b.register();
    }

    fn error_text(err: *mut AnyObject) -> String {
        if err.is_null() {
            return "the script failed".into();
        }
        unsafe {
            let key = NSString::from_str("OSAScriptErrorMessageKey");
            let msg: Option<Retained<AnyObject>> = msg_send![err, objectForKey: &*key];
            let text = |o: &AnyObject| {
                let d: Retained<NSString> = msg_send![o, description];
                d.to_string()
            };
            let out = match msg {
                Some(m) => text(&m),
                None => text(&*err),
            };
            // JXA prefixes the error's own "Error: " once more.
            out.strip_prefix("Error: ").filter(|rest| rest.starts_with("Error") || rest.contains(':')).map(str::to_string).unwrap_or(out)
        }
    }

    fn descriptor_text(d: Option<Retained<AnyObject>>) -> Option<String> {
        let d = d?;
        let s: Option<Retained<NSString>> = unsafe { msg_send![&*d, stringValue] };
        s.map(|s| s.to_string())
    }

    /// Compiles and runs `source`; the script object stays usable for handler calls.
    pub fn run(source: &str) -> Result<(Retained<AnyObject>, Option<String>), String> {
        let (Some(lang_cls), Some(script_cls)) = (AnyClass::get(c"OSALanguage"), AnyClass::get(c"OSAScript")) else {
            return Err("OSAKit is not available".into());
        };
        unsafe {
            let name = NSString::from_str("JavaScript");
            let lang: Option<Retained<AnyObject>> = msg_send![lang_cls, languageForName: &*name];
            let lang = lang.ok_or("JavaScript for Automation is not available")?;
            let src = NSString::from_str(source);
            let alloc: Allocated<AnyObject> = msg_send![script_cls, alloc];
            let script: Option<Retained<AnyObject>> = msg_send![alloc, initWithSource: &*src, language: &*lang];
            let script = script.ok_or("could not create the script")?;
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let result: Option<Retained<AnyObject>> = msg_send![&*script, executeAndReturnError: &mut err];
            if result.is_none() && !err.is_null() {
                return Err(error_text(err));
            }
            Ok((script, descriptor_text(result)))
        }
    }

    /// Calls one of a script's functions with string arguments; its result as text.
    pub fn call_handler(script: &AnyObject, handler: &str, args: &[&str]) -> Result<Option<String>, String> {
        let (Some(desc_cls), Some(array_cls)) = (AnyClass::get(c"NSAppleEventDescriptor"), AnyClass::get(c"NSArray")) else {
            return Err("Foundation is not available".into());
        };
        unsafe {
            let descs: Vec<Retained<AnyObject>> = args
                .iter()
                .map(|a| {
                    let s = NSString::from_str(a);
                    let d: Retained<AnyObject> = msg_send![desc_cls, descriptorWithString: &*s];
                    d
                })
                .collect();
            let ptrs: Vec<*mut AnyObject> = descs.iter().map(|d| Retained::as_ptr(d) as *mut AnyObject).collect();
            let array: Retained<AnyObject> = msg_send![array_cls, arrayWithObjects: ptrs.as_ptr(), count: ptrs.len()];
            let name = NSString::from_str(handler);
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let result: Option<Retained<AnyObject>> = msg_send![script, executeHandlerWithName: &*name, arguments: &*array, error: &mut err];
            if result.is_none() && !err.is_null() {
                return Err(error_text(err));
            }
            Ok(descriptor_text(result))
        }
    }

    pub fn keep(id: u64, script: Retained<AnyObject>) {
        CONTEXTS.with(|c| c.borrow_mut().insert(id, script));
    }

    pub fn with_context<T>(id: u64, f: impl FnOnce(&AnyObject) -> Result<T, String>) -> Result<T, String> {
        let script = CONTEXTS.with(|c| c.borrow().get(&id).cloned()).ok_or_else(|| format!("no native context {id}"))?;
        f(&script)
    }

    pub fn drop_context(id: u64) {
        let script = CONTEXTS.with(|c| c.borrow_mut().remove(&id));
        if let Some(s) = script {
            let _ = call_handler(&s, "__aicode_dispose", &[]);
        }
    }
}

/// Call from setup (main thread).
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    mac::register_bridge();
}

/// Runs `f` on the main thread and waits for it (JXA and AppKit live there).
async fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    let answer = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| "the main thread did not answer".to_string()))
        .await
        .map_err(|e| e.to_string())?;
    answer.and_then(|r| r)
}

fn parse(text: Option<String>) -> Value {
    match text {
        Some(t) => serde_json::from_str(&t).unwrap_or(Value::String(t)),
        None => Value::Null,
    }
}

/// Runs JXA once: `source` is a function body (`return` a JSON-able value), `args` its `args`.
#[tauri::command]
pub async fn native_eval(app: AppHandle, window: tauri::Window, mods: State<'_, ModsState>, mod_id: String, source: String, args: Option<Value>) -> Result<Value, String> {
    require(&mods, &mod_id, "native")?;
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let state = app.state::<NativeState>();
    state.owners.lock().unwrap().insert(id, (window.label().to_string(), mod_id));
    let full = format!(
        "{}var __aicode_result = (function () {{\n{source}\n}})();\nJSON.stringify(__aicode_result === undefined ? null : __aicode_result);",
        prelude(id, &args.unwrap_or(Value::Null))
    );
    #[cfg(target_os = "macos")]
    let out = on_main(&app, move || mac::run(&full).map(|(_, r)| r)).await;
    #[cfg(not(target_os = "macos"))]
    let out: Result<Option<String>, String> = {
        let _ = full;
        Err("native code is only available on macOS".into())
    };
    app.state::<NativeState>().owners.lock().unwrap().remove(&id);
    out.map(parse)
}

/// Opens a context that stays: `source` runs once (its top-level functions and variables stay).
#[tauri::command]
pub async fn native_open(app: AppHandle, window: tauri::Window, mods: State<'_, ModsState>, mod_id: String, source: String, args: Option<Value>) -> Result<u64, String> {
    require(&mods, &mod_id, "native")?;
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    app.state::<NativeState>().owners.lock().unwrap().insert(id, (window.label().to_string(), mod_id));
    let full = format!("{}{source}\n;'null'", prelude(id, &args.unwrap_or(Value::Null)));
    #[cfg(target_os = "macos")]
    let out = on_main(&app, move || {
        let (script, _) = mac::run(&full)?;
        mac::keep(id, script);
        Ok(())
    })
    .await;
    #[cfg(not(target_os = "macos"))]
    let out: Result<(), String> = {
        let _ = full;
        Err("native code is only available on macOS".into())
    };
    if out.is_err() {
        app.state::<NativeState>().owners.lock().unwrap().remove(&id);
    }
    out.map(|_| id)
}

/// Calls a function of an open context with JSON arguments; its result.
#[tauri::command]
pub async fn native_call(app: AppHandle, id: u64, name: String, args: Option<Vec<Value>>) -> Result<Value, String> {
    let json = serde_json::to_string(&args.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    #[cfg(target_os = "macos")]
    let out = on_main(&app, move || mac::with_context(id, |s| mac::call_handler(s, "__aicode_call", &[&name, &json]))).await;
    #[cfg(not(target_os = "macos"))]
    let out: Result<Option<String>, String> = {
        let _ = (app, id, name, json);
        Err("native code is only available on macOS".into())
    };
    out.map(parse)
}

/// Closes a context (calling its `dispose()` first, if it has one).
#[tauri::command]
pub async fn native_close(app: AppHandle, id: u64) -> Result<(), String> {
    app.state::<NativeState>().owners.lock().unwrap().remove(&id);
    #[cfg(target_os = "macos")]
    return on_main(&app, move || {
        mac::drop_context(id);
        Ok(())
    })
    .await;
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

/// Everything a window's mods opened natively: its contexts and global shortcuts (it closed, or loads again).
pub fn drop_owned_by(app: &AppHandle, label: &str) {
    let state = app.state::<NativeState>();
    let ids: Vec<u64> = {
        let mut owners = state.owners.lock().unwrap();
        let ids: Vec<u64> = owners.iter().filter(|(_, (l, _))| l == label).map(|(id, _)| *id).collect();
        for id in &ids {
            owners.remove(id);
        }
        ids
    };
    #[cfg(target_os = "macos")]
    if !ids.is_empty() {
        let _ = app.run_on_main_thread(move || ids.into_iter().for_each(mac::drop_context));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = ids;
    let keys: Vec<String> = {
        let mut sc = state.shortcuts.lock().unwrap();
        let keys: Vec<String> = sc.iter().filter(|(_, (l, _))| l == label).map(|(k, _)| k.clone()).collect();
        for k in &keys {
            sc.remove(k);
        }
        keys
    };
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    for k in keys {
        let _ = app.global_shortcut().unregister(k.as_str());
    }
}

#[tauri::command]
pub fn native_reset(app: AppHandle, window: tauri::Window) {
    drop_owned_by(&app, window.label());
}

// ---------- global shortcuts ----------

/// A keyboard shortcut for the whole system (AICode in the background, or hidden): pressing it sends
/// `shortcut://event` to this window. `accelerator`: "CmdOrCtrl+Shift+Space", "Alt+F1"…
#[tauri::command]
pub fn app_shortcut_register(app: AppHandle, window: tauri::Window, mods: State<'_, ModsState>, mod_id: String, accelerator: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    require(&mods, &mod_id, "app")?;
    let label = window.label().to_string();
    let state = app.state::<NativeState>();
    if let Some(owner) = state.shortcuts.lock().unwrap().get(&accelerator) {
        if owner.1 != mod_id {
            return Err(format!("{accelerator} is already taken by {}", owner.1));
        }
    }
    let _ = app.global_shortcut().unregister(accelerator.as_str());
    let key = accelerator.clone();
    app.global_shortcut()
        .on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
            let owner = app.state::<NativeState>().shortcuts.lock().unwrap().get(&key).cloned();
            if let Some((label, _)) = owner {
                let state = if event.state() == ShortcutState::Pressed { "pressed" } else { "released" };
                let _ = app.emit_to(label.as_str(), "shortcut://event", json!({ "accelerator": key, "state": state }));
            }
        })
        .map_err(|e| e.to_string())?;
    state.shortcuts.lock().unwrap().insert(accelerator, (label, mod_id));
    Ok(())
}

#[tauri::command]
pub fn app_shortcut_unregister(app: AppHandle, accelerator: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.state::<NativeState>().shortcuts.lock().unwrap().remove(&accelerator);
    app.global_shortcut().unregister(accelerator.as_str()).map_err(|e| e.to_string())
}
