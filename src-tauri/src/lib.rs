mod log_watcher;
mod scanner;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[tauri::command]
fn set_overlay_mode(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let _ = window.set_ignore_cursor_events(false);
    window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    if enabled {
        let _ = window.set_title("Tarkov Planner — OVERLAY");
    } else {
        let _ = window.set_title("Tarkov Planner");
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

// Internal: runs on the Tauri main thread. Called both by the async `open_scanner_popout`
// command and by the Alt+P global-shortcut handler.
fn open_scanner_popout_on_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("scanner-popout") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "scanner-popout", WebviewUrl::App("index.html?window=scanner-popout".into()))
        .title("Scanner")
        .inner_size(340.0, 170.0)
        .min_inner_size(260.0, 130.0)
        .always_on_top(true)
        .resizable(true)
        .decorations(true)
        .build();
}

// Async so it runs on Tauri's task pool rather than blocking the IPC thread,
// and dispatches the actual window build to the main thread. Calling
// WebviewWindowBuilder::build() synchronously from a sync command was
// deadlocking the new webview before it could load its JS (symptom: popout
// opens as an unresponsive white window).
#[tauri::command]
async fn open_scanner_popout(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || open_scanner_popout_on_main(&handle))
        .map_err(|e| e.to_string())
}

// Same pattern as scanner-popout: separate always-on-top webview so the task
// map can stay visible over Tarkov while the scanner is closed (or vice
// versa). Runs on main thread to avoid the sync-command webview-build
// deadlock.
fn open_task_map_popout_on_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("task-map-popout") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        "task-map-popout",
        WebviewUrl::App("index.html?window=task-map-popout".into()),
    )
    .title("Task Map")
    .inner_size(420.0, 460.0)
    .min_inner_size(320.0, 360.0)
    .always_on_top(true)
    .resizable(true)
    .decorations(true)
    .build();
}

#[tauri::command]
async fn open_task_map_popout(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || open_task_map_popout_on_main(&handle))
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            set_overlay_mode,
            set_click_through,
            scanner::scan_at_cursor,
            scanner::capture_rgba_at_cursor,
            scanner::ocr_tooltip_region,
            scanner::ocr_full_screen,
            open_scanner_popout,
            open_task_map_popout,
            log_watcher::detect_tarkov_logs_dir,
            log_watcher::scan_logs_dir,
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
                    open_scanner_popout_on_main(h);
                }
            })?;

            // Alt+M: toggle task map popout window
            register(app.handle(), Code::KeyM, |h| {
                if let Some(w) = h.get_webview_window("task-map-popout") {
                    let _ = w.close();
                } else {
                    open_task_map_popout_on_main(h);
                }
            })?;

            // Ctrl+Alt+T: task list scanner — emits an event to the main
            // window so the React side can run the OCR + fuzzy-match flow.
            // Also show+focus the main window so the preview modal is
            // immediately visible when the user Alt+Tabs back from Tarkov.
            {
                let handle = app.handle().clone();
                let shortcut = Shortcut::new(
                    Some(Modifiers::CONTROL | Modifiers::ALT),
                    Code::KeyT,
                );
                app.global_shortcut()
                    .on_shortcut(shortcut, move |_app, _sc, event| {
                        if event.state == ShortcutState::Pressed {
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.emit("task-scan-start", ());
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
