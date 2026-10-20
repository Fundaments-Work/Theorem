//! Atom / OPDS 1.x (0.9 through 1.2) feeds and entry documents.

use super::model::*;
use super::util::*;
use super::xml::Node;

struct RawLink<'a> {
    node: &'a Node,
    href: String,
    rel: String,
    mime: String,
    title: Option<String>,
}

fn links<'a>(node: &'a Node, base: &str) -> Vec<RawLink<'a>> {
    node.children
        .iter()
        .filter(|c| c.local == "link" && c.is_atom())
        .filter_map(|c| {
            let href = c.attr("href")?;
            let href = resolve(base, href);
            if href.is_empty() {
                return None;
            }
            Some(RawLink {
                node: c,
                href,
                rel: c.attr("rel").unwrap_or("").trim().to_string(),
                mime: c.attr("type").unwrap_or("").trim().to_string(),
                title: c
                    .attr("title")
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
            })
        })
        .collect()
}

fn parse_u64(s: Option<String>) -> Option<u64> {
    s.and_then(|v| v.trim().parse::<u64>().ok())
}

fn link_count(n: &Node) -> Option<u64> {
    n.attr_prefixed("thr", "count")
        .or_else(|| n.attr("count"))
        .and_then(|v| v.trim().parse().ok())
}

/// Entry text as HTML. `text` is escaped, `html` is already markup (escaped inside the XML),
/// `xhtml` is a nested `<div>`.
fn text_construct(node: &Node) -> Option<String> {
    let kind = node.attr("type").unwrap_or("text").to_ascii_lowercase();
    let out = if kind == "xhtml" || kind.contains("xhtml") {
        match node.children.iter().find(|c| c.local == "div") {
            Some(div) => div.inner_markup(),
            None => node.inner_markup(),
        }
    } else if kind == "html" || kind == "text/html" {
        node.text.trim().to_string()
    } else {
        let t = node.text.trim();
        if t.is_empty() {
            String::new()
        } else {
            t.split("\n\n")
                .map(|p| format!("<p>{}</p>", escape_html(p.trim())))
                .collect::<Vec<_>>()
                .join("")
        }
    };
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

fn plain(node: &Node) -> Option<String> {
    text_construct(node)
        .map(|h| strip_html_text(&h))
        .filter(|t| !t.is_empty())
}

fn parse_acquisition(l: &RawLink<'_>, kind: AcquisitionKind) -> Acquisition {
    let mut indirect = Vec::new();
    let mut cur = l
        .node
        .children
        .iter()
        .find(|c| c.local == "indirectacquisition");
    while let Some(n) = cur {
        if let Some(t) = n.attr("type") {
            indirect.push(t.trim().to_string());
        }
        cur = n.children.iter().find(|c| c.local == "indirectacquisition");
    }
    let price = l
        .node
        .children
        .iter()
        .find(|c| c.local == "price")
        .map(|p| Price {
            value: p.text.trim().to_string(),
            currency: p.attr("currencycode").unwrap_or("").to_string(),
        });
    let mut a = Acquisition {
        href: l.href.clone(),
        kind,
        mime: l.mime.clone(),
        format: None,
        title: l.title.clone(),
        size: l.node.attr("length").and_then(|v| v.trim().parse().ok()),
        price,
        indirect,
        drm: false,
        downloadable: false,
    };
    finish_acquisition(&mut a);
    a
}

fn is_image_rel(rel: &str) -> (bool, bool) {
    let r = rel.to_ascii_lowercase();
    let thumb = r.ends_with("thumbnail") || r.contains("thumbnail");
    let cover =
        !thumb && (r.contains("opds-spec.org/image") || r.contains("cover") || r == "image");
    (cover, thumb)
}

fn is_nav_rel(rel: &str) -> bool {
    let r = rel.trim().to_ascii_lowercase();
    if r.is_empty() || r == "subsection" {
        return true;
    }
    if r.starts_with("http://opds-spec.org/") {
        return !(r.contains("acquisition")
            || r.contains("image")
            || r.contains("facet")
            || r.contains("cover"));
    }
    r == "related"
}

enum Item {
    Entry(Box<Entry>),
    Nav(NavItem),
}

fn parse_entry(e: &Node, base: &str) -> Item {
    let base_owned;
    let base = match e.attr_prefixed("xml", "base") {
        Some(b) => {
            base_owned = resolve(base, b);
            base_owned.as_str()
        }
        None => base,
    };
    let id = e.text_of("id").unwrap_or_default();
    let title = e.text_of("title").unwrap_or_else(|| "Untitled".to_string());
    let raw = links(e, base);

    let mut acquisitions: Vec<Acquisition> = Vec::new();
    let mut cover = None;
    let mut thumbnail = None;
    let mut detail_href = None;
    let mut web_url = None;
    let mut related: Vec<Link> = Vec::new();
    let mut nav_target: Option<&RawLink<'_>> = None;

    for l in &raw {
        let rel_lower = l.rel.to_ascii_lowercase();
        if let Some(kind) = kind_of_rel(&rel_lower) {
            acquisitions.push(parse_acquisition(l, kind));
            continue;
        }
        let (is_cover, is_thumb) = is_image_rel(&rel_lower);
        if (is_cover || is_thumb)
            && (essence(&l.mime).starts_with("image/")
                || l.mime.is_empty()
                || l.href.starts_with("data:"))
        {
            if is_thumb {
                thumbnail.get_or_insert_with(|| l.href.clone());
            } else {
                cover.get_or_insert_with(|| l.href.clone());
            }
            continue;
        }
        if rel_is(&rel_lower, "alternate") || rel_lower.is_empty() {
            if essence(&l.mime) == "text/html" || essence(&l.mime) == "application/xhtml+xml" {
                web_url.get_or_insert_with(|| l.href.clone());
                continue;
            }
            if is_entry_mime(&l.mime) {
                detail_href.get_or_insert_with(|| l.href.clone());
                continue;
            }
        }
        if rel_is(&rel_lower, "self") && is_entry_mime(&l.mime) {
            detail_href.get_or_insert_with(|| l.href.clone());
            continue;
        }
        if is_catalog_mime(&l.mime) {
            if rel_is(&rel_lower, "related") && !l.href.is_empty() {
                related.push(Link {
                    href: l.href.clone(),
                    rel: l.rel.clone(),
                    mime: l.mime.clone(),
                    title: l.title.clone(),
                });
            }
            if nav_target.is_none() && is_nav_rel(&rel_lower) {
                nav_target = Some(l);
            }
        }
    }

    // Yahoo MRSS images (Standard Ebooks and others).
    for m in e.children.iter().filter(|c| c.prefix == "media") {
        let Some(url) = m.attr("url") else { continue };
        let url = resolve(base, url);
        match m.local.as_str() {
            "thumbnail" => {
                thumbnail.get_or_insert(url);
            }
            "content"
                if m.attr("medium") == Some("image")
                    || essence(m.attr("type").unwrap_or("")).starts_with("image/") =>
            {
                cover.get_or_insert(url);
            }
            _ => {}
        }
    }

    // Links with no acquisition rel that still point at an importable file.
    if acquisitions.is_empty() {
        for l in &raw {
            let rel_lower = l.rel.to_ascii_lowercase();
            let loose = rel_lower.is_empty()
                || rel_is(&rel_lower, "enclosure")
                || rel_is(&rel_lower, "alternate");
            if loose && format_of(&l.mime, &l.href).is_some() && essence(&l.mime) != "text/html" {
                acquisitions.push(parse_acquisition(l, AcquisitionKind::Generic));
            }
        }
    }

    let summary_node = e
        .child("content")
        .filter(|c| text_construct(c).is_some())
        .or_else(|| e.child("summary"));

    if acquisitions.is_empty() {
        if let Some(target) = nav_target {
            return Item::Nav(NavItem {
                title,
                href: target.href.clone(),
                rel: target.rel.clone(),
                summary: summary_node.and_then(plain),
                count: link_count(target.node),
                thumbnail: thumbnail.or(cover),
                updated: e.text_of("updated"),
            });
        }
    }

    let mut authors: Vec<String> = Vec::new();
    for a in e
        .children
        .iter()
        .filter(|c| c.local == "author" && c.is_atom())
    {
        if let Some(n) = a
            .text_of("name")
            .or_else(|| Some(a.text.trim().to_string()).filter(|t| !t.is_empty()))
        {
            authors.push(n);
        }
    }
    for c in e
        .children
        .iter()
        .filter(|c| c.local == "creator" && !c.is_atom())
    {
        let t = c.text.trim();
        if !t.is_empty() {
            authors.push(t.to_string());
        }
    }
    let mut seen = std::collections::HashSet::new();
    authors.retain(|a| seen.insert(a.to_ascii_lowercase()));

    let mut categories: Vec<String> = Vec::new();
    for c in e.children.iter().filter(|c| c.local == "category") {
        if let Some(label) = c.attr("label").or_else(|| c.attr("term")) {
            let label = label.trim();
            if !label.is_empty() && !categories.iter().any(|x| x.eq_ignore_ascii_case(label)) {
                categories.push(label.to_string());
            }
        }
    }

    let series = e
        .children
        .iter()
        .find(|c| c.local == "series" && !c.is_atom())
        .map(|c| c.text.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|name| Series {
            name,
            position: e
                .children
                .iter()
                .find(|c| c.local == "series_index" || c.local == "seriesindex")
                .and_then(|c| c.text.trim().parse::<f64>().ok()),
        });

    let identifiers = e
        .children
        .iter()
        .filter(|c| c.local == "identifier" && !c.is_atom())
        .map(|c| c.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    let mut entry = Entry {
        id: if id.is_empty() { title.clone() } else { id },
        title,
        subtitle: None,
        authors,
        summary: summary_node.and_then(text_construct),
        published: e
            .text_of("published")
            .or_else(|| e.text_of_any("issued"))
            .or_else(|| {
                e.children
                    .iter()
                    .find(|c| c.local == "date" && !c.is_atom())
                    .map(|c| c.text.trim().to_string())
                    .filter(|t| !t.is_empty())
            }),
        updated: e.text_of("updated"),
        language: e
            .children
            .iter()
            .find(|c| c.local == "language" && !c.is_atom())
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty()),
        publisher: e
            .children
            .iter()
            .find(|c| c.local == "publisher" && !c.is_atom())
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty()),
        rights: e.child("rights").and_then(plain),
        identifiers,
        categories,
        series,
        thumbnail: thumbnail.clone().or_else(|| cover.clone()),
        cover: cover.or(thumbnail),
        primary: pick_primary(&acquisitions),
        acquisitions,
        detail_href,
        web_url,
        related,
    };
    // A partial entry (listing without links to a file) is still opened through its detail link.
    if entry.detail_href.is_none() {
        if let Some(t) = nav_target {
            entry.detail_href = Some(t.href.clone());
        }
    }
    Item::Entry(Box::new(entry))
}

/// Parse an Atom `<feed>` (or a lone `<entry>`) into the normalised model.
pub fn parse(root: &Node, base: &str) -> Result<Feed, String> {
    let base_owned;
    let base = match root.attr_prefixed("xml", "base") {
        Some(b) => {
            base_owned = resolve(base, b);
            base_owned.as_str()
        }
        None => base,
    };
    let mut feed = Feed::empty(Dialect::Atom, base);

    let entries: Vec<&Node> = if root.local == "entry" {
        vec![root]
    } else if root.local == "feed" {
        root.children
            .iter()
            .filter(|c| c.local == "entry" && c.is_atom())
            .collect()
    } else {
        return Err(format!(
            "not an Atom document (root element <{}>)",
            root.local
        ));
    };

    if root.local == "feed" {
        feed.id = root.text_of("id").unwrap_or_else(|| base.to_string());
        feed.title = root.text_of("title").unwrap_or_default();
        feed.subtitle = root.child("subtitle").and_then(plain);
        feed.icon = root
            .text_of("icon")
            .or_else(|| root.text_of("logo"))
            .map(|i| resolve(base, &i));
        feed.updated = root.text_of("updated");
        feed.total_results = parse_u64(root.text_of_any("totalresults"));
        feed.items_per_page = parse_u64(root.text_of_any("itemsperpage"));
        feed.start_index = parse_u64(root.text_of_any("startindex"));

        let mut search_template: Option<String> = None;
        let mut search_description: Option<String> = None;
        let mut facet_groups: Vec<FacetGroup> = Vec::new();
        let mut sort_items: Vec<Facet> = Vec::new();

        for l in links(root, base) {
            let rel = l.rel.to_ascii_lowercase();
            if rel_is(&rel, "self") {
                feed.self_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "next") {
                feed.next_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "previous") || rel_is(&rel, "prev") {
                feed.prev_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "first") {
                feed.first_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "last") {
                feed.last_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "up") {
                feed.up_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "start") {
                feed.start_url.get_or_insert(l.href.clone());
            } else if rel_is(&rel, "search") {
                if essence(&l.mime) == "application/opensearchdescription+xml" {
                    search_description.get_or_insert(l.href.clone());
                } else if is_catalog_mime(&l.mime) || l.mime.is_empty() {
                    // The href was resolved against the feed, which would percent-encode `{searchTerms}`.
                    let raw = l.node.attr("href").unwrap_or("");
                    search_template.get_or_insert(resolve_template(base, raw));
                }
            } else if rel == "http://opds-spec.org/facet" {
                let group = l
                    .node
                    .attr("facetgroup")
                    .unwrap_or("Filters")
                    .trim()
                    .to_string();
                let facet = Facet {
                    title: l.title.clone().unwrap_or_else(|| l.href.clone()),
                    href: l.href.clone(),
                    active: l
                        .node
                        .attr("activefacet")
                        .map(|v| v.eq_ignore_ascii_case("true"))
                        .unwrap_or(false),
                    count: link_count(l.node),
                };
                match facet_groups.iter_mut().find(|g| g.title == group) {
                    Some(g) => g.items.push(facet),
                    None => facet_groups.push(FacetGroup {
                        title: group,
                        items: vec![facet],
                    }),
                }
            } else if let Some(sort) = rel.strip_prefix("http://opds-spec.org/sort/") {
                sort_items.push(Facet {
                    title: l.title.clone().unwrap_or_else(|| {
                        let mut s = sort.replace('-', " ");
                        if let Some(f) = s.get_mut(0..1) {
                            f.make_ascii_uppercase();
                        }
                        s
                    }),
                    href: l.href.clone(),
                    active: false,
                    count: None,
                });
            }
        }
        feed.search = search_template
            .map(|href| SearchRef {
                href,
                kind: SearchKind::Template,
            })
            .or_else(|| {
                search_description.map(|href| SearchRef {
                    href,
                    kind: SearchKind::Description,
                })
            });
        if !sort_items.is_empty() {
            facet_groups.insert(
                0,
                FacetGroup {
                    title: "Sort".into(),
                    items: sort_items,
                },
            );
        }
        feed.facets = facet_groups;
    } else {
        feed.title = root.text_of("title").unwrap_or_default();
    }

    for e in entries {
        match parse_entry(e, base) {
            Item::Entry(en) => feed.entries.push(*en),
            Item::Nav(n) => feed.navigation.push(n),
        }
    }
    if feed.title.is_empty() {
        feed.title = "Catalog".to_string();
    }
    feed.finish();
    Ok(feed)
}

/// Resolve a URL template against `base` without letting the URL parser mangle `{vars}`.
pub fn resolve_template(base: &str, template: &str) -> String {
    let t = template.trim();
    if t.starts_with("http://") || t.starts_with("https://") {
        return t.to_string();
    }
    // Resolve the part before the first variable, keep the rest verbatim.
    let cut = t.find('{').unwrap_or(t.len());
    let (head, tail) = t.split_at(cut);
    if head.is_empty() {
        // A template that starts with a variable: expand it against the origin's path as-is.
        return format!("{}{}", resolve(base, "."), tail);
    }
    format!("{}{}", resolve(base, head), tail)
}
