//! `theorem search`: library full-text search and in-book search.

use super::*;

pub(super) fn run_search(
    output: &Output,
    ctx: &Ctx,
    query: &str,
    book_id: Option<String>,
    limit: usize,
) -> i32 {
    match book_id {
        None => library_search(output, ctx, query, limit),
        Some(book_id) => in_book_search(output, ctx, &book_id, query, limit),
    }
}

/// An FTS5 query from what the user typed: every word must appear in the
/// title or author, as a word or the start of one. Each word is quoted, so
/// characters FTS5 treats as syntax (`"`, `*`, `-`, `:`, `(`, `AND` …) are
/// searched for as text instead of failing with a syntax error.
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("{{title author}} : ({})", terms.join(" ")))
}

fn library_search(output: &Output, ctx: &Ctx, query: &str, limit: usize) -> i32 {
    let Some(fts) = fts_query(query) else {
        return output.usage("the search is empty");
    };
    let limit = u32::try_from(limit).unwrap_or(u32::MAX);
    match ctx
        .store
        .with_connection(|conn| crate::database::sqlite_search_books_inner(conn, &fts, limit))
    {
        Ok(rows) => {
            if output.json {
                output.print_json(&rows)
            } else if rows.is_empty() {
                output.note("no results");
                0
            } else {
                for row in &rows {
                    println!("{}\t{}", output.dim(&row.book_id), row.title);
                }
                output.note(&format!("# {} results", rows.len()));
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

fn in_book_search(output: &Output, ctx: &Ctx, book_id: &str, query: &str, limit: usize) -> i32 {
    let path = match resolve_book_path(ctx, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            return output.error(book_not_found(book_id));
        }
        Err(e) => return output.error(&e),
    };

    match crate::book_search::search_epub_spine(&path, query, false, false) {
        Ok(mut matches) => {
            matches.truncate(limit);
            if output.json {
                output.print_json(&matches)
            } else {
                for m in &matches {
                    println!(
                        "{}:{}\t{}",
                        output.bold(&m.section_index.to_string()),
                        m.char_offset,
                        m.snippet
                    );
                }
                output.note(&format!("# {} matches", matches.len()));
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

pub(crate) fn resolve_book_path(ctx: &Ctx, book_id: &str) -> Result<Option<PathBuf>, AppError> {
    crate::database::get_materialized_book_path_in(&ctx.store, book_id)
        .map(|opt| opt.map(PathBuf::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_input_is_quoted_for_fts() {
        assert_eq!(fts_query("  "), None);
        assert_eq!(
            fts_query("dune mess"),
            Some(r#"{title author} : ("dune"* "mess"*)"#.to_string())
        );
        assert_eq!(
            fts_query(r#"a"b -c AND"#),
            Some(r#"{title author} : ("a""b"* "-c"* "AND"*)"#.to_string())
        );
    }
}
