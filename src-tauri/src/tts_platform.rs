//! Platform (OS voice) narration commands.

#[cfg(not(target_os = "android"))]
use crate::tts_desktop;
#[cfg(target_os = "linux")]
use crate::tts_linux;

/// Speak `text` with the platform voice. `utterance_id` is echoed in the
/// utterance events so stale ones can be told apart. `lang` (the book's
/// language) is used on Android and Linux; on Android the result may carry a
/// `languageWarning` when the engine has no voice for `lang`. Desktop OS
/// voices answer `completionEvents: true`: `tts-utterance-done` (or
/// `tts-utterance-error`) follows when the narration process exits.
#[tauri::command]
#[allow(unused_variables, unreachable_code)]
pub(crate) fn tts_speak(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    speed: Option<f32>,
    lang: Option<String>,
    utterance_id: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return tauri_plugin_android_tts_audio::tts_speak(
        &app,
        tauri_plugin_android_tts_audio::SpeakRequest {
            text,
            voice,
            speed,
            lang,
            utterance_id,
        },
    );
    #[cfg(not(target_os = "android"))]
    let on_end = tts_desktop::emit_utterance_end(app, utterance_id);
    #[cfg(target_os = "linux")]
    tts_linux::linux_tts_speak(&text, speed, lang.as_deref(), on_end)?;
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("say");
        cmd.args(tts_desktop::mac_say_args(&text, &voice, speed));
        tts_desktop::spawn_tracked(cmd, None, on_end).map_err(|e| format!("say: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            tts_desktop::WINDOWS_SPEECH_SCRIPT,
        ])
        .env(
            "THEOREM_TTS_RATE",
            tts_desktop::windows_rate(speed).to_string(),
        )
        .env("THEOREM_TTS_VOICE", &voice);
        tts_desktop::spawn_tracked(cmd, Some(text), on_end).map_err(|e| format!("TTS: {e}"))?;
    }
    Ok(serde_json::json!({ "completionEvents": true }))
}

#[tauri::command]
#[allow(unused_variables, unreachable_code)]
pub(crate) fn tts_stop(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return tauri_plugin_android_tts_audio::tts_stop(&app);
    #[cfg(target_os = "linux")]
    return tts_linux::linux_tts_stop();
    // macOS/Windows: stop only the narration process we started.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    tts_desktop::stop_tracked();
    Ok(())
}

#[tauri::command]
pub(crate) fn tts_pause(app: tauri::AppHandle) -> Result<(), String> {
    tts_stop(app)
}

#[tauri::command]
pub(crate) fn tts_resume(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub(crate) fn tts_get_engines(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri_plugin_android_tts_audio::tts_get_engines(&app)
}

#[tauri::command]
#[allow(unused_variables)]
pub(crate) fn tts_set_engine(
    app: tauri::AppHandle,
    engine: String,
) -> Result<serde_json::Value, String> {
    tauri_plugin_android_tts_audio::tts_set_engine(&app, engine)
}

#[tauri::command]
#[allow(unused_variables)]
pub(crate) async fn tts_synthesize_to_file(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    file_name: String,
) -> Result<serde_json::Value, String> {
    tauri_plugin_android_tts_audio::tts_synthesize_to_file(&app, text, voice, file_name)
}

#[allow(unused_variables, unreachable_code)]
pub(crate) fn tts_get_voices(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "android")]
    return tauri_plugin_android_tts_audio::tts_get_voices(&app);
    let _ = app;
    Ok(Vec::new())
}
