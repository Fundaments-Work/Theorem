use crate::tts_desktop::spd_say_args;
use std::process::{Command, Stdio};

/// Queues `text` in speech-dispatcher. The text is passed after `--` so a page
/// that begins with `-` is spoken, not parsed as an `spd-say` option.
pub fn linux_tts_speak(text: &str, speed: Option<f32>) -> Result<(), String> {
    let mut child = Command::new("spd-say")
        .args(spd_say_args(text, speed))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spd-say: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// `spd-say` only hands text to the speech-dispatcher daemon and exits, so
/// cancelling means asking the daemon — killing `spd-say` processes by name
/// would not stop the speech and could hit unrelated invocations.
pub fn linux_tts_stop() -> Result<(), String> {
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
