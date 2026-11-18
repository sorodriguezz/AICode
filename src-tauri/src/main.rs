// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `aicode -g file:12`, or the shim's `aicode --cli …`: the command line, not the app.
    if let Some(code) = aicode_lib::cli_main() {
        std::process::exit(code);
    }
    aicode_lib::run()
}
