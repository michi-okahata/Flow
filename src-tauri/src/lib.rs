pub mod cmir;
pub mod docx;
pub mod files;
pub mod relay;
pub mod store;

use tauri::Manager;
// Only the close handler emits, and only on macOS is there a close handler.
#[cfg(target_os = "macos")]
use tauri::Emitter;

/// The label the config's one window answers to, having not named itself.
#[cfg(target_os = "macos")]
const MAIN_WINDOW: &str = "main";

/// What the frontend is told when the window is being put away, so that the
/// write it had queued lands now rather than into a window nobody can see.
/// Listened for in `useLibrary`.
#[cfg(target_os = "macos")]
const CLOSING_EVENT: &str = "flow://closing";

/// Start hosting a relay in this app, and report where peers can reach it.
///
/// Idempotent: asking twice gives back the relay you already have, because the
/// frontend calls this whenever it wants to be sure hosting is on and should
/// not have to keep track of whether it already asked.
#[tauri::command]
async fn relay_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, relay::RelayState>,
    port: Option<u16>,
) -> Result<relay::RelayInfo, String> {
    if let Some(running) = state.0.lock().unwrap().as_ref() {
        return Ok(running.info.clone());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("rooms");

    let running = relay::start(port.unwrap_or(relay::DEFAULT_PORT), dir).await?;
    let info = running.info.clone();
    // Another call could have won the race between the check above and here.
    // Whoever is already in the slot stays, and ours shuts itself down as it
    // drops at the end of this scope.
    let mut slot = state.0.lock().unwrap();
    match slot.as_ref() {
        Some(existing) => Ok(existing.info.clone()),
        None => {
            slot.replace(running);
            Ok(info)
        }
    }
}

/// Stop hosting. Rooms are written out on the way down — see `RunningRelay`.
#[tauri::command]
fn relay_stop(state: tauri::State<'_, relay::RelayState>) {
    state.0.lock().unwrap().take();
}

/// Where this app is hosting, or null if it isn't.
#[tauri::command]
fn relay_info(state: tauri::State<'_, relay::RelayState>) -> Option<relay::RelayInfo> {
    state.0.lock().unwrap().as_ref().map(|r| r.info.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(relay::RelayState::default())
        // Closing the window and quitting are two different things, and a
        // round is a document: ⌘W puts it away, ⌘Q is what ends the session.
        // Hiding rather than destroying is what makes the first survivable —
        // an unsaved flow, a room this peer is hosting and the cursor are all
        // still there when the dock icon brings the window back, because the
        // webview never went anywhere.
        //
        // macOS only. Everywhere else the window *is* the app: there is no
        // dock to bring it back from, and hiding it would leave a process
        // running with nothing left that could reach it.
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                api.prevent_close();
                // Before the hide, not after: a hidden webview is a webview
                // the system is free to stop running timers for, and the
                // pending autosave is a timer.
                let _ = _window.emit(CLOSING_EVENT, ());
                let _ = _window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            relay_start,
            relay_stop,
            relay_info,
            files::files_pick_directory,
            files::files_pick_file,
            files::files_pick_export,
            files::files_read_dir,
            files::files_write,
            files::files_remove,
            store::store_config,
            store::store_seed_config,
            store::store_transcript,
            store::store_memorized,
            store::store_imported,
            store::store_context,
            store::store_memorize,
            store::store_rename_position,
            store::store_import,
            store::store_import_file,
            store::store_forget_imports,
            store::store_export_speech,
            cmir::cmir_read_dir,
            cmir::cmir_read_file,
            cmir::cmir_read_speech,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // `run` rather than `Builder::run`, only so that there is somewhere to
    // answer the dock icon from.
    app.run(|_handle, _event| {
        // The dock icon, clicked with the window hidden — the way back in, and
        // the only one. ⌘Tab activates the app without asking it for a window,
        // which is what every other document app on the machine does too.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            if let Some(window) = _handle.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}
