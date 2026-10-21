//! A tiny element tree over quick-xml. Catalog feeds are small (and capped by the
//! fetch layer), so a tree is simpler and safer to test than a hand-rolled state machine.

use super::util::escape_html;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

const MAX_DEPTH: usize = 64;

#[derive(Debug, Default, Clone)]
pub struct Node {
    /// Lowercased local name (`opds:price` -> `price`).
    pub local: String,
    /// Lowercased prefix, empty for the default namespace.
    pub prefix: String,
    /// Attributes with lowercased local names (`opds:facetGroup` -> `facetgroup`) plus the xml prefix.
    pub attrs: Vec<(String, String, String)>,
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(_, l, _)| l == name)
            .map(|(_, _, v)| v.as_str())
    }

    pub fn attr_prefixed(&self, prefix: &str, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(p, l, _)| p == prefix && l == name)
            .map(|(_, _, v)| v.as_str())
    }

    pub fn is_atom(&self) -> bool {
        self.prefix.is_empty() || self.prefix == "atom"
    }

    /// First child in the default (Atom) namespace.
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children
            .iter()
            .find(|c| c.local == name && c.is_atom())
    }

    /// First child with this local name under any namespace prefix (`dc:`, `dcterms:`, `opds:` ...).
    pub fn child_any(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.local == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.local == name)
    }

    pub fn text_of(&self, name: &str) -> Option<String> {
        self.child(name)
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty())
    }

    pub fn text_of_any(&self, name: &str) -> Option<String> {
        self.child_any(name)
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty())
    }

    /// Serialise the children back to markup (for `type="xhtml"` content).
    pub fn inner_markup(&self) -> String {
        let mut out = String::new();
        for c in &self.children {
            c.write_markup(&mut out);
        }
        out.trim().to_string()
    }

    fn write_markup(&self, out: &mut String) {
        if self.local == "#text" {
            out.push_str(&escape_html(&self.text));
            return;
        }
        let name = if self.prefix.is_empty() {
            self.local.clone()
        } else {
            format!("{}:{}", self.prefix, self.local)
        };
        out.push('<');
        out.push_str(&name);
        for (p, l, v) in &self.attrs {
            if p == "xmlns" || l == "xmlns" {
                continue;
            }
            out.push(' ');
            if !p.is_empty() {
                out.push_str(p);
                out.push(':');
            }
            out.push_str(l);
            out.push_str("=\"");
            out.push_str(&escape_html(v).replace('"', "&quot;"));
            out.push('"');
        }
        out.push('>');
        for c in &self.children {
            c.write_markup(out);
        }
        out.push_str("</");
        out.push_str(&name);
        out.push('>');
    }
}

fn split_name(raw: &str) -> (String, String) {
    match raw.split_once(':') {
        Some((p, l)) => (p.to_ascii_lowercase(), l.to_ascii_lowercase()),
        None => (String::new(), raw.to_ascii_lowercase()),
    }
}

fn node_from(e: &BytesStart<'_>) -> Node {
    let raw = String::from_utf8_lossy(e.name().as_ref()).into_owned();
    let (prefix, local) = split_name(&raw);
    let mut node = Node {
        local,
        prefix,
        ..Node::default()
    };
    for attr in e.attributes().with_checks(false).flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let (ap, al) = split_name(&key);
        let value = attr
            .unescape_value()
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&attr.value).into_owned());
        node.attrs.push((ap, al, value));
    }
    node
}

fn text_of_event(bytes: &[u8], unescaped: Option<String>) -> String {
    unescaped.unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

/// Parse a document into its root element. Returns `Err` for malformed or empty input.
pub fn parse(xml: &str) -> Result<Node, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = false;
    reader.config_mut().expand_empty_elements = false;
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if stack.len() >= MAX_DEPTH {
                    return Err("document is nested too deeply".into());
                }
                stack.push(node_from(&e));
            }
            Ok(Event::Empty(e)) => {
                let node = node_from(&e);
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Ok(Event::End(_)) => {
                if let Some(node) = stack.pop() {
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(node),
                        None => root = Some(node),
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(top) = stack.last_mut() {
                    let text = text_of_event(&t, t.unescape().ok().map(|c| c.into_owned()));
                    top.text.push_str(&text);
                    if !text.is_empty() {
                        top.children.push(Node {
                            local: "#text".into(),
                            text,
                            ..Node::default()
                        });
                    }
                }
            }
            Ok(Event::CData(c)) => {
                if let Some(top) = stack.last_mut() {
                    let text = String::from_utf8_lossy(&c).into_owned();
                    top.text.push_str(&text);
                    top.children.push(Node {
                        local: "#text".into(),
                        text,
                        ..Node::default()
                    });
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                // A feed truncated or broken after real content is still worth showing.
                if root.is_some() || !stack.is_empty() {
                    break;
                }
                return Err(format!("invalid XML: {e}"));
            }
        }
    }
    // Close anything left open by a truncated document.
    while let Some(node) = stack.pop() {
        match stack.last_mut() {
            Some(parent) => parent.children.push(node),
            None => root = Some(node),
        }
    }
    root.ok_or_else(|| "empty document".to_string())
}
