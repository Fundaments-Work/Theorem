//! Crash-safe file writes used by the book cache.

use super::*;

/// Write `bytes` to a temporary file beside `path`, then rename it over
/// `path`: a reader sees the old file or the whole new one, never part.
pub(crate) fn replace_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = temporary_sibling(path);
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Write `bytes` to `path` only if nothing is there: written to a temporary
/// file first, then linked into place, which fails rather than replaces.
/// Returns whether the file was created.
pub(crate) fn create_file_if_absent(path: &Path, bytes: &[u8]) -> std::io::Result<bool> {
    let tmp = temporary_sibling(path);
    fs::write(&tmp, bytes)?;
    place_if_absent(&tmp, path)
}

/// `create_file_if_absent` with the bytes of `source`, streamed.
pub(crate) fn copy_file_if_absent(source: &Path, path: &Path) -> std::io::Result<bool> {
    let tmp = temporary_sibling(path);
    if let Err(e) = fs::copy(source, &tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    place_if_absent(&tmp, path)
}

fn temporary_sibling(path: &Path) -> PathBuf {
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    PathBuf::from(tmp_name)
}

/// Move the finished file `tmp` to `path` unless something is there already;
/// `tmp` is gone afterwards either way.
fn place_if_absent(tmp: &Path, path: &Path) -> std::io::Result<bool> {
    let placed = match fs::hard_link(tmp, path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        // No hard links on this file system: rename, still never over a file.
        Err(_) if !path.exists() => fs::rename(tmp, path).map(|()| true),
        Err(_) => Ok(false),
    };
    let _ = fs::remove_file(tmp);
    placed
}
