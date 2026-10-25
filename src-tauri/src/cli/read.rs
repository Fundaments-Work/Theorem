//! `theorem open` (GUI bridge) and `theorem read` (EPUB chapters, CFI).

use super::*;

pub(super) fn run_open(output: &Output, ctx: &Ctx, book_id: &str) -> i32 {
    match load_book(ctx, book_id) {
        Ok(Some(_)) => {}
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => return output.error(&format!("Failed to resolve executable: {e}")),
    };
    match std::process::Command::new(exe)
        .arg(format!("--open-book={book_id}"))
        .spawn()
    {
        Ok(_) => {
            if output.json {
                output.print_json(&serde_json::json!({ "opened": book_id }))
            } else {
                println!("{} {book_id}", output.green("opening in GUI"));
                0
            }
        }
        Err(e) => output.error(&format!("Failed to launch GUI: {e}")),
    }
}

pub(super) fn run_read(
    output: &Output,
    ctx: &Ctx,
    book_id: &str,
    chapter: Option<usize>,
    cfi: Option<&str>,
) -> i32 {
    if let Some(cfi) = cfi {
        return run_read_cfi(output, ctx, book_id, cfi);
    }
    let chapter = chapter.unwrap_or(1).max(1);

    let path = match resolve_book_path(ctx, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            return output.error(book_not_found(book_id));
        }
        Err(e) => return output.error(&e),
    };

    match read_epub_chapter(&path, chapter) {
        Ok(text) => {
            if output.json {
                output.print_json(&serde_json::json!({
                    "bookId": book_id,
                    "chapter": chapter,
                    "text": text,
                }))
            } else {
                let stdout = std::io::stdout();
                let mut out = stdout.lock();
                let _ = out.write_all(text.as_bytes());
                let _ = out.write_all(b"\n");
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

/// Resolve an EPUB CFI and print the plain text at the anchored location.
fn run_read_cfi(output: &Output, ctx: &Ctx, book_id: &str, cfi: &str) -> i32 {
    let location = match crate::epubcfi::parse(cfi) {
        Ok(location) => location,
        Err(e) => return output.error(&format!("invalid CFI: {e}")),
    };

    let path = match resolve_book_path(ctx, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => return output.error(book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };

    let result = (|| -> Result<String, String> {
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let mut archive =
            crate::zip_util::open_zip_archive(file).map_err(|e| format!("Not a valid zip: {e}"))?;
        let opf_path = crate::epub_parser::read_rootfile_path_inner(&mut archive)
            .ok_or("Missing OPF rootfile in META-INF/container.xml")?;
        let opf = crate::epub_parser::read_zip_entry_inner(&mut archive, &opf_path)
            .ok_or_else(|| format!("Missing OPF file: {opf_path}"))?;
        let spine_hrefs = parse_spine_order(&opf);
        let href = spine_hrefs
            .get(location.spine_index)
            .ok_or_else(|| format!("CFI spine index {} out of range", location.spine_index))?;
        let section_path = crate::epub_parser::resolve_relative(&opf_path, href);
        let html = crate::epub_parser::read_zip_entry_inner(&mut archive, &section_path)
            .ok_or_else(|| format!("Missing chapter file: {section_path}"))?;
        let tree = crate::epubcfi::build_tree(&html);
        let text = crate::epubcfi::resolve_text(&tree, &location)?;
        if text.is_empty() {
            // Fall back to the whole chapter so the anchor context is visible.
            Ok(crate::cli_text::html_to_text(&html))
        } else {
            Ok(text)
        }
    })();

    match result {
        Ok(text) => {
            if output.json {
                output.print_json(&serde_json::json!({
                    "bookId": book_id,
                    "cfi": cfi,
                    "spineIndex": location.spine_index,
                    "text": text,
                }))
            } else {
                println!("{text}");
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

/// Extract the plain text of an EPUB spine chapter in spine order.
/// The materialized cache file has no extension, so the format is sniffed
/// from the file magic instead.
pub(crate) fn read_epub_chapter(path: &PathBuf, chapter: usize) -> Result<String, String> {
    let mut magic = [0u8; 4];
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    std::io::Read::read_exact(&mut file, &mut magic)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    drop(file);

    if &magic != b"PK\x03\x04" {
        // MOBI/AZW: the PDB signature "BOOKMOBI" sits at offset 60.
        let mut pdb_magic = [0u8; 8];
        let mut file = std::fs::File::open(path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        file.seek(SeekFrom::Start(60))
            .map_err(|e| format!("Cannot seek {}: {e}", path.display()))?;
        std::io::Read::read_exact(&mut file, &mut pdb_magic)
            .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        if &pdb_magic == b"BOOKMOBI" {
            return crate::mobi_parser::extract_mobi_text(path);
        }
        return Err(format!(
            "read supports EPUB and MOBI files only ({})",
            path.display()
        ));
    }

    let file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut archive =
        crate::zip_util::open_zip_archive(file).map_err(|e| format!("Not a valid zip: {e}"))?;

    let opf_path = crate::epub_parser::read_rootfile_path_inner(&mut archive)
        .ok_or("Missing OPF rootfile in META-INF/container.xml")?;
    let opf = crate::epub_parser::read_zip_entry_inner(&mut archive, &opf_path)
        .ok_or_else(|| format!("Missing OPF file: {opf_path}"))?;

    let spine_hrefs = parse_spine_order(&opf);

    let index = chapter - 1;
    let href = spine_hrefs.get(index).ok_or_else(|| {
        format!(
            "Chapter {chapter} out of range (book has {} chapters)",
            spine_hrefs.len()
        )
    })?;

    let section_path = crate::epub_parser::resolve_relative(&opf_path, href);
    let html = crate::epub_parser::read_zip_entry_inner(&mut archive, &section_path)
        .ok_or_else(|| format!("Missing chapter file: {section_path}"))?;

    Ok(crate::cli_text::html_to_text(&html))
}

/// Count EPUB spine chapters without loading their content.
pub(crate) fn epub_chapter_count(path: &PathBuf) -> Result<usize, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut archive =
        crate::zip_util::open_zip_archive(file).map_err(|e| format!("Not a valid zip: {e}"))?;
    let opf_path = crate::epub_parser::read_rootfile_path_inner(&mut archive)
        .ok_or("Missing OPF rootfile in META-INF/container.xml")?;
    let opf = crate::epub_parser::read_zip_entry_inner(&mut archive, &opf_path)
        .ok_or_else(|| format!("Missing OPF file: {opf_path}"))?;
    Ok(parse_spine_order(&opf).len().max(1))
}

/// Minimal OPF scan: returns chapter hrefs in spine order.
fn parse_spine_order(opf: &str) -> Vec<String> {
    use quick_xml::events::Event;

    let mut manifest_hrefs: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut spine_ids: Vec<String> = Vec::new();

    let mut reader = quick_xml::Reader::from_str(opf);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                let attrs: std::collections::HashMap<String, String> = e
                    .attributes()
                    .flatten()
                    .map(|a| {
                        let key = String::from_utf8_lossy(a.key.as_ref()).into_owned();
                        let value = a
                            .unescape_value()
                            .map(|v| v.into_owned())
                            .unwrap_or_default();
                        (key, value)
                    })
                    .collect();
                match name.as_slice() {
                    b"item" => {
                        if let (Some(id), Some(href)) = (attrs.get("id"), attrs.get("href")) {
                            manifest_hrefs.insert(id.clone(), href.clone());
                        }
                    }
                    b"itemref" => {
                        if let Some(idref) = attrs.get("idref") {
                            spine_ids.push(idref.clone());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    spine_ids
        .iter()
        .filter_map(|id| manifest_hrefs.get(id).cloned())
        .collect()
}
