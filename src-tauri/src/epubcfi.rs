//! Rust-native EPUB CFI (Canonical Fragment Identifier) locator.
//!
//! Implements the standard path subset used by readers and the GUI:
//! `epubcfi(/6/4[chap01]!/4[body01]/10[para05]/2:33)` — a spine path, a `!`
//! divider, a content-document path, and `:N` character offsets. `[id]`
//! assertions are parsed and ignored for resolution. Ranges (`…,…`) resolve
//! to their start location.
//!
//! CFI child indexing: children of an element are enumerated 1-based with
//! **even** numbers for elements (`/4` = 2nd element child) and **odd**
//! numbers for character-data nodes (`/3` = 2nd text node).

/// A resolved CFI: 0-based spine position plus the content-document steps
/// (with their final character offset when present).
#[derive(Debug, Clone, PartialEq)]
pub struct CfiLocation {
    /// 0-based position in the OPF spine
    pub spine_index: usize,
    /// Content-document steps: (number, is_text_node)
    pub steps: Vec<(u32, bool)>,
    /// Character offset within the final node, when the CFI carries one
    pub offset: Option<u32>,
}

fn strip_optional_range(cfi: &str) -> &str {
    // A range CFI has two comma-separated paths; resolve to the start.
    match cfi.find(',') {
        Some(idx) => &cfi[..idx],
        None => cfi,
    }
}

/// Parse a CFI string into a [`CfiLocation`].
pub fn parse(cfi: &str) -> Result<CfiLocation, String> {
    let trimmed = cfi.trim();
    let inner = trimmed
        .strip_prefix("epubcfi(")
        .map(|rest| rest.strip_suffix(')').unwrap_or(rest))
        .unwrap_or(trimmed);

    let start_path = strip_optional_range(inner).trim();
    if start_path.is_empty() {
        return Err("empty CFI".to_string());
    }

    let (spine_part, content_part) = match start_path.split_once('!') {
        Some((spine, content)) => (spine, Some(content)),
        None => (start_path, None),
    };

    // Spine path: last even step selects the itemref (`/6/4` -> spine index 1).
    let mut spine_index = None;
    for step in parse_steps(spine_part)? {
        let (number, _) = step;
        if number % 2 == 0 {
            spine_index = Some(number as usize / 2 - 1);
        }
    }
    let spine_index = spine_index
        .ok_or_else(|| "CFI spine path has no element step (missing /N before '!')".to_string())?;

    // Content path: steps after '!', with an optional trailing ':offset'.
    let mut steps = Vec::new();
    let mut offset = None;
    if let Some(content) = content_part {
        let (path, tail_offset) = match content.rsplit_once(':') {
            Some((before, after))
                if after.chars().all(|c| c.is_ascii_digit()) && !after.is_empty() =>
            {
                offset = after.parse::<u32>().ok();
                (before, true)
            }
            _ => (content, false),
        };
        steps = parse_steps(path)?;
        let _ = tail_offset;
    }

    Ok(CfiLocation {
        spine_index,
        steps,
        offset,
    })
}

/// Parse `/6/4[id]` style steps into (number, is_text_node) pairs.
fn parse_steps(path: &str) -> Result<Vec<(u32, bool)>, String> {
    let mut steps = Vec::new();
    let mut rest = path.trim();
    while !rest.is_empty() {
        if let Some(after_bracket) = rest.strip_prefix('[') {
            // Skip the ID/text assertion entirely.
            let close = after_bracket
                .find(']')
                .ok_or_else(|| format!("unterminated '[' in CFI step: {rest}"))?;
            rest = &after_bracket[close + 1..];
            continue;
        }
        if let Some(after_slash) = rest.strip_prefix('/') {
            let digits: String = after_slash
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.is_empty() {
                return Err(format!("CFI step has no number: {rest}"));
            }
            let number: u32 = digits
                .parse()
                .map_err(|e| format!("CFI step number out of range: {e}"))?;
            steps.push((number, number % 2 == 1));
            rest = &after_slash[digits.len()..];
            continue;
        }
        return Err(format!("unexpected CFI content: {rest}"));
    }
    Ok(steps)
}

/// A minimal XML node tree for resolving content-document steps.
pub enum XmlNode {
    Element {
        name: String,
        children: Vec<XmlNode>,
    },
    Text {
        content: String,
    },
}

impl XmlNode {
    pub fn element_children(&self) -> Vec<&XmlNode> {
        match self {
            XmlNode::Element { children, .. } => children
                .iter()
                .filter(|c| matches!(c, XmlNode::Element { .. }))
                .collect(),
            XmlNode::Text { .. } => Vec::new(),
        }
    }

    pub fn text_nodes(&self) -> Vec<&str> {
        match self {
            XmlNode::Element { children, .. } => children
                .iter()
                .filter_map(|c| match c {
                    XmlNode::Text { content } => Some(content.as_str()),
                    _ => None,
                })
                .collect(),
            XmlNode::Text { content } => vec![content.as_str()],
        }
    }

    /// Concatenated text of this node and all descendants.
    pub fn flatten_text(&self) -> String {
        match self {
            XmlNode::Text { content } => content.clone(),
            XmlNode::Element { children, .. } => children
                .iter()
                .map(|c| c.flatten_text())
                .collect::<Vec<_>>()
                .concat(),
        }
    }
}

/// Build an [`XmlNode`] tree from XHTML source (tolerant of malformed input).
pub fn build_tree(xml: &str) -> XmlNode {
    use quick_xml::events::Event;

    let mut root = XmlNode::Element {
        name: "#document".to_string(),
        children: Vec::new(),
    };
    let mut stack: Vec<XmlNode> = Vec::new();

    fn push_child(stack: &mut [XmlNode], node: XmlNode) {
        if let Some(XmlNode::Element { children, .. }) = stack.last_mut() {
            children.push(node);
        }
    }
    fn open_element(stack: &mut Vec<XmlNode>, name: &str) {
        stack.push(XmlNode::Element {
            name: name.to_string(),
            children: Vec::new(),
        });
    }
    fn close_element(stack: &mut Vec<XmlNode>, root: &mut XmlNode) {
        if let Some(node) = stack.pop() {
            if stack.is_empty() {
                // Root element becomes the document's child.
                if let XmlNode::Element { children, .. } = root {
                    children.push(node);
                }
            } else {
                push_child(stack, node);
            }
        }
    }

    let mut reader = quick_xml::Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                open_element(&mut stack, &String::from_utf8_lossy(e.name().as_ref()));
            }
            Ok(Event::Empty(e)) => {
                push_child(
                    &mut stack,
                    XmlNode::Element {
                        name: String::from_utf8_lossy(e.name().as_ref()).to_string(),
                        children: Vec::new(),
                    },
                );
            }
            Ok(Event::Text(t)) => {
                push_child(
                    &mut stack,
                    XmlNode::Text {
                        content: t.unescape().unwrap_or_default().into_owned(),
                    },
                );
            }
            Ok(Event::CData(t)) => {
                push_child(
                    &mut stack,
                    XmlNode::Text {
                        content: String::from_utf8_lossy(t.as_ref()).into_owned(),
                    },
                );
            }
            Ok(Event::End(_)) => close_element(&mut stack, &mut root),
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    root
}

/// Resolve a parsed CFI against a content document tree, returning the text
/// of the target element (or the text node's content when the last step is
/// a character-data step).
pub fn resolve_text(root: &XmlNode, location: &CfiLocation) -> Result<String, String> {
    // The content path starts under the document root's first root element;
    // CFI steps index from the root element of the XHTML document.
    let mut current: &XmlNode = root
        .element_children()
        .first()
        .copied()
        .ok_or("content document is empty")?;

    // CFI step /2 refers to the FIRST element child of the root element
    // (CFI counts the root element itself as /2 under the virtual root).
    // Strip the conventional leading /2.
    let steps: &[(u32, bool)] = &location.steps;
    let mut remaining = steps;
    if let Some((first, _)) = steps.first() {
        if *first == 2 {
            remaining = &steps[1..];
        }
    }

    for (index, &(number, is_text)) in remaining.iter().enumerate() {
        let last = index + 1 == remaining.len();
        if is_text {
            let text_index = (number as usize).div_ceil(2) - 1;
            let texts = current.text_nodes();
            let content = texts
                .get(text_index)
                .ok_or_else(|| format!("CFI text step /{number} out of range"))?;
            return match (last, location.offset) {
                (true, Some(offset)) => Ok(content
                    .chars()
                    .skip(offset as usize)
                    .collect::<String>()
                    .trim()
                    .to_string()),
                _ => Ok(content.trim().to_string()),
            };
        }
        let element_index = number as usize / 2 - 1;
        let children = current.element_children();
        current = children
            .get(element_index)
            .ok_or_else(|| format!("CFI element step /{number} out of range"))?;
        if let (true, Some(offset)) = (last, location.offset) {
            // Offset within a final element step: resolve into its text.
            let text = current.flatten_text();
            return Ok(text
                .chars()
                .skip(offset as usize)
                .collect::<String>()
                .trim()
                .to_string());
        }
    }

    Ok(current.flatten_text())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spine_and_offsets() {
        let loc = parse("epubcfi(/6/4!/4/10/2:33)").unwrap();
        assert_eq!(loc.spine_index, 1); // /4 -> 2nd itemref
        assert_eq!(loc.steps, vec![(4, false), (10, false), (2, false)]);
        assert_eq!(loc.offset, Some(33));
    }

    #[test]
    fn resolves_range_to_start() {
        let loc = parse("epubcfi(/6/6!/4,/2:0,/2:100)").unwrap();
        assert_eq!(loc.spine_index, 2);
    }

    #[test]
    fn ignores_id_assertions() {
        let loc = parse("epubcfi(/6/4[chap01ref]!/4[body01]/10[para05])").unwrap();
        assert_eq!(loc.spine_index, 1);
        assert_eq!(loc.steps, vec![(4, false), (10, false)]);
    }

    #[test]
    fn rejects_missing_spine() {
        assert!(parse("epubcfi(/1:0)").is_err());
    }

    fn sample_tree() -> XmlNode {
        let xml = r#"<html><head><title>t</title></head><body>
            <p id="p1">First paragraph text.</p>
            <p id="p2">Second paragraph with the target words here.</p>
        </body></html>"#;
        build_tree(xml)
    }

    #[test]
    fn resolves_element_text() {
        let tree = sample_tree();
        // /4 = 2nd element under body ("p2"); body is /4 under html.
        let loc = parse("epubcfi(/6/4!/4/4)").unwrap();
        let text = resolve_text(&tree, &loc).unwrap();
        assert!(text.contains("Second paragraph"));
    }

    #[test]
    fn resolves_text_node_offset() {
        let tree = sample_tree();
        // body (/4) -> p2 (/4) -> its first text node (/1) at char 26.
        let loc = parse("epubcfi(/6/4!/4/4/1:26)").unwrap();
        let text = resolve_text(&tree, &loc).unwrap();
        assert!(text.starts_with("target"));
    }
}
