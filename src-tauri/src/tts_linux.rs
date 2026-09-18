use std::process::{Command, Stdio};

pub fn linux_tts_speak(text: &str) -> Result<(), String> {
    let mut child = Command::new("spd-say")
        .arg(text)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spd-say: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

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
    if let Ok(mut child) = Command::new("killall")
        .arg("spd-say")
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
