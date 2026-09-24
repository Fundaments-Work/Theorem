//! WASM bindings exported to JavaScript/WebAssembly via wasm-bindgen.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_markdown_to_html(markdown: &str) -> String {
    crate::markdown::markdown_to_html(markdown)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_fuzzy_rank(candidates_json: &str, query: &str) -> Result<String, JsValue> {
    let candidates: Vec<crate::fuzzy::FuzzyCandidate> = serde_json::from_str(candidates_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid candidates JSON: {e}")))?;
    let results = crate::fuzzy::rank_candidates(&candidates, query);
    serde_json::to_string(&results)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {e}")))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_normalize_speech_text(text: &str, lang: Option<String>) -> String {
    let language = lang.as_deref().unwrap_or("en");
    crate::text_normalizer::normalize_speech_text(text, language)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_number_to_words(n: u64) -> String {
    crate::text_normalizer::number_to_words(n)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_ordinal_to_words(n: u64) -> String {
    crate::text_normalizer::ordinal_to_words(n)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_year_to_words(year: u32) -> Option<String> {
    crate::text_normalizer::year_to_words(year)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_safe_vault_filename(title: &str) -> String {
    crate::vault::safe_vault_filename(title)
}
