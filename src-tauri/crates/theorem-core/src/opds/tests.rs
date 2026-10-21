use super::model::*;
use super::search::expand;
use super::*;

const GUT_ROOT: &[u8] = include_bytes!("../../tests/fixtures/opds/gutenberg-root.atom");
const GUT_SEARCH: &[u8] = include_bytes!("../../tests/fixtures/opds/gutenberg-search.atom");
const GUT_BOOK: &[u8] = include_bytes!("../../tests/fixtures/opds/gutenberg-book.atom");
const GUT_OSD: &[u8] = include_bytes!("../../tests/fixtures/opds/gutenberg-opensearch.xml");
const GUT_HTML: &[u8] = include_bytes!("../../tests/fixtures/opds/gutenberg-html.html");
const SE_NEW: &[u8] = include_bytes!("../../tests/fixtures/opds/se-new.atom");
const O2_HOME: &[u8] = include_bytes!("../../tests/fixtures/opds/opds2-home.json");
const O2_PUBS: &[u8] = include_bytes!("../../tests/fixtures/opds/opds2-publications.json");
const O2_NAV: &[u8] = include_bytes!("../../tests/fixtures/opds/opds2-navigation.json");

fn feed(body: &[u8], ct: &str, base: &str) -> Feed {
    match parse_catalog(body, ct, base) {
        Outcome::Feed { feed } => *feed,
        other => panic!("expected a feed, got {other:?}"),
    }
}

const ATOM: &str = "application/atom+xml;profile=opds-catalog";

// ---- real catalogs -------------------------------------------------------------------------

#[test]
fn gutenberg_root_is_a_navigation_feed() {
    let f = feed(GUT_ROOT, ATOM, "https://www.gutenberg.org/ebooks.opds/");
    assert_eq!(f.dialect, Dialect::Atom);
    assert_eq!(f.kind, FeedKind::Navigation);
    assert!(f.entries.is_empty());
    assert!(f.navigation.len() >= 3);
    let popular = f
        .navigation
        .iter()
        .find(|n| n.title == "Popular")
        .expect("Popular");
    assert_eq!(
        popular.href,
        "https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads"
    );
    assert_eq!(popular.summary.as_deref(), Some("Our most popular books."));
    assert!(popular
        .thumbnail
        .as_deref()
        .unwrap()
        .starts_with("data:image/png"));
    let search = f.search.expect("search advertised");
    assert_eq!(search.kind, SearchKind::Description);
    assert_eq!(
        search.href,
        "https://www.gutenberg.org/catalog/osd-books.xml"
    );
}

#[test]
fn gutenberg_search_results_resolve_relative_links_and_keep_summaries() {
    let f = feed(
        GUT_SEARCH,
        ATOM,
        "https://www.gutenberg.org/ebooks/search.opds/?query=dracula",
    );
    let dracula = f
        .navigation
        .iter()
        .find(|n| n.title == "Dracula")
        .expect("Dracula row");
    assert_eq!(dracula.href, "https://www.gutenberg.org/ebooks/345.opds");
    assert_eq!(dracula.summary.as_deref(), Some("Bram Stoker"));
    assert_eq!(
        f.start_url.as_deref(),
        Some("https://www.gutenberg.org/ebooks.opds/")
    );
    assert_eq!(
        f.self_url.as_deref(),
        Some("https://www.gutenberg.org/ebooks/search.opds/?query=dracula")
    );
}

#[test]
fn gutenberg_book_entry_exposes_downloads_metadata_and_related_feeds() {
    let f = feed(GUT_BOOK, ATOM, "https://www.gutenberg.org/ebooks/345.opds");
    assert_eq!(f.kind, FeedKind::Acquisition);
    // Gutenberg lists the no-images and illustrated editions as two entries.
    assert_eq!(f.entries.len(), 2);
    let e = &f.entries[0];
    assert_eq!(e.title, "Dracula");
    assert_eq!(e.authors, vec!["Stoker, Bram"]);
    assert_eq!(e.language.as_deref(), Some("en"));
    assert!(e.categories.iter().any(|c| c == "Gothic fiction"));
    assert!(e
        .summary
        .as_deref()
        .unwrap()
        .contains("Gothic horror novel"));
    // xhtml content keeps inline markup in order.
    assert!(e
        .summary
        .as_deref()
        .unwrap()
        .contains("<a href=\"//en.wikipedia.org/wiki/Dracula\">"));
    assert_eq!(e.acquisitions.len(), 2);
    assert!(e
        .acquisitions
        .iter()
        .all(|a| a.downloadable && a.size.is_some()));
    let primary = &e.acquisitions[e.primary.expect("a primary download")];
    assert_eq!(primary.format, Some("epub"));
    assert_eq!(
        e.cover.as_deref(),
        Some("https://www.gutenberg.org/cache/epub/345/pg345.cover.medium.jpg")
    );
    assert_eq!(
        e.thumbnail.as_deref(),
        Some("https://www.gutenberg.org/cache/epub/345/pg345.cover.small.jpg")
    );
    assert!(e
        .related
        .iter()
        .any(|l| l.href == "https://www.gutenberg.org/ebooks/author/190.opds"));
}

#[test]
fn gutenberg_opensearch_description_yields_a_working_template() {
    let t = match parse_catalog(
        GUT_OSD,
        "application/xml",
        "https://www.gutenberg.org/catalog/osd-books.xml",
    ) {
        Outcome::OpenSearch { templates } => templates,
        other => panic!("{other:?}"),
    };
    assert_eq!(t.len(), 1, "html and suggestion urls are ignored");
    assert_eq!(
        expand(&t[0].template, "bram stoker"),
        "http://m.gutenberg.org/ebooks/search.opds/?query=bram%20stoker"
    );
}

#[test]
fn standard_ebooks_new_releases() {
    let f = feed(
        SE_NEW,
        "application/atom+xml",
        "https://standardebooks.org/feeds/atom/new-releases",
    );
    assert_eq!(f.kind, FeedKind::Acquisition);
    assert!(f.entries.len() >= 10);
    for e in &f.entries {
        assert!(!e.title.is_empty() && !e.authors.is_empty(), "{}", e.title);
        assert!(
            e.acquisitions.iter().any(|a| a.format == Some("epub")),
            "{} has an epub",
            e.title
        );
        assert!(e.thumbnail.is_some());
    }
    // `type="html"` content is kept as markup, not double-escaped.
    assert!(f.entries[0].summary.as_deref().unwrap().contains("<p>"));
}

#[test]
fn html_page_without_a_link_is_rejected_cleanly() {
    match parse_catalog(GUT_HTML, "text/html", "https://www.gutenberg.org/") {
        Outcome::Unsupported { reason } => assert!(reason.contains("web page")),
        Outcome::Discovery { .. } => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn opds2_home_publications_and_navigation() {
    let f = feed(
        O2_HOME,
        "application/opds+json",
        "https://test.opds.io/2.0/home.json",
    );
    assert_eq!(f.dialect, Dialect::Opds2);
    assert_eq!(f.title, "OPDS 2.0 Test Catalog");
    assert!(!f.navigation.is_empty());

    let p = feed(
        O2_PUBS,
        "application/opds+json",
        "https://test.opds.io/2.0/publications.json",
    );
    assert_eq!(p.kind, FeedKind::Acquisition);
    assert_eq!(p.total_results, Some(14));
    let verne = p
        .entries
        .iter()
        .find(|e| e.title == "Voyage au centre de la Terre")
        .unwrap();
    assert_eq!(verne.authors, vec!["Jules Verne"]);
    assert_eq!(verne.subtitle.as_deref(), Some("Un super sous-titre"));
    assert_eq!(verne.publisher.as_deref(), Some("Feedbooks"));
    assert_eq!(
        verne.series.as_ref().map(|s| (s.name.as_str(), s.position)),
        Some(("Les classiques SF de Verne", Some(5.0)))
    );
    assert!(verne.categories.iter().any(|c| c == "Science Fiction"));
    assert_eq!(
        verne.thumbnail.as_deref(),
        Some("https://test.opds.io/assets/centredelaterre/small.jpg")
    );
    assert_eq!(
        verne.cover.as_deref(),
        Some("https://test.opds.io/assets/centredelaterre/normal.jpg")
    );
    let a = &verne.acquisitions[0];
    assert_eq!(
        (a.kind, a.format, a.downloadable),
        (AcquisitionKind::OpenAccess, Some("epub"), true)
    );
    assert_eq!(verne.primary, Some(0));

    let n = feed(
        O2_NAV,
        "application/json",
        "https://test.opds.io/2.0/navigation.json",
    );
    assert!(!n.navigation.is_empty());
}

// ---- other server flavours (synthetic, modelled on their documented output) ----------------

const CALIBRE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:dc="http://purl.org/dc/terms/" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata" xmlns:thr="http://purl.org/syndication/thread/1.0">
  <title>calibre Library</title>
  <id>urn:calibre:main</id>
  <updated>2026-01-01T00:00:00+00:00</updated>
  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="self" href="/opds/navcatalog/4f6e6577657374" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="search" href="/opds/search/{searchTerms}" type="application/atom+xml"/>
  <link rel="next" title="Next" href="/opds/navcatalog/4f6e6577657374?offset=25" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="http://opds-spec.org/sort/new" title="By Newest" href="/opds/new" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="http://opds-spec.org/sort/popular" href="/opds/popular" type="application/atom+xml;profile=opds-catalog"/>
  <opensearch:totalResults>312</opensearch:totalResults>
  <opensearch:itemsPerPage>25</opensearch:itemsPerPage>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <title>Authors</title>
    <id>calibre-nav:authors</id>
    <updated>2026-01-01T00:00:00+00:00</updated>
    <content type="text">12 authors</content>
    <link href="/opds/category/61757468" type="application/atom+xml;profile=opds-catalog" rel="subsection"/>
  </entry>
  <entry>
    <title>The Dispossessed</title>
    <id>urn:uuid:aaaa</id>
    <updated>2025-05-05T10:00:00+00:00</updated>
    <author><name>Ursula K. Le Guin</name><uri>/opds/author/1</uri></author>
    <calibre:series>Hainish Cycle</calibre:series>
    <calibre:series_index>5.5</calibre:series_index>
    <dc:language>eng</dc:language>
    <summary>An ambiguous utopia.</summary>
    <category term="Science Fiction" label="Science Fiction"/>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/get/epub/1" title="epub" length="123456"/>
    <link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/get/pdf/1"/>
    <link rel="x-stanza-cover-image" type="image/jpeg" href="/get/cover/1"/>
    <link rel="x-stanza-cover-image-thumbnail" type="image/jpeg" href="/get/thumb/1"/>
  </entry>
</feed>"#;

#[test]
fn calibre_content_server_with_relative_links_series_and_sort() {
    let f = feed(
        CALIBRE.as_bytes(),
        "application/atom+xml",
        "http://192.168.1.10:8080/opds/navcatalog/4f6e6577657374",
    );
    assert_eq!(f.kind, FeedKind::Mixed);
    assert_eq!(f.total_results, Some(312));
    assert_eq!(
        f.next_url.as_deref(),
        Some("http://192.168.1.10:8080/opds/navcatalog/4f6e6577657374?offset=25")
    );
    let s = f.search.expect("search");
    assert_eq!(
        (s.kind, s.href.as_str()),
        (
            SearchKind::Template,
            "http://192.168.1.10:8080/opds/search/{searchTerms}"
        )
    );
    assert_eq!(
        expand(&s.href, "le guin"),
        "http://192.168.1.10:8080/opds/search/le%20guin"
    );
    assert_eq!(f.navigation[0].summary.as_deref(), Some("12 authors"));
    let sort = f.facets.iter().find(|g| g.title == "Sort").unwrap();
    assert_eq!(sort.items.len(), 2);
    assert_eq!(sort.items[0].title, "By Newest");
    assert_eq!(sort.items[1].title, "Popular");
    let e = &f.entries[0];
    assert_eq!(e.series.as_ref().unwrap().name, "Hainish Cycle");
    assert_eq!(e.series.as_ref().unwrap().position, Some(5.5));
    assert_eq!(
        e.cover.as_deref(),
        Some("http://192.168.1.10:8080/get/cover/1")
    );
    assert_eq!(
        e.thumbnail.as_deref(),
        Some("http://192.168.1.10:8080/get/thumb/1")
    );
    assert_eq!(e.acquisitions[e.primary.unwrap()].format, Some("epub"));
    assert_eq!(e.summary.as_deref(), Some("<p>An ambiguous utopia.</p>"));
}

const FEEDBOOKS_STYLE: &str = r#"<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:thr="http://purl.org/syndication/thread/1.0">
  <id>x</id><title>Shelf</title>
  <link rel="http://opds-spec.org/facet" opds:facetGroup="Format" title="EPUB" href="/f?fmt=epub" thr:count="40" opds:activeFacet="true" type="application/atom+xml"/>
  <link rel="http://opds-spec.org/facet" opds:facetGroup="Format" title="PDF" href="/f?fmt=pdf" thr:count="9" type="application/atom+xml"/>
  <link rel="http://opds-spec.org/facet" opds:facetGroup="Language" title="French" href="/f?l=fr" type="application/atom+xml"/>
  <entry><id>b1</id><title>Bought</title>
    <link rel="http://opds-spec.org/acquisition/buy" href="/buy/1" type="text/html"><opds:price currencycode="EUR">4.99</opds:price><opds:indirectAcquisition type="application/epub+zip"/></link>
  </entry>
  <entry><id>b2</id><title>Borrowed</title>
    <link rel="http://opds-spec.org/acquisition/borrow" href="/borrow/2" type="application/atom+xml;type=entry;profile=opds-catalog">
      <opds:indirectAcquisition type="application/vnd.adobe.adept+xml"><opds:indirectAcquisition type="application/epub+zip"/></opds:indirectAcquisition>
    </link>
  </entry>
  <entry><id>b3</id><title>Sample and full</title>
    <link rel="http://opds-spec.org/acquisition/sample" href="/s/3.epub" type="application/epub+zip"/>
    <link rel="http://opds-spec.org/acquisition/open-access" href="/o/3.epub" type="application/epub+zip"/>
  </entry>
  <entry><id>b4</id><title>LCP</title>
    <link rel="http://opds-spec.org/acquisition" href="/l/4.lcpl" type="application/vnd.readium.lcp.license.v1.0+json"/>
  </entry>
</feed>"#;

#[test]
fn feedbooks_style_facets_prices_indirect_acquisition_and_drm() {
    let f = feed(
        FEEDBOOKS_STYLE.as_bytes(),
        ATOM,
        "https://example.org/shelf",
    );
    let fmt = f.facets.iter().find(|g| g.title == "Format").unwrap();
    assert_eq!(fmt.items.len(), 2);
    assert!(fmt.items[0].active && !fmt.items[1].active);
    assert_eq!(fmt.items[0].count, Some(40));
    assert!(f.facets.iter().any(|g| g.title == "Language"));

    let bought = &f.entries[0].acquisitions[0];
    assert_eq!(bought.kind, AcquisitionKind::Buy);
    assert_eq!(
        bought
            .price
            .as_ref()
            .map(|p| (p.value.as_str(), p.currency.as_str())),
        Some(("4.99", "EUR"))
    );
    assert!(!bought.downloadable, "a purchase is not a direct download");
    assert_eq!(f.entries[0].primary, None);

    let borrowed = &f.entries[1].acquisitions[0];
    assert!(borrowed.drm && !borrowed.downloadable);
    assert_eq!(
        borrowed.indirect,
        vec!["application/vnd.adobe.adept+xml", "application/epub+zip"]
    );

    // The open-access copy beats the sample.
    let both = &f.entries[2];
    assert_eq!(
        both.acquisitions[both.primary.unwrap()].kind,
        AcquisitionKind::OpenAccess
    );

    let lcp = &f.entries[3].acquisitions[0];
    assert!(lcp.drm && !lcp.downloadable);
}

#[test]
fn komga_kavita_style_cbz_and_series_navigation() {
    let doc = r#"<feed xmlns="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns">
      <id>s</id><title>One Piece</title>
      <link rel="self" href="/opds/v1.2/series/9?page=0" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
      <link rel="next" href="/opds/v1.2/series/9?page=1" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
      <link rel="search" href="/opds/v1.2/search?query={searchTerms}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
      <entry><id>c1</id><title>Chapter 1</title><author><name>Oda</name></author>
        <link rel="http://opds-spec.org/acquisition" href="/api/v1/books/1/file/chapter1.cbz" type="application/zip"/>
        <link rel="http://opds-spec.org/image" href="/api/v1/books/1/thumbnail" type="image/jpeg"/>
      </entry>
      <entry><id>c2</id><title>Chapter 2</title>
        <link rel="http://opds-spec.org/acquisition" href="/api/v1/books/2/file/chapter2.cbr" type="application/octet-stream"/>
      </entry>
    </feed>"#;
    let f = feed(
        doc.as_bytes(),
        "application/atom+xml",
        "https://komga.local/opds/v1.2/series/9?page=0",
    );
    assert_eq!(f.kind, FeedKind::Acquisition);
    assert_eq!(f.entries[0].acquisitions[0].format, Some("cbz"));
    assert_eq!(f.entries[1].acquisitions[0].format, Some("cbr"));
    assert_eq!(
        f.search.as_ref().unwrap().href,
        "https://komga.local/opds/v1.2/search?query={searchTerms}"
    );
    assert_eq!(
        expand(&f.search.unwrap().href, "one piece"),
        "https://komga.local/opds/v1.2/search?query=one%20piece"
    );
}

#[test]
fn single_entry_document_becomes_a_one_entry_feed() {
    let doc = r#"<entry xmlns="http://www.w3.org/2005/Atom"><id>e</id><title>Solo</title>
      <author><name>A</name></author>
      <link rel="http://opds-spec.org/acquisition/open-access" href="/solo.epub" type="application/epub+zip"/></entry>"#;
    let f = feed(
        doc.as_bytes(),
        "application/atom+xml;type=entry;profile=opds-catalog",
        "https://x.org/e/1",
    );
    assert_eq!(f.entries.len(), 1);
    assert_eq!(f.entries[0].acquisitions[0].href, "https://x.org/solo.epub");
}

#[test]
fn opds2_groups_facets_search_templates_and_pagination() {
    let doc = r#"{
      "metadata": {"title": "Shelf", "numberOfItems": 500, "itemsPerPage": 50, "currentPage": 3},
      "links": [
        {"rel": "self", "href": "/opds?page=3", "type": "application/opds+json"},
        {"rel": ["next"], "href": "/opds?page=4", "type": "application/opds+json"},
        {"rel": "previous", "href": "/opds?page=2"},
        {"rel": "search", "href": "/opds/search{?query}", "type": "application/opds+json", "templated": true}
      ],
      "facets": [{"metadata": {"title": "Language"}, "links": [
        {"rel": "self", "href": "/opds?lang=en", "title": "English", "properties": {"numberOfItems": 30}},
        {"href": "/opds?lang=fr", "title": "French"}]}],
      "groups": [
        {"metadata": {"title": "New"}, "links": [{"rel": "self", "href": "/opds/new", "title": "More"}],
         "publications": [{"metadata": {"title": "Fresh", "author": [{"name": "A"}, "B"]},
           "links": [{"rel": "http://opds-spec.org/acquisition", "href": "/f.epub", "type": "application/epub+zip"}]}]},
        {"metadata": {"title": "Subjects"}, "navigation": [{"href": "/s/1", "title": "History", "type": "application/opds+json"}]}
      ]}"#;
    let f = feed(
        doc.as_bytes(),
        "application/opds+json",
        "https://lib.example/opds?page=3",
    );
    assert_eq!(f.kind, FeedKind::Mixed);
    assert_eq!(f.start_index, Some(101));
    assert_eq!(
        f.next_url.as_deref(),
        Some("https://lib.example/opds?page=4")
    );
    assert_eq!(
        f.prev_url.as_deref(),
        Some("https://lib.example/opds?page=2")
    );
    let s = f.search.clone().unwrap();
    assert_eq!(
        expand(&s.href, "dune"),
        "https://lib.example/opds/search?query=dune"
    );
    assert_eq!(f.facets[0].items[0].active, true);
    assert_eq!(f.facets[0].items[0].count, Some(30));
    assert_eq!(f.groups.len(), 2);
    assert_eq!(
        f.groups[0].href.as_deref(),
        Some("https://lib.example/opds/new")
    );
    assert_eq!(f.groups[0].entries[0].authors, vec!["A", "B"]);
    assert_eq!(f.groups[1].navigation[0].href, "https://lib.example/s/1");
}

// ---- discovery, auth, templates ------------------------------------------------------------

#[test]
fn html_page_advertising_a_feed_is_discovered() {
    let html = r#"<!doctype html><html><head>
      <link rel="stylesheet" href="/a.css">
      <link rel="alternate" type="application/rss+xml" href="/rss">
      <link rel="alternate" type="application/atom+xml;profile=opds-catalog" href="/opds/">
      </head><body>hi</body></html>"#;
    match parse_catalog(
        html.as_bytes(),
        "text/html",
        "https://books.example/library/",
    ) {
        Outcome::Discovery { href, .. } => assert_eq!(href, "https://books.example/opds/"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn authentication_document_is_recognised() {
    let doc = r#"{"id":"https://x/auth","title":"Library login","description":"Sign in with your card",
      "authentication":[{"type":"http://opds-spec.org/auth/basic","labels":{"login":"Card number","password":"PIN"}},
                        {"type":"http://opds-spec.org/auth/oauth/implicit"}]}"#;
    match parse_catalog(
        doc.as_bytes(),
        "application/opds-authentication+json",
        "https://x/",
    ) {
        Outcome::Authentication { title, flows, .. } => {
            assert_eq!(title, "Library login");
            assert_eq!(flows.len(), 2);
            assert_eq!(flows[0].login_label.as_deref(), Some("Card number"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn template_expansion_covers_opensearch_and_rfc6570() {
    assert_eq!(
        expand("https://x/s?q={searchTerms}&p={startPage?}", "a b"),
        "https://x/s?q=a%20b"
    );
    assert_eq!(
        expand("https://x/s?q={searchTerms}&p={startPage}", "a"),
        "https://x/s?q=a&p=1"
    );
    assert_eq!(
        expand("https://x/s{?query,title}", "a&b"),
        "https://x/s?query=a%26b"
    );
    assert_eq!(
        expand("https://x/s?lang=en{&query}", "é"),
        "https://x/s?lang=en&query=%C3%A9"
    );
    assert_eq!(
        expand("https://x/s/{searchTerms}", "x/y"),
        "https://x/s/x%2Fy"
    );
    assert_eq!(
        expand("https://x/s?q={searchTerms?}&c={count?}&l={language?}", "q"),
        "https://x/s?q=q&l=*"
    );
    assert_eq!(expand("no variables", "q"), "no variables");
    assert_eq!(
        expand("https://x/{unterminated", "q"),
        "https://x/{unterminated"
    );
    assert_eq!(expand("https://x/s?q={searchTerms}", ""), "https://x/s?q=");
}

// ---- hostile and broken input --------------------------------------------------------------

#[test]
fn garbage_empty_and_wrong_documents_never_panic() {
    for (body, ct) in [
        (&b""[..], ""),
        (b"   \n", "application/atom+xml"),
        (b"not xml, not json", "text/plain"),
        (b"{", "application/json"),
        (b"[]", "application/json"),
        (b"{\"foo\": 1}", "application/json"),
        (
            b"<rss version=\"2.0\"><channel/></rss>",
            "application/rss+xml",
        ),
        (b"<feed", "application/atom+xml"),
        (b"\xff\xfe\x00\x01 binary", "application/atom+xml"),
    ] {
        match parse_catalog(body, ct, "https://x.org/") {
            Outcome::Unsupported { reason } => assert!(!reason.is_empty()),
            Outcome::Feed { .. } => {}
            other => panic!("{ct}: {other:?}"),
        }
    }
}

#[test]
fn truncated_feed_keeps_the_entries_that_arrived() {
    let cut = &CALIBRE[..CALIBRE
        .find("<entry>\n    <title>The Dispossessed")
        .unwrap()
        + 80];
    let f = feed(cut.as_bytes(), "application/atom+xml", "https://x.org/opds");
    assert_eq!(f.navigation.len(), 1);
}

#[test]
fn deeply_nested_documents_are_refused() {
    let doc = format!("{}x{}", "<a>".repeat(500), "</a>".repeat(500));
    assert!(matches!(
        parse_catalog(doc.as_bytes(), "application/xml", "https://x.org/"),
        Outcome::Unsupported { .. }
    ));
}

#[test]
fn latin1_bodies_are_decoded() {
    let xml = b"<?xml version=\"1.0\" encoding=\"iso-8859-1\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><id>i</id><title>Caf\xe9</title></feed>";
    let f = feed(xml, "application/atom+xml", "https://x.org/");
    assert_eq!(f.title, "Café");
}

#[test]
fn script_in_summaries_is_passed_through_for_the_ui_to_sanitise() {
    // The parser does not sanitise; the contract is documented in the model and enforced in the UI.
    let doc = r#"<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>t</title>
      <entry><id>e</id><title>t</title><content type="html">&lt;script&gt;alert(1)&lt;/script&gt;ok</content></entry></feed>"#;
    let f = feed(doc.as_bytes(), "application/atom+xml", "https://x.org/");
    assert!(f.entries[0]
        .summary
        .as_deref()
        .unwrap()
        .contains("<script>"));
}

#[test]
fn relative_urls_survive_an_unparseable_base() {
    let doc = r#"<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>t</title>
      <entry><id>e</id><title>t</title><link rel="http://opds-spec.org/acquisition" href="b.epub" type="application/epub+zip"/></entry></feed>"#;
    let f = feed(doc.as_bytes(), "application/atom+xml", "not a url");
    assert_eq!(f.entries[0].acquisitions[0].href, "b.epub");
}

#[test]
fn xml_base_on_the_feed_changes_resolution() {
    let doc = r#"<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://cdn.example/books/"><id>i</id><title>t</title>
      <entry><id>e</id><title>t</title><link rel="http://opds-spec.org/acquisition" href="b.epub" type="application/epub+zip"/></entry></feed>"#;
    let f = feed(doc.as_bytes(), "application/atom+xml", "https://x.org/opds");
    assert_eq!(
        f.entries[0].acquisitions[0].href,
        "https://cdn.example/books/b.epub"
    );
}
