//! OPDS 2.0 (JSON, Readium Web Publication Manifest vocabulary).

use super::model::*;
use super::util::*;
use serde_json::Value;

fn s(v: &Value) -> Option<String> {
    v.as_str()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// A localised string map (`{"en": "...", "fr": "..."}`): English if present, else the first.
fn localized(m: &serde_json::Map<String, Value>) -> Option<String> {
    m.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("en") || k.to_ascii_lowercase().starts_with("en-"))
        .and_then(|(_, v)| s(v))
        .or_else(|| m.values().find_map(s))
}

fn name_of(v: &Value) -> Option<String> {
    match v {
        Value::String(_) => s(v),
        Value::Object(o) => o.get("name").and_then(|n| match n {
            Value::String(_) => s(n),
            // Localised names: {"en": "...", "fr": "..."}
            Value::Object(m) => localized(m),
            _ => None,
        }),
        _ => None,
    }
}

fn names(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(name_of).collect(),
        Some(other) => name_of(other).into_iter().collect(),
        None => Vec::new(),
    }
}

fn one_or_many(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    }
}

fn rels(link: &Value) -> String {
    match link.get("rel") {
        Some(Value::String(r)) => r.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn title_of(v: &Value) -> Option<String> {
    v.get("title").and_then(|t| match t {
        Value::String(_) => s(t),
        Value::Object(m) => localized(m),
        _ => None,
    })
}

fn num(v: Option<&Value>) -> Option<u64> {
    v.and_then(|n| {
        n.as_u64()
            .or_else(|| n.as_str().and_then(|t| t.trim().parse().ok()))
    })
}

fn parse_indirect(v: &Value, out: &mut Vec<String>) {
    for node in one_or_many(Some(v)) {
        if let Some(t) = node.get("type").and_then(s) {
            out.push(t);
        }
        if let Some(child) = node.get("child") {
            parse_indirect(child, out);
        }
    }
}

fn acquisition(link: &Value, base: &str, kind: AcquisitionKind) -> Option<Acquisition> {
    let href = resolve(base, link.get("href")?.as_str()?);
    if href.is_empty() {
        return None;
    }
    let props = link.get("properties");
    let mut indirect = Vec::new();
    if let Some(ia) = props.and_then(|p| p.get("indirectAcquisition")) {
        parse_indirect(ia, &mut indirect);
    }
    let price = props.and_then(|p| p.get("price")).map(|p| Price {
        value: p
            .get("value")
            .map(|v| {
                v.as_f64()
                    .map(|f| f.to_string())
                    .or_else(|| s(v))
                    .unwrap_or_default()
            })
            .unwrap_or_default(),
        currency: p.get("currency").and_then(s).unwrap_or_default(),
    });
    let mut a = Acquisition {
        href,
        kind,
        mime: link.get("type").and_then(s).unwrap_or_default(),
        format: None,
        title: title_of(link),
        size: num(link.get("length")),
        price,
        indirect,
        drm: false,
        downloadable: false,
    };
    finish_acquisition(&mut a);
    Some(a)
}

fn publication(p: &Value, base: &str) -> Entry {
    let meta = p.get("metadata").unwrap_or(&Value::Null);
    let title = title_of(meta).unwrap_or_else(|| "Untitled".to_string());
    let mut e = Entry {
        id: meta
            .get("identifier")
            .and_then(s)
            .unwrap_or_else(|| title.clone()),
        title,
        subtitle: meta.get("subtitle").and_then(|v| match v {
            Value::String(_) => s(v),
            Value::Object(m) => localized(m),
            _ => None,
        }),
        authors: names(meta.get("author").or_else(|| meta.get("creator"))),
        summary: meta.get("description").and_then(s).map(|d| {
            // OPDS 2 descriptions are plain text or HTML; keep markup, wrap bare text.
            if d.contains('<') {
                d
            } else {
                format!("<p>{}</p>", escape_html(&d))
            }
        }),
        published: meta.get("published").and_then(s),
        updated: meta.get("modified").and_then(s),
        language: one_or_many(meta.get("language")).into_iter().find_map(s),
        publisher: names(meta.get("publisher")).into_iter().next(),
        rights: meta.get("rights").and_then(s),
        identifiers: meta.get("identifier").and_then(s).into_iter().collect(),
        categories: names(meta.get("subject")),
        ..Entry::default()
    };

    if let Some(belongs) = meta.get("belongsTo") {
        if let Some(series) = one_or_many(belongs.get("series")).into_iter().next() {
            if let Some(name) = name_of(series) {
                e.series = Some(Series {
                    name,
                    position: series.get("position").and_then(|v| {
                        v.as_f64()
                            .or_else(|| v.as_str().and_then(|t| t.parse().ok()))
                    }),
                });
            }
        }
    }

    // Images: smallest is the thumbnail, largest the cover.
    let mut images: Vec<(String, u64)> = one_or_many(p.get("images"))
        .into_iter()
        .filter_map(|i| {
            let href = resolve(base, i.get("href")?.as_str()?);
            let area = num(i.get("width")).unwrap_or(0) * num(i.get("height")).unwrap_or(0);
            Some((href, area))
        })
        .collect();
    images.sort_by_key(|(_, a)| *a);
    e.thumbnail = images.first().map(|(h, _)| h.clone());
    e.cover = images.last().map(|(h, _)| h.clone());

    for l in one_or_many(p.get("links")) {
        let rel = rels(l).to_ascii_lowercase();
        let mime = l.get("type").and_then(s).unwrap_or_default();
        let href = match l.get("href").and_then(|h| h.as_str()) {
            Some(h) => resolve(base, h),
            None => continue,
        };
        if let Some(kind) = kind_of_rel(&rel) {
            if let Some(a) = acquisition(l, base, kind) {
                e.acquisitions.push(a);
            }
        } else if (rel.contains("alternate") || rel.contains("self")) && is_entry_mime(&mime) {
            e.detail_href.get_or_insert(href);
        } else if rel.contains("alternate") && essence(&mime) == "text/html" {
            e.web_url.get_or_insert(href);
        } else if rel.contains("image") || rel.contains("cover") {
            let thumb = rel.contains("thumbnail");
            if thumb && e.thumbnail.is_none() {
                e.thumbnail = Some(href);
            } else if !thumb && e.cover.is_none() {
                e.cover = Some(href);
            }
        } else if is_catalog_mime(&mime) && rel.contains("related") {
            e.related.push(Link {
                href,
                rel,
                mime,
                title: title_of(l),
            });
        }
    }
    if e.acquisitions.is_empty() {
        // Plain links to files without an acquisition rel.
        for l in one_or_many(p.get("links")) {
            let mime = l.get("type").and_then(s).unwrap_or_default();
            if let Some(a) = acquisition(l, base, AcquisitionKind::Generic) {
                if format_of(&mime, &a.href).is_some() {
                    e.acquisitions.push(a);
                }
            }
        }
    }
    if e.thumbnail.is_none() {
        e.thumbnail = e.cover.clone();
    }
    if e.cover.is_none() {
        e.cover = e.thumbnail.clone();
    }
    e.primary = pick_primary(&e.acquisitions);
    e
}

fn nav_item(n: &Value, base: &str) -> Option<NavItem> {
    let href = resolve(base, n.get("href")?.as_str()?);
    if href.is_empty() {
        return None;
    }
    Some(NavItem {
        title: title_of(n).unwrap_or_else(|| href.clone()),
        href,
        rel: rels(n),
        summary: n.get("description").and_then(s),
        count: num(n.get("properties").and_then(|p| p.get("numberOfItems"))),
        thumbnail: None,
        updated: None,
    })
}

fn is_template(l: &Value) -> bool {
    l.get("templated")
        .and_then(|t| t.as_bool())
        .unwrap_or(false)
        || l.get("href")
            .and_then(|h| h.as_str())
            .map(|h| h.contains('{'))
            .unwrap_or(false)
}

pub fn parse(doc: &Value, base: &str) -> Result<Feed, String> {
    if !doc.is_object() {
        return Err("OPDS 2.0 document must be a JSON object".into());
    }
    let mut feed = Feed::empty(Dialect::Opds2, base);
    let meta = doc.get("metadata").unwrap_or(&Value::Null);
    feed.title = title_of(meta).unwrap_or_else(|| "Catalog".to_string());
    feed.subtitle = meta
        .get("subtitle")
        .and_then(s)
        .or_else(|| meta.get("description").and_then(s));
    feed.updated = meta.get("modified").and_then(s);
    feed.total_results = num(meta.get("numberOfItems"));
    feed.items_per_page = num(meta.get("itemsPerPage"));
    if let (Some(page), Some(per)) = (num(meta.get("currentPage")), feed.items_per_page) {
        feed.start_index = Some(page.saturating_sub(1) * per + 1);
    }

    let mut search_template: Option<String> = None;
    for l in one_or_many(doc.get("links")) {
        let rel = rels(l).to_ascii_lowercase();
        let href_raw = match l.get("href").and_then(|h| h.as_str()) {
            Some(h) => h,
            None => continue,
        };
        let href = if is_template(l) {
            super::atom::resolve_template(base, href_raw)
        } else {
            resolve(base, href_raw)
        };
        if rel_is(&rel, "self") {
            feed.self_url.get_or_insert(href);
        } else if rel_is(&rel, "next") {
            feed.next_url.get_or_insert(href);
        } else if rel_is(&rel, "previous") || rel_is(&rel, "prev") {
            feed.prev_url.get_or_insert(href);
        } else if rel_is(&rel, "first") {
            feed.first_url.get_or_insert(href);
        } else if rel_is(&rel, "last") {
            feed.last_url.get_or_insert(href);
        } else if rel_is(&rel, "up") {
            feed.up_url.get_or_insert(href);
        } else if rel_is(&rel, "start") {
            feed.start_url.get_or_insert(href);
        } else if rel_is(&rel, "search") {
            if is_template(l) || href.contains('{') {
                search_template.get_or_insert(href);
            } else if essence(l.get("type").and_then(|t| t.as_str()).unwrap_or(""))
                == "application/opensearchdescription+xml"
            {
                feed.search.get_or_insert(SearchRef {
                    href,
                    kind: SearchKind::Description,
                });
            }
        }
    }
    if let Some(t) = search_template {
        feed.search = Some(SearchRef {
            href: t,
            kind: SearchKind::Template,
        });
    }

    feed.navigation = one_or_many(doc.get("navigation"))
        .into_iter()
        .filter_map(|n| nav_item(n, base))
        .collect();
    feed.entries = one_or_many(doc.get("publications"))
        .into_iter()
        .map(|p| publication(p, base))
        .collect();

    for f in one_or_many(doc.get("facets")) {
        let title = f
            .get("metadata")
            .and_then(title_of)
            .unwrap_or_else(|| "Filters".to_string());
        let items: Vec<Facet> = one_or_many(f.get("links"))
            .into_iter()
            .filter_map(|l| {
                let href = resolve(base, l.get("href")?.as_str()?);
                Some(Facet {
                    title: title_of(l).unwrap_or_else(|| href.clone()),
                    href,
                    active: rel_is(&rels(l).to_ascii_lowercase(), "self"),
                    count: num(l.get("properties").and_then(|p| p.get("numberOfItems"))),
                })
            })
            .collect();
        if !items.is_empty() {
            feed.facets.push(FacetGroup { title, items });
        }
    }

    for g in one_or_many(doc.get("groups")) {
        let mut group = Group {
            title: g.get("metadata").and_then(title_of).unwrap_or_default(),
            ..Group::default()
        };
        for l in one_or_many(g.get("links")) {
            if rel_is(&rels(l).to_ascii_lowercase(), "self") {
                if let Some(h) = l.get("href").and_then(|h| h.as_str()) {
                    group.href = Some(resolve(base, h));
                }
            }
        }
        group.navigation = one_or_many(g.get("navigation"))
            .into_iter()
            .filter_map(|n| nav_item(n, base))
            .collect();
        group.entries = one_or_many(g.get("publications"))
            .into_iter()
            .map(|p| publication(p, base))
            .collect();
        if !group.entries.is_empty() || !group.navigation.is_empty() {
            feed.groups.push(group);
        }
    }

    feed.finish();
    Ok(feed)
}

/// Is this JSON an OPDS Authentication Document?
pub fn as_authentication(doc: &Value) -> Option<Outcome> {
    let flows = doc.get("authentication")?.as_array()?;
    if doc.get("publications").is_some() || doc.get("navigation").is_some() {
        return None;
    }
    let flows = flows
        .iter()
        .filter_map(|f| {
            Some(AuthFlow {
                kind: f.get("type")?.as_str()?.to_string(),
                login_label: f.get("labels").and_then(|l| l.get("login")).and_then(s),
                password_label: f.get("labels").and_then(|l| l.get("password")).and_then(s),
            })
        })
        .collect();
    Some(Outcome::Authentication {
        title: doc
            .get("title")
            .and_then(s)
            .unwrap_or_else(|| "Sign in".to_string()),
        description: doc.get("description").and_then(s),
        flows,
    })
}
