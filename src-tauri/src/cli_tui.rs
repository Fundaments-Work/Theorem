//! Interactive terminal UI (`theorem tui`).
//!
//! A clean, read-only terminal companion to the GUI: browse the library,
//! read EPUB/MOBI chapters as plain text, and jump into the full GUI with
//! `o`. Never writes reading progress or mutates the library.
//!
//! Desktop-only; compiled out on Android along with the rest of the CLI.

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Row, Table, TableState};
use ratatui::{DefaultTerminal, Frame};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::cli::Ctx;

const LOGO: &[&str] = &[
    "████████╗██╗  ██╗███████╗ ██████╗ ██████╗ ███████╗███╗   ███╗",
    "╚══██╔══╝██║  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝████╗ ████║",
    "   ██║   ███████║█████╗  ██║   ██║██████╔╝█████╗  ██╔████╔██║",
    "   ██║   ██╔══██║██╔══╝  ██║   ██║██╔══██╗██╔══╝  ██║╚██╔╝██║",
    "   ██║   ██║  ██║███████╗╚██████╔╝██║  ██║███████╗██║ ╚═╝ ██║",
    "   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝",
];

#[derive(Clone)]
struct BookRow {
    id: String,
    title: String,
    author: String,
    format: String,
    progress: f64,
    is_favorite: bool,
}

enum View {
    Library,
    Reader,
}

struct TuiApp {
    books: Vec<BookRow>,
    filtered: Vec<usize>,
    filter: String,
    filter_mode: bool,
    library_state: TableState,
    view: View,
    show_help: bool,
    status: String,
    // Reader state
    reader_book: Option<BookRow>,
    chapter: usize,
    chapter_count: usize,
    chapter_titles: Box<[Box<str>]>,
    chapter_text: String,
    scroll: u16,
}

impl TuiApp {
    fn load(app: &Ctx) -> Result<Self, String> {
        let mut books: Vec<BookRow> = crate::cli::load_books(app)?
            .iter()
            .map(|b| BookRow {
                id: crate::cli::book_str(b, "id").unwrap_or("?").to_string(),
                title: crate::cli::book_title(b),
                author: crate::cli::book_author(b),
                format: crate::cli::book_str(b, "format").unwrap_or("?").to_string(),
                progress: b.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0),
                is_favorite: b
                    .get("isFavorite")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
            .collect();
        books.sort_by_key(|a| a.title.to_lowercase());
        let filtered = (0..books.len()).collect();
        // The first book is selected, so Enter works without moving first.
        let library_state = TableState::default().with_selected((!books.is_empty()).then_some(0));
        Ok(Self {
            books,
            filtered,
            filter: String::new(),
            filter_mode: false,
            library_state,
            view: View::Library,
            show_help: false,
            status: String::new(),
            reader_book: None,
            chapter: 0,
            chapter_count: 0,
            chapter_titles: Box::default(),
            chapter_text: String::new(),
            scroll: 0,
        })
    }

    fn apply_filter(&mut self) {
        let query = self.filter.to_lowercase();
        if query.is_empty() {
            self.filtered = (0..self.books.len()).collect();
        } else {
            self.filtered = self
                .books
                .iter()
                .enumerate()
                .filter(|(_, b)| {
                    b.title.to_lowercase().contains(&query)
                        || b.author.to_lowercase().contains(&query)
                })
                .map(|(i, _)| i)
                .collect();
        }
        self.library_state
            .select((!self.filtered.is_empty()).then_some(0));
    }

    fn selected_book(&self) -> Option<&BookRow> {
        self.library_state
            .selected()
            .and_then(|i| self.filtered.get(i))
            .and_then(|book_index| self.books.get(*book_index))
    }

    fn load_chapter(&mut self, app: &Ctx) {
        let (Some(book), chapter) = (self.reader_book.clone(), self.chapter) else {
            return;
        };
        self.scroll = 0;
        let result = crate::cli::resolve_book_path(app, &book.id)
            .map_err(String::from)
            .and_then(|path| {
                path.ok_or_else(|| "book file not found".to_string())
                    .and_then(|path| {
                        if book.format.eq_ignore_ascii_case("epub") {
                            crate::cli::read_epub_chapter(&path, chapter + 1)
                        } else if book.format.eq_ignore_ascii_case("mobi")
                            || book.format.eq_ignore_ascii_case("azw")
                            || book.format.eq_ignore_ascii_case("azw3")
                        {
                            crate::mobi_parser::extract_mobi_text(&path)
                        } else {
                            Err(format!(
                                "{} reading is not supported in the TUI",
                                book.format
                            ))
                        }
                    })
            });
        match result {
            Ok(text) => {
                self.chapter_text = text;
                if self.chapter_text.trim().is_empty() {
                    self.status = format!("chapter {} is empty", chapter + 1);
                } else {
                    self.status.clear();
                }
            }
            Err(e) => {
                self.chapter_text = String::new();
                self.status = e;
            }
        }
    }

    fn open_reader(&mut self, app: &Ctx) {
        let Some(book) = self.selected_book().cloned() else {
            return;
        };
        self.reader_book = Some(book.clone());
        self.chapter = 0;
        self.chapter_titles = Box::default();
        self.chapter_count = if book.format.eq_ignore_ascii_case("epub") {
            crate::cli::resolve_book_path(app, &book.id)
                .ok()
                .flatten()
                .and_then(
                    |path| match crate::epub_parser::read_chapter_titles(&path) {
                        Ok(titles) if !titles.is_empty() => {
                            self.chapter_titles = titles;
                            Some(self.chapter_titles.len().max(1))
                        }
                        _ => crate::cli::epub_chapter_count(&path).ok(),
                    },
                )
                .unwrap_or(1)
        } else {
            1
        };
        self.view = View::Reader;
        self.load_chapter(app);
    }

    fn chapter_label(&self) -> String {
        self.chapter_titles
            .get(self.chapter)
            .filter(|title| !title.is_empty())
            .map_or_else(
                || format!("chapter {}", self.chapter + 1),
                |title| title.to_string(),
            )
    }
}

/// Pub(crate) entry point from the clap `Tui` command.
pub(crate) fn run_tui(app: &Ctx) -> i32 {
    let mut tui_app = match TuiApp::load(app) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    let mut terminal = match ratatui::try_init() {
        Ok(terminal) => terminal,
        Err(e) => {
            eprintln!("error: failed to enter terminal UI mode: {e}");
            return 1;
        }
    };
    let result = tui_loop(&mut terminal, &mut tui_app, app);
    ratatui::restore();
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn tui_loop(terminal: &mut DefaultTerminal, tui: &mut TuiApp, app: &Ctx) -> Result<(), String> {
    // Draw only when something changed: a key press or a resize. Nothing
    // else changes the screen, so waiting for the next event costs no CPU.
    let mut dirty = true;
    loop {
        if dirty {
            terminal
                .draw(|frame| draw(frame, tui, app))
                .map_err(|e| e.to_string())?;
            dirty = false;
        }
        let key = match event::read().map_err(|e| e.to_string())? {
            Event::Key(key) => key,
            Event::Resize(..) => {
                dirty = true;
                continue;
            }
            _ => continue,
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        dirty = true;
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Ok(());
        }

        if tui.filter_mode {
            match key.code {
                KeyCode::Char(c) => {
                    tui.filter.push(c);
                    tui.apply_filter();
                }
                KeyCode::Backspace => {
                    tui.filter.pop();
                    tui.apply_filter();
                }
                KeyCode::Enter | KeyCode::Esc => {
                    tui.filter_mode = false;
                    if key.code == KeyCode::Esc {
                        tui.filter.clear();
                        tui.apply_filter();
                    }
                }
                _ => {}
            }
            continue;
        }

        if tui.show_help {
            match key.code {
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q') => tui.show_help = false,
                _ => {}
            }
            continue;
        }

        match tui.view {
            View::Library => match key.code {
                KeyCode::Char('q') => return Ok(()),
                KeyCode::Char('?') => tui.show_help = true,
                KeyCode::Down | KeyCode::Char('j') => move_selection(tui, 1),
                KeyCode::Up | KeyCode::Char('k') => move_selection(tui, -1),
                KeyCode::Char('/') => tui.filter_mode = true,
                KeyCode::Enter => {
                    tui.open_reader(app);
                }
                KeyCode::Char('o') => {
                    if let Some(book) = tui.selected_book().cloned() {
                        if let Ok(exe) = std::env::current_exe() {
                            let _ = std::process::Command::new(exe)
                                .arg(format!("--open-book={}", book.id))
                                .spawn();
                            tui.status = format!("opening '{}' in the GUI…", book.title);
                        }
                    }
                }
                _ => {}
            },
            View::Reader => match key.code {
                KeyCode::Esc | KeyCode::Backspace => {
                    tui.view = View::Library;
                    tui.status.clear();
                }
                KeyCode::Char('?') => tui.show_help = true,
                KeyCode::Down | KeyCode::Char('j') => tui.scroll = tui.scroll.saturating_add(1),
                KeyCode::Up | KeyCode::Char('k') => tui.scroll = tui.scroll.saturating_sub(1),
                KeyCode::PageDown => tui.scroll = tui.scroll.saturating_add(20),
                KeyCode::PageUp => tui.scroll = tui.scroll.saturating_sub(20),
                KeyCode::Home | KeyCode::Char('g') => tui.scroll = 0,
                KeyCode::Right | KeyCode::Char(']') | KeyCode::Char('l') => {
                    if tui.chapter + 1 < tui.chapter_count.max(1) {
                        tui.chapter += 1;
                        tui.load_chapter(app);
                    }
                }
                KeyCode::Left | KeyCode::Char('[') | KeyCode::Char('h') if tui.chapter > 0 => {
                    tui.chapter -= 1;
                    tui.load_chapter(app);
                }
                _ => {}
            },
        }
    }
}

fn move_selection(tui: &mut TuiApp, delta: isize) {
    if tui.filtered.is_empty() {
        return;
    }
    let current = tui.library_state.selected().unwrap_or(0) as isize;
    let next = (current + delta).clamp(0, tui.filtered.len() as isize - 1);
    tui.library_state.select(Some(next as usize));
}

fn draw(frame: &mut Frame, tui: &mut TuiApp, _app: &Ctx) {
    let chunks = Layout::vertical([
        Constraint::Length(header_height(frame.area())),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(frame.area());

    draw_header(frame, chunks[0]);

    match tui.view {
        View::Library => draw_library(frame, chunks[1], tui),
        View::Reader => draw_reader(frame, chunks[1], tui),
    }

    let status = if tui.status.is_empty() {
        match tui.view {
            View::Library => "q quit · enter read · o open in GUI · / filter · ? help".to_string(),
            View::Reader => "esc back · j/k scroll · [/] chapter · g top · ? help".to_string(),
        }
    } else {
        tui.status.clone()
    };
    let status_line = Line::from(vec![
        Span::styled(
            " Theorem ",
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(status, Style::default().fg(Color::DarkGray)),
    ]);
    frame.render_widget(Paragraph::new(status_line), chunks[2]);

    if tui.show_help {
        draw_help(frame);
    }
}

fn header_height(area: Rect) -> u16 {
    if area.height >= 20 {
        (LOGO.len() as u16) + 1
    } else {
        1
    }
}

fn draw_header(frame: &mut Frame, area: Rect) {
    if area.height >= (LOGO.len() as u16) {
        let lines: Vec<Line> = LOGO
            .iter()
            .map(|l| {
                Line::from(Span::styled(
                    *l,
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ))
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), area);
    } else {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " THEOREM ",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ))),
            area,
        );
    }
}

fn draw_library(frame: &mut Frame, area: Rect, tui: &mut TuiApp) {
    let filter_line = if tui.filter_mode || !tui.filter.is_empty() {
        let cursor = if tui.filter_mode { "▏" } else { "" };
        Line::from(Span::styled(
            format!(" filter: {}{}", tui.filter, cursor),
            Style::default().fg(Color::Yellow),
        ))
    } else {
        Line::from("")
    };

    let inner = if filter_line.width() > 0 {
        let rows = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).split(area);
        frame.render_widget(Paragraph::new(filter_line), rows[0]);
        rows[1]
    } else {
        area
    };

    let header = Row::new(vec!["Title", "Author", "Prog", "Fmt"]).style(
        Style::default()
            .add_modifier(Modifier::BOLD)
            .fg(Color::Cyan),
    );

    let rows: Vec<Row> = tui
        .filtered
        .iter()
        .filter_map(|i| tui.books.get(*i))
        .map(|b| {
            let title = if b.is_favorite {
                format!("★ {}", b.title)
            } else {
                b.title.clone()
            };
            Row::new(vec![
                truncate(&title, 52),
                truncate(&b.author, 28),
                format!("{:.0}%", b.progress * 100.0),
                b.format.clone(),
            ])
        })
        .collect();

    let widths = [
        Constraint::Percentage(55),
        Constraint::Percentage(27),
        Constraint::Length(5),
        Constraint::Length(6),
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" Library — {} books ", tui.filtered.len())),
        )
        .row_highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .column_spacing(1);

    frame.render_stateful_widget(table, inner, &mut tui.library_state);
}

fn draw_reader(frame: &mut Frame, area: Rect, tui: &mut TuiApp) {
    let book = tui.reader_book.clone();
    let Some(book) = book else { return };

    let title = format!(
        " {} — {} {}/{} ",
        book.title,
        if book.format.eq_ignore_ascii_case("epub") {
            tui.chapter_label()
        } else {
            book.format.clone()
        },
        tui.chapter + 1,
        tui.chapter_count.max(1),
    );

    let paragraph = Paragraph::new(tui.chapter_text.as_str())
        .block(Block::default().borders(Borders::ALL).title(title))
        .scroll((tui.scroll, 0))
        .wrap(ratatui::widgets::Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn draw_help(frame: &mut Frame) {
    let area = centered_rect(60, 60, frame.area());
    frame.render_widget(Clear, area);
    let items = vec![
        "Library",
        "  ↑/k ↓/j   move selection",
        "  enter     read the selected book as text",
        "  o         open the book in the Theorem GUI",
        "  /         filter by title or author (esc clears)",
        "  q         quit",
        "",
        "Reader",
        "  j/k ↑/↓   scroll (pgup/pgdn, g for top)",
        "  [ / ]     previous / next chapter",
        "  esc       back to the library",
        "",
        "  ?         toggle this help",
    ];
    let list = List::new(items.into_iter().map(|i| {
        ListItem::new(Span::styled(
            i,
            if i.starts_with(' ') {
                Style::default()
            } else {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            },
        ))
    }))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Theorem TUI — Help (esc to close) "),
    );
    frame.render_widget(list, area);
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::vertical([
        Constraint::Percentage((100 - percent_y) / 2),
        Constraint::Percentage(percent_y),
        Constraint::Percentage((100 - percent_y) / 2),
    ])
    .split(area);
    let horizontal = Layout::horizontal([
        Constraint::Percentage((100 - percent_x) / 2),
        Constraint::Percentage(percent_x),
        Constraint::Percentage((100 - percent_x) / 2),
    ])
    .split(vertical[1]);
    horizontal[1]
}

fn truncate(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if text.width() <= max {
        return text.to_string();
    }
    let mut used = 0;
    let mut cut = String::new();
    for grapheme in text.graphemes(true) {
        let width = grapheme.width();
        if width > max - 1 - used {
            break;
        }
        cut.push_str(grapheme);
        used += width;
    }
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_respects_terminal_columns_and_whole_graphemes() {
        assert_eq!(truncate("你好世界", 5), "你好…");
        assert_eq!(truncate("e\u{301}abcd", 3), "e\u{301}a…");
        assert_eq!(truncate("👩‍👩‍👧‍👦abcd", 3), "👩‍👩‍👧‍👦…");
        assert_eq!(truncate("你好", 4), "你好");
        assert_eq!(truncate("abc", 0), "");
        assert_eq!(truncate("abc", 1), "…");
        assert_eq!(truncate("", 0), "");
    }

    #[test]
    fn terminal_reader_uses_chapter_titles_and_numbered_fallbacks() {
        let mut tui = tui_with(&[]);
        tui.chapter_titles = vec!["Opening".into(), "".into(), "第二章".into()].into_boxed_slice();
        assert_eq!(tui.chapter_label(), "Opening");
        tui.chapter = 1;
        assert_eq!(tui.chapter_label(), "chapter 2");
        tui.chapter = 2;
        assert_eq!(tui.chapter_label(), "第二章");
        tui.chapter = 9;
        assert_eq!(tui.chapter_label(), "chapter 10");
    }

    #[test]
    fn terminal_reader_draws_the_selected_chapter_name() {
        let mut tui = tui_with(&["Book"]);
        tui.reader_book = tui.selected_book().cloned();
        tui.chapter_titles = vec!["Opening".into(), "Chapter Two".into()].into_boxed_slice();
        tui.chapter_count = 2;
        tui.chapter = 1;
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 12)).unwrap();
        terminal
            .draw(|frame| draw_reader(frame, frame.area(), &mut tui))
            .unwrap();
        let screen: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(screen.contains("Book — Chapter Two 2/2"));
    }

    #[test]
    fn terminal_reader_keeps_spine_navigation_when_title_extraction_is_empty() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::open_at(dir.path()).unwrap();
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::FileOptions::<()>::default();
        for (name, data) in [
            (
                "META-INF/container.xml",
                r#"<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>"#,
            ),
            (
                "book.opf",
                r#"<package><manifest><item id="one" href="one.xhtml"></item><item id="two" href="two.xhtml"></item></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>"#,
            ),
            ("one.xhtml", "<html><body>First chapter.</body></html>"),
            ("two.xhtml", "<html><body>Second chapter.</body></html>"),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        std::fs::write(
            ctx.store.materialized_book_path("b1").unwrap(),
            zip.finish().unwrap().into_inner(),
        )
        .unwrap();
        ctx.store
            .with_connection(|conn| {
                crate::database::sqlite_save_book_metadata_inner(
                    conn,
                    "b1",
                    r#"{"id":"b1","title":"Book","author":"A","format":"epub"}"#,
                )
            })
            .unwrap();
        let mut tui = TuiApp::load(&ctx).unwrap();
        tui.open_reader(&ctx);
        assert_eq!(tui.chapter_count, 2);
        assert!(tui.chapter_text.contains("First chapter."));
        tui.chapter = 1;
        tui.load_chapter(&ctx);
        assert!(tui.chapter_text.contains("Second chapter."));
        assert_eq!(tui.chapter_label(), "chapter 2");
    }

    fn tui_with(titles: &[&str]) -> TuiApp {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::open_at(dir.path()).unwrap();
        let mut tui = TuiApp::load(&ctx).unwrap();
        tui.books = titles
            .iter()
            .map(|t| BookRow {
                id: t.to_string(),
                title: t.to_string(),
                author: String::new(),
                format: "epub".into(),
                progress: 0.0,
                is_favorite: false,
            })
            .collect();
        tui.apply_filter();
        tui
    }

    #[test]
    fn first_book_is_selected_and_an_empty_filter_selects_nothing() {
        let empty = tui_with(&[]);
        assert_eq!(empty.library_state.selected(), None);
        let mut tui = tui_with(&["Alpha", "Beta"]);
        assert_eq!(tui.selected_book().map(|b| b.id.as_str()), Some("Alpha"));
        tui.filter = "zzz".into();
        tui.apply_filter();
        assert_eq!(tui.library_state.selected(), None);
        assert!(tui.selected_book().is_none());
        tui.filter = "bet".into();
        tui.apply_filter();
        assert_eq!(tui.selected_book().map(|b| b.id.as_str()), Some("Beta"));
    }

    #[test]
    fn a_fresh_library_opens_with_its_first_book_selected() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::open_at(dir.path()).unwrap();
        ctx.store
            .with_connection(|conn| {
                crate::database::sqlite_save_book_metadata_inner(
                    conn,
                    "b1",
                    r#"{"id":"b1","title":"Only Book","author":"A","format":"epub"}"#,
                )
            })
            .unwrap();
        let tui = TuiApp::load(&ctx).unwrap();
        assert_eq!(tui.selected_book().map(|b| b.id.as_str()), Some("b1"));
    }
}
