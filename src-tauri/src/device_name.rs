//! The name this device shows to the devices it pairs with: the one the user
//! chose, or else the system's (the computer name, or the phone's maker and
//! model), so two paired devices are never both "Theorem Device".

use theorem_sync_core::sync_protocol::clean_device_name;

/// Used only when the system gives no name at all.
pub const FALLBACK_NAME: &str = "Theorem Device";

/// The system's name for this device.
pub fn system_device_name() -> String {
    platform_name()
        .and_then(|n| clean_device_name(&n))
        .unwrap_or_else(|| FALLBACK_NAME.to_string())
}

#[cfg(target_os = "android")]
fn platform_name() -> Option<String> {
    let manufacturer = android_property("ro.product.manufacturer");
    let model = android_property("ro.product.model")?;
    Some(phone_name(manufacturer.as_deref(), &model))
}

/// Maker and model ("Google Pixel 7"), or the model alone when it already
/// starts with the maker ("OnePlus 12").
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn phone_name(manufacturer: Option<&str>, model: &str) -> String {
    let model = model.trim();
    match manufacturer.map(str::trim).filter(|m| !m.is_empty()) {
        Some(maker) if !model.to_lowercase().starts_with(&maker.to_lowercase()) => {
            let mut chars = maker.chars();
            let maker = match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            };
            format!("{maker} {model}")
        }
        _ => model.to_string(),
    }
}

#[cfg(target_os = "android")]
fn android_property(name: &str) -> Option<String> {
    let key = std::ffi::CString::new(name).ok()?;
    // PROP_VALUE_MAX is 92 bytes including the terminator.
    let mut value = [0 as libc::c_char; 92];
    // SAFETY: `key` is NUL-terminated and `value` is PROP_VALUE_MAX bytes,
    // the most the function writes.
    let len = unsafe { libc::__system_property_get(key.as_ptr(), value.as_mut_ptr()) };
    if len <= 0 {
        return None;
    }
    // SAFETY: the function NUL-terminates what it wrote.
    let value = unsafe { std::ffi::CStr::from_ptr(value.as_ptr()) };
    Some(value.to_string_lossy().into_owned()).filter(|v| !v.trim().is_empty())
}

#[cfg(target_os = "linux")]
fn platform_name() -> Option<String> {
    // The "pretty" name the desktop shows (Settings → About), if set.
    let pretty = std::fs::read_to_string("/etc/machine-info")
        .ok()
        .and_then(|info| pretty_hostname(&info));
    pretty.or_else(|| {
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(linux_hostname)
    })
}

#[cfg(target_os = "linux")]
fn linux_hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer and its length match; gethostname writes at most that.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned()).filter(|s| !s.is_empty())
}

/// `PRETTY_HOSTNAME=...` from systemd's machine-info, unquoted.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn pretty_hostname(machine_info: &str) -> Option<String> {
    machine_info.lines().find_map(|line| {
        let value = line.trim().strip_prefix("PRETTY_HOSTNAME=")?.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        Some(value.to_string()).filter(|v| !v.trim().is_empty())
    })
}

#[cfg(target_os = "macos")]
fn platform_name() -> Option<String> {
    // The name from System Settings → General → Sharing.
    let out = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "windows")]
fn platform_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(
    target_os = "android",
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
)))]
fn platform_name() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_are_named_by_maker_and_model() {
        assert_eq!(phone_name(Some("Google"), "Pixel 7"), "Google Pixel 7");
        assert_eq!(phone_name(Some("samsung"), "SM-S918B"), "Samsung SM-S918B");
        assert_eq!(phone_name(Some("OnePlus"), "OnePlus 12"), "OnePlus 12");
        assert_eq!(phone_name(Some("  "), "Pixel 7"), "Pixel 7");
        assert_eq!(
            phone_name(None, " sdk_gphone64_x86_64 "),
            "sdk_gphone64_x86_64"
        );
    }

    #[test]
    fn the_pretty_hostname_is_read_quoted_or_not() {
        assert_eq!(
            pretty_hostname("CHASSIS=laptop\nPRETTY_HOSTNAME=\"Ana's Laptop\"\n").as_deref(),
            Some("Ana's Laptop")
        );
        assert_eq!(
            pretty_hostname("PRETTY_HOSTNAME=Study PC").as_deref(),
            Some("Study PC")
        );
        assert_eq!(pretty_hostname("PRETTY_HOSTNAME=\"\""), None);
        assert_eq!(pretty_hostname("CHASSIS=desktop"), None);
    }

    #[test]
    fn there_is_always_a_name() {
        let name = system_device_name();
        assert!(!name.trim().is_empty());
        assert!(name.chars().count() <= theorem_sync_core::sync_protocol::MAX_DEVICE_NAME_CHARS);
    }
}
