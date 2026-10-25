//! Installing the `theorem` command (Settings → Terminal CLI and `theorem setup-cli`).

#[cfg(target_os = "linux")]
use std::path::PathBuf;

/// Tauri command backing the "Enable CLI" toggle. Creates (or refreshes) a
/// `theorem` symlink in `~/.local/bin` pointing at the running executable.
#[tauri::command]
pub(crate) fn setup_linux_cli_symlink() -> Result<String, String> {
    setup_linux_cli_symlink_inner()
}

pub fn setup_linux_cli_symlink_inner() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let exe = cli_symlink_target_exe()?;
        let link = cli_symlink_path()?;

        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let _ = std::fs::remove_file(&link);
            }
            Ok(_) => {
                let link_target = std::fs::canonicalize(&link).ok();
                let exe_target = std::fs::canonicalize(&exe).ok();
                if link_target.is_some() && link_target == exe_target {
                    return Ok(link.display().to_string());
                }
                return Err(format!(
                    "Refusing to overwrite existing file {} (not a Theorem symlink)",
                    link.display()
                ));
            }
            Err(_) => {}
        }

        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        std::os::unix::fs::symlink(&exe, &link).map_err(|e| {
            format!(
                "Failed to symlink {} -> {}: {e}",
                link.display(),
                exe.display()
            )
        })?;
        Ok(link.display().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}

/// AppImage note: `current_exe` inside an AppImage points into the temporary
/// squashfs mount, which disappears on reboot — symlink the AppImage file
/// itself (`$APPIMAGE`) when available so the link survives.
#[cfg(all(target_os = "linux", not(target_os = "android")))]
fn cli_symlink_target_exe() -> Result<PathBuf, String> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if !appimage.is_empty() {
            return Ok(PathBuf::from(appimage));
        }
    }
    let exe =
        std::env::current_exe().map_err(|e| format!("Failed to resolve executable path: {e}"))?;
    // Dev builds load the UI from the Vite dev server (localhost:1420) and
    // break for normal use the moment `pnpm dev:tauri` stops. Never symlink
    // one: prefer the installed AppImage if present, or fall back to the workspace's
    // release binary if it exists.
    if exe.parent().is_some_and(|p| p.ends_with("debug")) {
        if let Ok(home) = std::env::var("HOME") {
            let appimage = PathBuf::from(home)
                .join(".local")
                .join("lib")
                .join("theorem")
                .join("Theorem.AppImage");
            if appimage.exists() {
                return Ok(appimage);
            }
        }
        if let Some(name) = exe.file_name() {
            if let Some(release) = exe
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.join("release").join(name))
            {
                if release.exists() {
                    return Ok(release);
                }
            }
        }
        return Err(
            "Refusing to symlink a debug build (it loads the UI from the dev \
             server). Build a release binary first: `pnpm tauri build`."
                .to_string(),
        );
    }
    Ok(exe)
}

/// Tauri command: current CLI symlink status for the Settings UI.
pub(crate) fn cli_setup_status() -> Result<CliSetupStatus, String> {
    cli_setup_status_inner()
}

#[derive(serde::Serialize)]
pub struct CliSetupStatus {
    /// A valid `theorem` symlink exists in ~/.local/bin
    installed: bool,
    link_path: String,
    is_app_image: bool,
}

fn cli_setup_status_inner() -> Result<CliSetupStatus, String> {
    #[cfg(target_os = "linux")]
    {
        let link = cli_symlink_path()?;
        let installed = std::fs::symlink_metadata(&link)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        Ok(CliSetupStatus {
            installed,
            link_path: link.display().to_string(),
            is_app_image: std::env::var("APPIMAGE")
                .map(|v| !v.is_empty())
                .unwrap_or(false),
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}

/// Tauri command: remove the ~/.local/bin/theorem symlink (toggle OFF).
#[tauri::command]
pub(crate) fn remove_linux_cli_symlink() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let link = cli_symlink_path()?;
        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                std::fs::remove_file(&link)
                    .map_err(|e| format!("Failed to remove {}: {e}", link.display()))?;
                Ok(())
            }
            Ok(_) => Err(format!(
                "Refusing to remove {}: not a Theorem symlink",
                link.display()
            )),
            Err(_) => Ok(()),
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}

#[cfg(all(target_os = "linux", not(target_os = "android")))]
fn cli_symlink_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("bin")
        .join("theorem"))
}
