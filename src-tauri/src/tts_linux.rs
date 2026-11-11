use crate::tts_desktop::{spawn_tracked, spd_say_pipe_args, stop_tracked, SpeechEnd};
use std::process::{Command, Stdio};

/// Speaks `text` through speech-dispatcher in pipe mode (`-w -e`) so arbitrary-length
/// pages stream over stdin without hitting Linux `MAX_ARG_STRLEN` (`E2BIG`).
/// Leading `-` characters are spoken literally rather than parsed as options.
pub fn linux_tts_speak(
    text: &str,
    speed: Option<f32>,
    lang: Option<&str>,
    on_end: impl FnOnce(SpeechEnd) + Send + 'static,
) -> Result<(), String> {
    let mut cmd = Command::new("spd-say");
    cmd.args(spd_say_pipe_args(speed, lang));
    let mut stdin_text = text.to_string();
    if !stdin_text.ends_with('\n') {
        stdin_text.push('\n');
    }
    spawn_tracked(cmd, Some(stdin_text), on_end).map_err(|e| format!("spd-say: {e}"))
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
