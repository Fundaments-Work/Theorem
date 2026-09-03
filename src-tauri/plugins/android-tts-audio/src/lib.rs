use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "work.fundamentals.theorem.ttsaudio";

#[cfg(target_os = "android")]
struct TtsAudioPluginState<R: Runtime> {
    handle: tauri::plugin::PluginHandle<R>,
}

#[cfg(target_os = "android")]
fn get_audio_state<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::State<'_, TtsAudioPluginState<R>>, String> {
    app.try_state::<TtsAudioPluginState<R>>()
        .ok_or_else(|| "Android TTS plugin is not initialized.".to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-tts-audio")
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            {
                let _ = (&app, &api);
            }
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "TtsAudioPlugin")?;
                app.manage(TtsAudioPluginState { handle });
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub fn tts_speak<R: Runtime>(
    app: &AppHandle<R>,
    text: String,
    voice: String,
) -> Result<(), String> {
    let state = get_audio_state(app)?;
    state
        .handle
        .run_mobile_plugin::<serde_json::Value>(
            "speak",
            serde_json::json!({ "text": text, "voice": voice }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn tts_speak<R: Runtime>(
    _app: &AppHandle<R>,
    _text: String,
    _voice: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "android")]
pub fn tts_stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = get_audio_state(app)?;
    state
        .handle
        .run_mobile_plugin::<serde_json::Value>("stop", serde_json::json!({}))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn tts_stop<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "android")]
pub fn tts_get_voices<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<serde_json::Value>, String> {
    let state = get_audio_state(app)?;
    let result: serde_json::Value = state
        .handle
        .run_mobile_plugin("getVoices", serde_json::json!({}))
        .map_err(|error| error.to_string())?;
    let voices_json = result["voicesJson"].as_str().unwrap_or("[]");
    serde_json::from_str(voices_json).map_err(|e| format!("Failed to parse voices: {e}"))
}

#[cfg(not(target_os = "android"))]
pub fn tts_get_voices<R: Runtime>(_app: &AppHandle<R>) -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "android")]
pub fn tts_get_engines<R: Runtime>(app: &AppHandle<R>) -> Result<serde_json::Value, String> {
    let state = get_audio_state(app)?;
    state
        .handle
        .run_mobile_plugin("getEngines", serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn tts_get_engines<R: Runtime>(_app: &AppHandle<R>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "enginesJson": "[]", "currentEngine": "" }))
}

#[cfg(target_os = "android")]
pub fn tts_set_engine<R: Runtime>(
    app: &AppHandle<R>,
    engine: String,
) -> Result<serde_json::Value, String> {
    let state = get_audio_state(app)?;
    state
        .handle
        .run_mobile_plugin("setEngine", serde_json::json!({ "engine": engine }))
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn tts_set_engine<R: Runtime>(
    _app: &AppHandle<R>,
    _engine: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "engine": "" }))
}

#[cfg(target_os = "android")]
pub fn tts_synthesize_to_file<R: Runtime>(
    app: &AppHandle<R>,
    text: String,
    voice: String,
    file_name: String,
) -> Result<serde_json::Value, String> {
    let state = get_audio_state(app)?;
    state
        .handle
        .run_mobile_plugin(
            "synthesizeToFile",
            serde_json::json!({ "text": text, "voice": voice, "fileName": file_name }),
        )
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn tts_synthesize_to_file<R: Runtime>(
    _app: &AppHandle<R>,
    _text: String,
    _voice: String,
    _file_name: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "done": false }))
}
