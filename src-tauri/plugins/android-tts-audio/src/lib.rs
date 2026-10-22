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

/// One `speak` request: the page text plus how to say it.
#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeakRequest {
    pub text: String,
    /// Engine voice name; empty for the engine's default.
    pub voice: String,
    /// Speech rate (1.0 = normal), applied on every speak.
    pub speed: Option<f32>,
    /// BCP 47 language of the book; the engine's default when absent or unavailable.
    pub lang: Option<String>,
    /// Echoed in the utterance events so the app can ignore stale ones.
    pub utterance_id: Option<String>,
}

/// Speaks the request; resolves with `{ pieces, languageWarning? }`.
#[cfg(target_os = "android")]
pub fn tts_speak<R: Runtime>(
    app: &AppHandle<R>,
    request: SpeakRequest,
) -> Result<serde_json::Value, String> {
    let state = get_audio_state(app)?;
    state
        .handle
        .run_mobile_plugin::<serde_json::Value>("speak", request)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn tts_speak<R: Runtime>(
    _app: &AppHandle<R>,
    _request: SpeakRequest,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Null)
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

#[cfg(test)]
mod tests {
    use super::SpeakRequest;

    /// Field names must match `SpeakArgs` in TtsAudioPlugin.kt.
    #[test]
    fn speak_request_matches_the_kotlin_args() {
        let request = SpeakRequest {
            text: "Bonjour.".into(),
            voice: String::new(),
            speed: Some(1.5),
            lang: Some("fr".into()),
            utterance_id: Some("theorem-1".into()),
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({
                "text": "Bonjour.",
                "voice": "",
                "speed": 1.5,
                "lang": "fr",
                "utteranceId": "theorem-1",
            })
        );
        let empty = serde_json::to_value(SpeakRequest::default()).unwrap();
        assert_eq!(empty["speed"], serde_json::Value::Null);
        assert_eq!(empty["lang"], serde_json::Value::Null);
    }
}
