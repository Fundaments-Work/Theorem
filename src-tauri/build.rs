use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    tauri_build::build();
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let repo = Path::new(&manifest_dir).join("..");

    // Resolve the .git directory (a real directory, or a "gitdir:" pointer
    // for worktrees/submodules).
    fn git_dir(repo: &Path) -> Option<PathBuf> {
        let dot_git = repo.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        let pointer = std::fs::read_to_string(&dot_git).ok()?;
        pointer.trim().strip_prefix("gitdir: ").map(PathBuf::from)
    }

    fn read_head(git: &Path) -> Option<(String, PathBuf)> {
        let head_path = git.join("HEAD");
        let head = std::fs::read_to_string(&head_path).ok()?;
        match head.trim().strip_prefix("ref: ") {
            Some(ref_name) => {
                let ref_path = git.join(ref_name);
                let hash = std::fs::read_to_string(&ref_path).ok()?;
                Some((hash.trim().to_string(), ref_path))
            }
            // Detached HEAD: the file holds the raw commit hash.
            None => Some((head.trim().to_string(), head_path.clone())),
        }
    }

    // Prefer reading .git directly (no subprocess, works in sandboxes); fall
    // back to `git` for layouts the reader can't resolve (e.g. packed-refs).
    let mut hash = None;
    let mut commit_ts: Option<u64> = None;
    if let Some(git) = git_dir(&repo) {
        if let Some((full_hash, ref_path)) = read_head(&git) {
            println!("cargo:rerun-if-changed={}", git.join("HEAD").display());
            println!("cargo:rerun-if-changed={}", ref_path.display());
            if full_hash.len() >= 40 {
                hash = Some(full_hash[..10].to_string());
                commit_ts = std::fs::metadata(&ref_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
            }
        }
    }
    if hash.is_none() {
        let output = Command::new("git")
            .args(["log", "-1", "--format=%h %ct"])
            .current_dir(&repo)
            .output()
            .ok()
            .filter(|o| o.status.success());
        if let Some(out) = output {
            let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let mut parts = line.split_whitespace();
            hash = parts.next().map(|h| h.to_string());
            commit_ts = parts.next().and_then(|t| t.parse().ok());
        }
    }

    let hash = hash.unwrap_or_else(|| "unknown".to_string());
    // Commit time (UTC) — stable per source tree, so the stamp identifies the
    // exact source the release binary was built from.
    let date = commit_ts
        .map(|ts| {
            let days = (ts / 86_400) as i64;
            let (y, m, d) = civil_from_days(days);
            format!("{y:04}-{m:02}-{d:02}")
        })
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=THEOREM_GIT_HASH={hash}");
    println!("cargo:rustc-env=THEOREM_BUILD_DATE={date}");
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
