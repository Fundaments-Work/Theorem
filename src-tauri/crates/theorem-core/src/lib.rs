//! Theorem Core: Pure computational algorithms for Theorem reader & sync.
//!
//! Provides:
//! - Safe Markdown-to-HTML conversion via pulldown-cmark
//! - SIMD-accelerated fuzzy matching via nucleo-matcher
//! - Deterministic speech text normalization
//! - Safe PKM note formatting & YAML frontmatter
//! - WebAssembly bindings via wasm-bindgen

pub mod fuzzy;
pub mod markdown;
pub mod text_normalizer;
pub mod vault;
pub mod wasm;

pub use fuzzy::{rank_candidates, score_field, FuzzyCandidate, FuzzyMatchResult};
pub use markdown::markdown_to_html;
pub use text_normalizer::{
    normalize_speech_text, number_to_words, ordinal_to_words, year_to_words,
};
pub use vault::{build_frontmatter, safe_vault_filename};
