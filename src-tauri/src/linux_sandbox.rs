//! Is the app running inside Flatpak, and under which ID?
//!
//! The Flatpak ID may differ from the Tauri identifier (which names the data
//! folder and never changes), so D-Bus names and host-visible paths inside the
//! sandbox are built from this ID. See `docs/DISTRIBUTION.md`.

/// The Flatpak ID the app runs under, or `None` outside Flatpak.
pub(crate) fn flatpak_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        // Flatpak writes this file at the root of every sandbox. The variable
        // alone is not proof: a child of another Flatpak inherits it.
        let in_sandbox = std::path::Path::new("/.flatpak-info").exists();
        valid_flatpak_id(in_sandbox, std::env::var("FLATPAK_ID").ok().as_deref())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// The ID when the sandbox marker is there and the ID is well formed (it ends
/// up in a D-Bus name and in a path).
#[cfg(target_os = "linux")]
fn valid_flatpak_id(in_sandbox: bool, id: Option<&str>) -> Option<String> {
    let id = id.filter(|_| in_sandbox)?;
    let well_formed = id.len() <= 255
        && id.split('.').count() >= 3
        && id.split('.').all(|part| {
            part.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        });
    well_formed.then(|| id.to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::valid_flatpak_id;

    #[test]
    fn the_id_counts_only_inside_a_sandbox() {
        let id = Some("work.fundaments.theorem");
        assert_eq!(valid_flatpak_id(true, id).as_deref(), id);
        assert_eq!(valid_flatpak_id(false, id), None);
        assert_eq!(valid_flatpak_id(true, None), None);
    }

    #[test]
    fn a_malformed_id_is_ignored() {
        let long = format!("a.b.{}", "c".repeat(255));
        for id in [
            "",
            "theorem",
            "a.b",
            "a..b",
            ".a.b.c",
            "a.b.c.",
            "a.b.1c",
            "a.b.c/../d",
            "a.b.c d",
            "a.b.é",
            long.as_str(),
        ] {
            assert_eq!(valid_flatpak_id(true, Some(id)), None, "{id:?}");
        }
    }

    #[test]
    fn underscores_and_dashes_are_accepted() {
        let id = Some("io.github.fundaments_work.Theorem-beta");
        assert_eq!(valid_flatpak_id(true, id).as_deref(), id);
    }
}
