//! Normalised OPDS data model. Both dialects (Atom/OPDS 1.x and JSON/OPDS 2.0)
//! parse into these types, so the UI never has to know which one it is browsing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Dialect {
    Atom,
    Opds2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedKind {
    /// Only links to other feeds.
    Navigation,
    /// Only publications.
    Acquisition,
    /// Both (very common: a "home" feed with shelves and a few books).
    Mixed,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchKind {
    /// `href` is a URL template to expand with the query.
    Template,
    /// `href` points at an OpenSearch description document to fetch first.
    Description,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRef {
    pub href: String,
    pub kind: SearchKind,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub href: String,
    pub rel: String,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavItem {
    pub title: String,
    pub href: String,
    pub rel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    pub title: String,
    pub href: String,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetGroup {
    pub title: String,
    pub items: Vec<Facet>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AcquisitionKind {
    Generic,
    OpenAccess,
    Borrow,
    Buy,
    Sample,
    Subscribe,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub value: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acquisition {
    pub href: String,
    pub kind: AcquisitionKind,
    pub mime: String,
    /// File format Theorem can import (`epub`, `pdf`, `cbz`, `cbr`, `mobi`, `fb2`), if recognised.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<Price>,
    /// Media types of the indirect acquisition chain (e.g. `text/html` -> `application/epub+zip`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub indirect: Vec<String>,
    /// The file is protected by DRM Theorem cannot open.
    pub drm: bool,
    /// Direct, importable, DRM-free download.
    pub downloadable: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    /// Sanitise before rendering: this is the catalog's own HTML.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rights: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub identifiers: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<Series>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub acquisitions: Vec<Acquisition>,
    /// Index into `acquisitions` of the best direct download, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<usize>,
    /// Full-entry document for catalogs that list partial entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_href: Option<String>,
    /// The same publication on the catalog's website.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    /// Author/subject/series feeds the catalog links from this entry.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<Link>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub title: String,
    /// "See all" feed for this shelf.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    pub navigation: Vec<NavItem>,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    pub dialect: Dialect,
    pub kind: FeedKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<SearchRef>,
    pub facets: Vec<FacetGroup>,
    pub navigation: Vec<NavItem>,
    pub groups: Vec<Group>,
    pub entries: Vec<Entry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_results: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items_per_page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_index: Option<u64>,
}

impl Feed {
    pub fn empty(dialect: Dialect, base: &str) -> Self {
        Feed {
            id: base.to_string(),
            title: String::new(),
            subtitle: None,
            icon: None,
            updated: None,
            dialect,
            kind: FeedKind::Empty,
            self_url: None,
            next_url: None,
            prev_url: None,
            first_url: None,
            last_url: None,
            up_url: None,
            start_url: None,
            search: None,
            facets: Vec::new(),
            navigation: Vec::new(),
            groups: Vec::new(),
            entries: Vec::new(),
            total_results: None,
            items_per_page: None,
            start_index: None,
        }
    }

    /// Derive `kind` from what was actually found.
    pub fn finish(&mut self) {
        let has_pubs =
            !self.entries.is_empty() || self.groups.iter().any(|g| !g.entries.is_empty());
        let has_nav =
            !self.navigation.is_empty() || self.groups.iter().any(|g| !g.navigation.is_empty());
        self.kind = match (has_nav, has_pubs) {
            (true, true) => FeedKind::Mixed,
            (true, false) => FeedKind::Navigation,
            (false, true) => FeedKind::Acquisition,
            (false, false) => FeedKind::Empty,
        };
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTemplate {
    pub template: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthFlow {
    /// e.g. `http://opds-spec.org/auth/basic`
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_label: Option<String>,
}

/// What a fetched document turned out to be.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Outcome {
    Feed {
        feed: Box<Feed>,
    },
    /// An OpenSearch description document.
    OpenSearch {
        templates: Vec<SearchTemplate>,
    },
    /// An HTML page that advertises an OPDS feed.
    Discovery {
        href: String,
        mime: String,
    },
    /// An OPDS Authentication Document (the server wants a login).
    Authentication {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        flows: Vec<AuthFlow>,
    },
    Unsupported {
        reason: String,
    },
}
