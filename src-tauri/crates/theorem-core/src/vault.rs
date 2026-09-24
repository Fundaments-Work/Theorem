//! Vault formatting and export utilities for Theorem PKM notes.

/// Sanitizes a title for safe cross-platform note filenames (Obsidian, Logseq, etc.).
pub fn safe_vault_filename(title: &str) -> String {
    let sanitized: String = title
        .chars()
        .map(|c| match c {
            ':' | '/' | '\\' | '<' | '>' | '"' | '|' | '?' | '*' => '-',
            c => c,
        })
        .collect();

    let trimmed = sanitized.trim().trim_matches(['.', '-', ' ']);
    if trimmed.is_empty() {
        "Untitled Note".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Generates YAML frontmatter string for markdown notes.
pub fn build_frontmatter(title: &str, author: Option<&str>, tags: &[String]) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("title: \"{}\"\n", escape_yaml_string(title)));
    if let Some(auth) = author {
        out.push_str(&format!("author: \"{}\"\n", escape_yaml_string(auth)));
    }
    if !tags.is_empty() {
        out.push_str("tags:\n");
        for tag in tags {
            out.push_str(&format!("  - \"{}\"\n", escape_yaml_string(tag)));
        }
    }
    out.push_str("---\n");
    out
}

fn escape_yaml_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_filename() {
        assert_eq!(safe_vault_filename("Dune: Part 1?"), "Dune- Part 1");
        assert_eq!(safe_vault_filename(""), "Untitled Note");
    }

    #[test]
    fn test_build_frontmatter() {
        let fm = build_frontmatter("Test Title", Some("Frank Herbert"), &["scifi".into()]);
        assert!(fm.starts_with("---\n"));
        assert!(fm.contains("title: \"Test Title\"\n"));
        assert!(fm.contains("author: \"Frank Herbert\"\n"));
        assert!(fm.contains("tags:\n  - \"scifi\"\n"));
        assert!(fm.ends_with("---\n"));
    }
}
