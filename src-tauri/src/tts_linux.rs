use crate::tts_desktop::{spawn_tracked, spd_say_args, stop_tracked, SpeechEnd};
use std::process::{Command, Stdio};

/// Speaks `text` through speech-dispatcher. The text is passed after `--` so a
/// page that begins with `-` is spoken, not parsed as an `spd-say` option.
/// `spd-say -w` stays alive until the speech ends, so the tracked process's
/// exit is the real end of the utterance, and `on_end` reports it.
pub fn linux_tts_speak(
    text: &str,
    speed: Option<f32>,
    lang: Option<&str>,
    on_end: impl FnOnce(SpeechEnd) + Send + 'static,
) -> Result<(), String> {
    let mut cmd = Command::new("spd-say");
    cmd.args(spd_say_args(text, speed, lang));
    spawn_tracked(cmd, None, on_end).map_err(|e| format!("spd-say: {e}"))
}

/// Drops our waiting `spd-say -w` first (so it reports no end), then asks the
/// daemon to cancel: the daemon is what speaks, and killing `spd-say`
/// processes by name could hit unrelated invocations.
pub fn linux_tts_stop() -> Result<(), String> {
    stop_tracked();
    if let Ok(mut child) = Command::new("spd-say")
        .arg("--cancel")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}
