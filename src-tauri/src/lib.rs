mod scanner;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[tauri::command]
fn set_overlay_mode(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let _ = window.set_ignore_cursor_events(false);
    window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    if enabled {
        let _ = window.set_title("Tarkov Guide — OVERLAY");
    } else {
        let _ = window.set_title("Tarkov Guide");
    }
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_scanner_popout(app: tauri::AppHandle) -> Result<(), String> {
    // If already open, just focus it
    if let Some(w) = app.get_webview_window("scanner-popout") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "scanner-popout", WebviewUrl::App("index.html".into()))
        .title("Scanner")
        .inner_size(340.0, 220.0)
        .min_inner_size(280.0, 160.0)
        .always_on_top(true)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn close_scanner_popout(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("scanner-popout") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_overlay_mode,
            set_click_through,
            scanner::scan_at_cursor,
            open_scanner_popout,
            close_scanner_popout,
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::ShortcutState;

            // Clear any stale registrations (survives a prior crashed instance
            // that didn't release its hotkeys) so our registers below don't
            // silently fail on a "hotkey already registered" error.
            let _ = app.global_shortcut().unregister_all();

            fn register<F>(
                app: &tauri::AppHandle,
                code: Code,
                handler: F,
            ) -> Result<(), tauri_plugin_global_shortcut::Error>
            where
                F: Fn(&tauri::AppHandle) + Send + Sync + 'static,
            {
                let handle = app.clone();
                let shortcut = Shortcut::new(Some(Modifiers::ALT), code);
                app.global_shortcut()
                    .on_shortcut(shortcut, move |_app, _sc, event| {
                        if event.state == ShortcutState::Pressed {
                            handler(&handle);
                        }
                    })
            }

            // Alt+T: toggle main window visibility
            register(app.handle(), Code::KeyT, |h| {
                if let Some(window) = h.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })?;

            // Alt+O: toggle overlay mode (frontend handles via event)
            register(app.handle(), Code::KeyO, |h| {
                if let Some(window) = h.get_webview_window("main") {
                    let _ = window.emit("toggle-overlay", ());
                }
            })?;

            // Alt+S: toggle auto-scan (fanout to main + popout)
            register(app.handle(), Code::KeyS, |h| {
                if let Some(window) = h.get_webview_window("main") {
                    let _ = window.emit("toggle-scan", ());
                }
                if let Some(window) = h.get_webview_window("scanner-popout") {
                    let _ = window.emit("toggle-scan", ());
                }
            })?;

            // Alt+P: toggle scanner popout window
            register(app.handle(), Code::KeyP, |h| {
                if let Some(w) = h.get_webview_window("scanner-popout") {
                    let _ = w.close();
                } else {
                    let _ = open_scanner_popout(h.clone());
                }
            })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
