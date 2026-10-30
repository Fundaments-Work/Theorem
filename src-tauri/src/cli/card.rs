//! Native share card renderer for CLI automation.
//!
//! Generates high-resolution Bauhaus-styled share cards for highlights and notes
//! directly in Rust. Outputs vector SVG or rasterized PNG via `resvg`.

use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct CardColors {
    pub bg: &'static str,
    pub fg: &'static str,
    pub subtext: &'static str,
    pub border: &'static str,
    pub accent: &'static str,
}

pub fn get_card_colors(theme: &str, highlight_color: Option<&str>) -> CardColors {
    let highlight_accent = match highlight_color {
        Some("yellow") => "#facc15",
        Some("green") => "#4ade80",
        Some("blue") => "#60a5fa",
        Some("purple") => "#c084fc",
        Some("red") => "#f87171",
        _ => "#c6f135",
    };

    match theme {
        "sepia" => CardColors {
            bg: "#f4ede2",
            fg: "#1a120b",
            subtext: "#594231",
            border: "rgba(100, 70, 45, 0.16)",
            accent: "#9a3c08",
        },
        "tinted" => CardColors {
            bg: "#0d140e",
            fg: "#f4f8f4",
            subtext: "rgba(244, 248, 244, 0.78)",
            border: "rgba(198, 241, 53, 0.18)",
            accent: highlight_accent,
        },
        "light" => CardColors {
            bg: "#faf8f5",
            fg: "#1a1918",
            subtext: "#57544f",
            border: "rgba(0, 0, 0, 0.1)",
            accent: "#1a1918",
        },
        _ => CardColors {
            // "dark" default: Theorem signature electric lime
            bg: "#121316",
            fg: "#f2f0eb",
            subtext: "#a8a59e",
            border: "rgba(255, 255, 255, 0.12)",
            accent: "#c6f135",
        },
    }
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn wrap_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.lines() {
        let trimmed = paragraph.trim();
        if trimmed.is_empty() {
            continue;
        }
        let words: Vec<&str> = trimmed.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        let mut current_line = String::new();
        for word in words {
            if current_line.is_empty() {
                current_line.push_str(word);
            } else if current_line.chars().count() + 1 + word.chars().count() <= max_chars {
                current_line.push(' ');
                current_line.push_str(word);
            } else {
                lines.push(current_line);
                current_line = word.to_string();
            }
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }
    lines
}

#[derive(Debug, Clone)]
pub struct CardRenderOptions<'a> {
    pub text: &'a str,
    pub note: Option<&'a str>,
    pub book_title: &'a str,
    pub book_author: &'a str,
    pub date_str: Option<&'a str>,
    pub theme: &'a str,
    pub highlight_color: Option<&'a str>,
    pub format: &'a str,
}

pub fn render_highlight_card_svg(opts: &CardRenderOptions<'_>) -> String {
    let is_story = opts.format == "story";
    let width = 1080;
    let height = if is_story { 1920 } else { 1080 };
    let colors = get_card_colors(opts.theme, opts.highlight_color);

    let padding_x = 88;
    let padding_y = if is_story { 120 } else { 88 };

    let char_count = opts.text.chars().count();
    let (font_size, line_height, max_chars) = if char_count < 140 {
        (48, 72, 36)
    } else if char_count < 320 {
        (40, 60, 44)
    } else if char_count < 700 {
        (32, 48, 54)
    } else {
        (26, 38, 66)
    };

    let quote_lines = wrap_text(opts.text, max_chars);
    let quote_height = quote_lines.len() * line_height;

    let note_lines = opts.note.map(|n| wrap_text(n, 58)).unwrap_or_default();
    let note_height = if !note_lines.is_empty() {
        32 + (note_lines.len() * 38)
    } else {
        0
    };

    let total_content_height = quote_height + note_height;

    // Center content vertically between top glyph and bottom footer
    let top_glyph_y = padding_y + 40;
    let footer_start_y = height - padding_y - 120;
    let available_middle_height = footer_start_y - (top_glyph_y + 60);

    let quote_start_y = top_glyph_y
        + 60
        + if available_middle_height > total_content_height {
            (available_middle_height - total_content_height) / 2
        } else {
            0
        };

    let mut svg = String::new();
    svg.push_str(&format!(
        r#"<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">
<rect width="{width}" height="{height}" fill="{bg}" />
"#,
        bg = colors.bg
    ));

    // Top glyph ❋
    svg.push_str(&format!(
        r#"<text x="{x}" y="{y}" fill="{accent}" font-family="'FreeSerif', Georgia, serif" font-size="56" line-height="1">&#10033;</text>
"#,
        x = padding_x,
        y = top_glyph_y,
        accent = colors.accent
    ));

    // Quote text
    svg.push_str(&format!(
        r#"<text x="{x}" y="{y}" fill="{fg}" font-family="Georgia, 'Liberation Serif', 'FreeSerif', serif" font-size="{font_size}">
"#,
        x = padding_x,
        y = quote_start_y,
        fg = colors.fg
    ));
    for (i, line) in quote_lines.iter().enumerate() {
        let dy = if i == 0 { 0 } else { line_height };
        svg.push_str(&format!(
            r#"  <tspan x="{x}" dy="{dy}">{line}</tspan>
"#,
            x = padding_x,
            line = xml_escape(line)
        ));
    }
    svg.push_str("</text>\n");

    // Note section
    if !note_lines.is_empty() {
        let note_divider_y = quote_start_y + quote_height + 24;
        let note_text_y = note_divider_y + 40;

        svg.push_str(&format!(
            r#"<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{border}" stroke-width="1" />
<text x="{x1}" y="{text_y}" fill="{fg}" fill-opacity="0.8" font-family="system-ui, -apple-system, 'Liberation Sans', 'FreeSans', sans-serif" font-size="24">
"#,
            x1 = padding_x,
            x2 = width - padding_x,
            y = note_divider_y,
            border = colors.border,
            fg = colors.fg,
            text_y = note_text_y
        ));
        for (i, line) in note_lines.iter().enumerate() {
            let dy = if i == 0 { 0 } else { 38 };
            svg.push_str(&format!(
                r#"  <tspan x="{x}" dy="{dy}">{line}</tspan>
"#,
                x = padding_x,
                line = xml_escape(line)
            ));
        }
        svg.push_str("</text>\n");
    }

    // Bottom Footer Divider
    svg.push_str(&format!(
        r#"<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{border}" stroke-width="1" />
"#,
        x1 = padding_x,
        x2 = width - padding_x,
        y = footer_start_y,
        border = colors.border
    ));

    // Book Title, Author, Date
    svg.push_str(&format!(
        r#"<text x="{x}" y="{y}" fill="{fg}" font-family="system-ui, -apple-system, 'Liberation Sans', 'FreeSans', sans-serif" font-size="26" font-weight="600">{title}</text>
"#,
        x = padding_x,
        y = footer_start_y + 42,
        fg = colors.fg,
        title = xml_escape(opts.book_title)
    ));

    if !opts.book_author.is_empty() {
        svg.push_str(&format!(
            r#"<text x="{x}" y="{y}" fill="{subtext}" font-family="system-ui, -apple-system, 'Liberation Sans', 'FreeSans', sans-serif" font-size="20">{author}</text>
"#,
            x = padding_x,
            y = footer_start_y + 72,
            subtext = colors.subtext,
            author = xml_escape(opts.book_author)
        ));
    }

    if let Some(d) = opts.date_str {
        let date_y = if !opts.book_author.is_empty() {
            footer_start_y + 98
        } else {
            footer_start_y + 72
        };
        svg.push_str(&format!(
            r#"<text x="{x}" y="{y}" fill="{subtext}" font-family="system-ui, -apple-system, 'Liberation Sans', 'FreeSans', sans-serif" font-size="16">{date}</text>
"#,
            x = padding_x,
            y = date_y,
            subtext = colors.subtext,
            date = xml_escape(d)
        ));
    }

    // Right Watermark: TheoremLogo + "Theorem Reader"
    let logo_x = width - padding_x - 220;
    let logo_y = footer_start_y + 36;
    svg.push_str(&format!(
        r#"<g transform="translate({logo_x}, {logo_y}) scale(1.35)">
  <path d="M 4 4 H 20 V 8 L 14 8 V 16 H 18 V 20 H 14 L 10 20 V 8 L 4 8 V 4 Z M 10 16 H 14 V 20 H 10 V 16 Z" fill="{accent}" fill-rule="evenodd" />
</g>
<text x="{text_x}" y="{text_y}" fill="{fg}" font-family="system-ui, -apple-system, 'Liberation Sans', 'FreeSans', sans-serif" font-size="21" font-weight="700" letter-spacing="-0.01em">Theorem Reader</text>
"#,
        logo_x = logo_x,
        logo_y = logo_y,
        accent = colors.accent,
        text_x = logo_x + 40,
        text_y = logo_y + 24,
        fg = colors.fg
    ));

    svg.push_str("</svg>\n");
    svg
}

pub fn render_card_to_file(svg: &str, out_path: &Path) -> Result<(), String> {
    if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let is_svg = out_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("svg"))
        .unwrap_or(false);

    if is_svg {
        std::fs::write(out_path, svg)
            .map_err(|e| format!("Failed to write SVG to {}: {e}", out_path.display()))?;
        return Ok(());
    }

    // Rasterize SVG to PNG using resvg
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    opt.fontdb_mut().set_serif_family("Liberation Serif");
    opt.fontdb_mut().set_sans_serif_family("Liberation Sans");
    opt.font_family = "Georgia".to_string();

    let tree =
        resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| format!("Failed to parse SVG: {e}"))?;
    let size = tree.size().to_int_size();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())
        .ok_or_else(|| "Failed to allocate pixmap".to_string())?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );
    pixmap
        .save_png(out_path)
        .map_err(|e| format!("Failed to write PNG to {}: {e}", out_path.display()))?;

    Ok(())
}
