//! The Dock icon's menu, as in VS Code: the folders and files opened recently (macOS keeps that
//! list once each one is reported with [`note_recent`]; picking one arrives as `RunEvent::Opened`)
//! and "New Window". macOS adds the open windows on its own.
//!
//! Tauri has no API for the Dock menu, so the app delegate (tao's) is given the
//! `applicationDockMenu:` method AppKit asks it for.

use std::cell::OnceCell;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSDocumentController, NSMenu, NSMenuItem};
use objc2_foundation::{NSString, NSURL};
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

thread_local! {
    // Built once, on the main thread, the first time the Dock asks.
    static MENU: OnceCell<Retained<NSMenu>> = const { OnceCell::new() };
}

extern "C-unwind" fn dock_menu(this: &AnyObject, _: Sel, _sender: *mut AnyObject) -> *mut NSMenu {
    let Some(mtm) = MainThreadMarker::new() else { return std::ptr::null_mut() };
    MENU.with(|cell| Retained::as_ptr(cell.get_or_init(|| build_menu(mtm, this))) as *mut NSMenu)
}

fn build_menu(mtm: MainThreadMarker, target: &AnyObject) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc::<NSMenuItem>(),
            &NSString::from_str("New Window"),
            Some(sel!(aicodeNewWindow:)),
            &NSString::from_str(""),
        )
    };
    unsafe { item.setTarget(Some(target)) };
    menu.addItem(&item);
    menu
}

extern "C-unwind" fn new_window(_: &AnyObject, _: Sel, _sender: *mut AnyObject) {
    let Some(app) = APP.get().cloned() else { return };
    // Off AppKit's menu tracking, like the profile switch: a window is created from a thread.
    std::thread::spawn(move || {
        if let Err(e) = crate::windows::open_new(&app, Vec::new()) {
            eprintln!("[aicode] could not open a new window: {e}");
        }
    });
}

/// Gives the Dock icon its menu. Call from setup, on the main thread.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else { return };
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate: *mut AnyObject = unsafe { msg_send![&ns_app, delegate] };
    let Some(delegate) = (unsafe { delegate.as_ref() }) else { return };
    let cls = delegate.class() as *const AnyClass as *mut AnyClass;
    unsafe {
        let menu_imp: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> *mut NSMenu = dock_menu;
        let action_imp: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) = new_window;
        objc2::ffi::class_addMethod(cls, sel!(applicationDockMenu:), std::mem::transmute::<_, Imp>(menu_imp), c"@@:@".as_ptr());
        objc2::ffi::class_addMethod(cls, sel!(aicodeNewWindow:), std::mem::transmute::<_, Imp>(action_imp), c"v@:@".as_ptr());
    }
}

/// Adds a folder or file to the system's recent list (the Dock menu, Apple menu ▸ Recent Items).
pub fn note_recent(app: &AppHandle, path: String) {
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&url);
    });
}

pub fn clear_recent(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        unsafe { NSDocumentController::sharedDocumentController(mtm).clearRecentDocuments(None) };
    });
}
