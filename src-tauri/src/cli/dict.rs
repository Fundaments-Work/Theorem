//! `theorem dict`: offline dictionaries first, then the online fallback.

use super::*;

pub(super) fn run_dict(output: &Output, ctx: &Ctx, term: &str, online: bool) -> i32 {
    let started = std::time::Instant::now();
    let stardict_results = crate::stardict::lookup_all_installed(ctx.dir(), term);
    let mdx_results = mdx_lookup_all_installed(ctx, term);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;

    let online_result = if online {
        match block_on(|| crate::fetch_online_definition(term.to_string())) {
            Ok(value) => Some(value),
            Err(e) => {
                output.note(&format!("online lookup failed: {e}"));
                None
            }
        }
    } else {
        None
    };

    let stardict_len = stardict_results.len();
    let mdx_len = mdx_results.len();

    if output.json {
        return output.print_json(&serde_json::json!({
            "term": term,
            "stardict": stardict_results,
            "mdx": mdx_results,
            "online": online_result,
            "elapsedMs": elapsed,
        }));
    }

    if stardict_len == 0 && mdx_len == 0 && online_result.is_none() {
        output.note(&format!(
            "no definitions for '{term}' in {} installed dictionaries",
            stardict_len + mdx_len
        ));
        return 1;
    }

    for entry in &stardict_results {
        println!(
            "{} {}",
            output.bold(&entry.word),
            output.dim(&format!("({})", entry.dictionary_name))
        );
        for meaning in &entry.meanings {
            if !meaning.part_of_speech.is_empty() {
                println!("  {}", output.cyan(&meaning.part_of_speech));
            }
            for definition in &meaning.definitions {
                println!("    {definition}");
            }
        }
        println!();
    }
    for entry in &mdx_results {
        println!(
            "{} {}",
            output.bold(&entry.term),
            output.dim(&format!("({})", entry.dictionary_name))
        );
        let text = crate::book_search::html_to_plain_text(&entry.html);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            println!("    {}", line.trim());
        }
        println!();
    }
    if let Some(value) = online_result {
        println!("{} {}", output.bold(term), output.dim("(online)"));
        if let Some(text) = value.get("textContent").and_then(|v| v.as_str()) {
            for line in text.lines().take(30) {
                println!("    {line}");
            }
        } else {
            println!("    {value}");
        }
    }
    output.note(&format!("({:.2}ms)", elapsed));
    0
}

/// Look up a term in every installed MDict (.mdx) dictionary.
fn mdx_lookup_all_installed(ctx: &Ctx, term: &str) -> Vec<crate::mdict::MdxEntryResult> {
    let mut results = Vec::new();
    for id in crate::stardict::list_installed_dict_ids(ctx.dir()) {
        let dict_dir = ctx.dir().join("dictionaries").join(&id);
        let mdx_path = match std::fs::read_dir(&dict_dir) {
            Ok(entries) => entries.flatten().map(|e| e.path()).find(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("mdx"))
                    .unwrap_or(false)
            }),
            Err(_) => None,
        };
        let Some(mdx_path) = mdx_path else { continue };
        let dict = match crate::mdict::MdxDictionary::open(&mdx_path) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        if let Ok(Some(entry)) = dict.lookup(term) {
            results.push(entry);
        }
    }
    results
}
