use super::doc_merge::*;
use super::doc_ops::*;
use super::*;

fn combine(entries: &[(&str, u64, &str)]) -> std::collections::HashMap<String, String> {
    let mut per_key: std::collections::HashMap<String, Vec<(u64, String)>> =
        std::collections::HashMap::new();
    for (key, at, value) in entries {
        per_key
            .entry(key.to_string())
            .or_default()
            .push((*at, value.to_string()));
    }
    combine_doc_values(per_key)
}

#[test]
fn the_newest_copy_of_a_record_wins_whatever_the_order() {
    for order in [[0, 1, 2], [2, 1, 0], [1, 2, 0]] {
        let copies = [
            ("anno:b:a", 10, r#"{"note":"old"}"#),
            ("anno:b:a", 30, r#"{"note":"newest"}"#),
            ("anno:b:a", 20, r#"{"note":"middle"}"#),
        ];
        let ordered: Vec<_> = order.iter().map(|&i| copies[i]).collect();
        assert_eq!(combine(&ordered)["anno:b:a"], r#"{"note":"newest"}"#);
    }
}

#[test]
fn the_copy_with_the_newest_change_wins_not_the_one_written_last() {
    // B wrote its stale copy into the doc after A's edit (B had not read
    // it yet): the copy written last is not the newest change.
    let edited = r#"{"title":"Dune (edited)","metadataUpdatedAt":"2026-10-25T10:00:05.000Z"}"#;
    let stale = r#"{"title":"Dune","metadataUpdatedAt":"2026-10-25T09:00:00.000Z"}"#;
    let out = combine(&[("book:1", 10, edited), ("book:1", 20, stale)]);
    assert_eq!(out["book:1"], edited);
    // Annotations: updatedAt; epoch numbers as well as ISO dates.
    let out = combine(&[
        (
            "anno:b:a",
            10,
            r#"{"note":"new","updatedAt":1700000005000}"#,
        ),
        (
            "anno:b:a",
            20,
            r#"{"note":"old","updatedAt":1700000000000}"#,
        ),
    ]);
    assert_eq!(
        out["anno:b:a"],
        r#"{"note":"new","updatedAt":1700000005000}"#
    );
    // A book read later on one device and edited earlier on another: the
    // later reading position and the newer metadata edit both survive.
    let read = r#"{"title":"Dune","metadataUpdatedAt":"2026-10-25T09:00:00.000Z","lastReadAt":"2026-10-25T11:00:00.000Z"}"#;
    let out = combine(&[("book:1", 30, edited), ("book:1", 20, read)]);
    let book: serde_json::Value = serde_json::from_str(&out["book:1"]).unwrap();
    assert_eq!(book["title"], "Dune (edited)");
    assert_eq!(book["metadataUpdatedAt"], "2026-10-25T10:00:05.000Z");
    assert_eq!(book["lastReadAt"], "2026-10-25T11:00:00.000Z");
    // Copies without stamps (or with equal ones): the one written last.
    let out = combine(&[("vocab:v", 10, r#"{"t":1}"#), ("vocab:v", 20, r#"{"t":2}"#)]);
    assert_eq!(out["vocab:v"], r#"{"t":2}"#);
    let out = combine(&[
        ("anno:b:a", 20, r#"{"n":2,"updatedAt":5}"#),
        ("anno:b:a", 10, r#"{"n":1,"updatedAt":5}"#),
    ]);
    assert_eq!(out["anno:b:a"], r#"{"n":2,"updatedAt":5}"#);
    // A stamped copy beats an unstamped or unreadable one.
    let out = combine(&[
        (
            "collection:c",
            10,
            r#"{"updatedAt":"2026-01-01T00:00:00Z"}"#,
        ),
        ("collection:c", 20, "{}"),
    ]);
    assert_eq!(
        out["collection:c"],
        r#"{"updatedAt":"2026-01-01T00:00:00Z"}"#
    );
}

#[test]
fn every_record_kind_is_taken_whole_never_mixed() {
    for key in [
        "book:1",
        "anno:1:2",
        "annotation:2",
        "collection:c",
        "cover:1",
        "rss_article:a",
        "vocab:v",
    ] {
        let out = combine(&[(key, 2, r#"{"a":2}"#), (key, 1, r#"{"a":1,"b":1}"#)]);
        assert_eq!(out[key], r#"{"a":2}"#, "{key}");
    }
}

#[test]
fn shared_objects_merge_with_newer_fields_winning() {
    let out = combine(&[
        ("settings", 2, r#"{"theme":"dark"}"#),
        ("settings", 1, r#"{"theme":"light","fontSize":18}"#),
    ]);
    let merged: serde_json::Value = serde_json::from_str(&out["settings"]).unwrap();
    assert_eq!(merged["theme"], "dark");
    assert_eq!(merged["fontSize"], 18);
}

fn deleted(kind: &str, id: &str) -> DeletedEntity {
    DeletedEntity {
        entity_type: kind.into(),
        entity_id: id.into(),
    }
}

#[test]
fn a_deleted_entity_takes_all_its_doc_keys_and_nothing_else() {
    let keys: Vec<String> = [
        "book:b1",
        "cover:b1",
        "anno:b1:a1",
        "anno:b1:a2",
        "book:b2",
        "cover:b2",
        "anno:b2:a3",
        "anno:b2:a4",
        "annotation:a4",
        "collection:c1",
        "collection:c2",
        "rss_article:r1",
        "vocab:v1",
        "vocabulary:v1",
        "settings",
        "book:b10",
        "rss_feed:f1",
        "rss_feed:f2",
        "rss_feed:settings",
    ]
    .iter()
    .map(|k| k.to_string())
    .collect();
    let mut purged = keys_of_deleted(
        &[
            deleted("book", "b1"),
            deleted("annotation", "a4"),
            deleted("collection", "c1"),
            deleted("rss_article", "r1"),
            deleted("vocabulary", "v1"),
            deleted("book", ""),
            deleted("feed", "f1"),
            deleted("rss_feed", "f2"),
            deleted("feed", "settings"),
        ],
        &keys,
    );
    purged.sort();
    assert_eq!(
        purged,
        vec![
            "anno:b1:a1",
            "anno:b1:a2",
            "anno:b2:a4",
            "annotation:a4",
            "book:b1",
            "collection:c1",
            "cover:b1",
            "rss_article:r1",
            "rss_feed:f1",
            "rss_feed:f2",
            "rss_feed:settings",
            "vocab:v1",
            "vocabulary:v1",
        ]
    );
}

#[test]
fn delivery_tracks_multiple_concurrent_tokens() {
    let mut delivery = Delivery::default();
    let mut seen1 = std::collections::HashMap::new();
    seen1.insert("book:1".into(), vec![iroh_blobs::Hash::new(b"v1")]);
    let t1 = delivery.record_pending(seen1);

    let mut seen2 = std::collections::HashMap::new();
    seen2.insert("book:2".into(), vec![iroh_blobs::Hash::new(b"v2")]);
    let t2 = delivery.record_pending(seen2);

    assert!(delivery.ack(t1).is_ok());
    assert!(delivery.ack(t2).is_ok());
}

#[test]
fn copies_are_compared_by_content_in_any_order() {
    let (a, b) = (iroh_blobs::Hash::new(b"a"), iroh_blobs::Hash::new(b"b"));
    let one = hashes_by_key(&[("k".into(), 1, a), ("k".into(), 2, b), ("j".into(), 1, a)]);
    let other = hashes_by_key(&[("k".into(), 9, b), ("k".into(), 3, a), ("j".into(), 7, a)]);
    // Same content, other timestamps and order: nothing changed.
    assert_eq!(one, other);
    let changed = hashes_by_key(&[("k".into(), 1, a), ("j".into(), 1, b)]);
    assert_ne!(one.get("j"), changed.get("j"));
    assert_ne!(one.get("k"), changed.get("k"));
}

#[test]
fn lists_are_joined_and_odd_values_fall_back_to_newest() {
    let out = combine(&[("collections", 1, "[1]"), ("collections", 2, "[2]")]);
    assert_eq!(out["collections"], "[1,2]");
    let out = combine(&[("reading_stats", 1, "{}"), ("reading_stats", 2, "not json")]);
    assert_eq!(out["reading_stats"], "not json");
    let out = combine(&[("x", 5, "[1]"), ("x", 4, r#"{"a":1}"#)]);
    assert_eq!(out["x"], "[1]");
}

fn header(key: &str, at: u64, deletion: bool) -> EntryHeader {
    let hash = if deletion {
        iroh_blobs::Hash::EMPTY
    } else {
        iroh_blobs::Hash::new(format!("{key}@{at}"))
    };
    (key.to_string(), at, hash)
}

fn deleted_keys(headers: &[EntryHeader]) -> (Vec<String>, std::collections::HashSet<String>) {
    let keys: Vec<String> = headers.iter().map(|(k, _, _)| k.clone()).collect();
    let changed: std::collections::HashSet<&String> = keys.iter().collect();
    let (deleted, gone) = deletions(headers, &changed);
    (deleted.into_iter().map(|d| d.key).collect(), gone)
}

#[test]
fn an_item_is_deleted_when_its_newest_copy_in_any_doc_is_a_deletion() {
    // Deleted in one pairing's doc after the copy in another pairing's doc.
    let (deleted, _) = deleted_keys(&[
        header("book:1", 20_000, true),
        header("book:1", 10_000, false),
    ]);
    assert_eq!(deleted, vec!["book:1".to_string()]);
    // Written again after the deletion (re-added, or edited later): kept.
    let (deleted, gone) = deleted_keys(&[
        header("book:1", 20_000, true),
        header("book:1", 30_000, false),
    ]);
    assert!(deleted.is_empty());
    assert!(gone.is_empty());
}

#[test]
fn deletion_times_are_reported_in_milliseconds() {
    let keys = ["anno:b:a".to_string()];
    let changed: std::collections::HashSet<&String> = keys.iter().collect();
    let (deleted, _) = deletions(&[header("anno:b:a", 1_700_000_000_123_456, true)], &changed);
    assert_eq!(
        deleted,
        vec![DeletedDocKey {
            key: "anno:b:a".into(),
            at: 1_700_000_000_123
        }]
    );
}

#[test]
fn only_items_are_reported_deleted_but_no_deleted_key_is_delivered() {
    let (deleted, gone) = deleted_keys(&[
        header("annotations", 5, true),
        header("annotations", 1, false),
        header("tomb:book:9", 5, true),
        header("cover:1", 5, true),
        header("settings", 5, false),
        header("rss_feed:f", 5, true),
        header("vocab:v", 5, true),
    ]);
    assert_eq!(
        deleted,
        vec!["rss_feed:f".to_string(), "vocab:v".to_string()]
    );
    for key in [
        "annotations",
        "tomb:book:9",
        "cover:1",
        "rss_feed:f",
        "vocab:v",
    ] {
        assert!(gone.contains(key), "{key} must not be delivered as current");
    }
    assert!(!gone.contains("settings"));
}

#[test]
fn keys_outside_the_changed_set_are_left_alone() {
    let headers = [header("book:1", 5, true), header("book:2", 5, true)];
    let only = "book:2".to_string();
    let changed: std::collections::HashSet<&String> = [&only].into_iter().collect();
    let (deleted, _) = deletions(&headers, &changed);
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].key, "book:2");
}

#[test]
fn whole_lists_are_for_older_versions_only() {
    for key in LEGACY_LIST_KEYS {
        assert!(is_legacy_list_key(key));
    }
    for key in [
        "book:1",
        "anno:b:a",
        "vocab:v",
        "tomb:book:1",
        "settings",
        "reading_stats",
    ] {
        assert!(!is_legacy_list_key(key), "{key}");
    }
    assert!(reads_legacy_lists(0));
    assert!(reads_legacy_lists(1));
    assert!(!reads_legacy_lists(
        theorem_sync_core::sync_protocol::SYNC_PROTOCOL
    ));
}

#[test]
fn a_prefix_deletion_never_takes_a_key_that_is_kept() {
    let own = vec!["tomb:book:1".to_string(), "tomb:book:12".to_string()];
    let keep: std::collections::HashSet<String> = ["tomb:book:12".to_string()].into();
    assert!(shadows_other_key("tomb:book:1", &own, &keep));
    let keep_none = std::collections::HashSet::new();
    assert!(!shadows_other_key("tomb:book:1", &own, &keep_none));
}

/// A real iroh-docs engine in memory, with one doc that two authors
/// write to: "here" (this device) and "there" (the other device, whose
/// entries arrived by sync).
mod with_a_doc {
    use super::*;

    struct Fixture {
        doc: iroh_docs::api::Doc,
        blobs: iroh_blobs::api::Store,
        here: iroh_docs::AuthorId,
        there: iroh_docs::AuthorId,
        _router: iroh::protocol::Router,
        _docs: iroh_docs::protocol::Docs,
    }

    async fn fixture() -> Fixture {
        let ep = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .bind()
            .await
            .unwrap();
        let blobs = iroh_blobs::store::mem::MemStore::new();
        let gossip = iroh_gossip::net::Gossip::builder().spawn(ep.clone());
        let docs = iroh_docs::protocol::Docs::memory()
            .spawn(ep.clone(), (*blobs).clone(), gossip.clone())
            .await
            .unwrap();
        let router = iroh::protocol::Router::builder(ep)
            .accept(iroh_gossip::ALPN, gossip)
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();
        let api = docs.api().clone();
        let doc = api.create().await.unwrap();
        let here = api.author_create().await.unwrap();
        let there = api.author_create().await.unwrap();
        Fixture {
            doc,
            blobs: (*blobs).clone(),
            here,
            there,
            _router: router,
            _docs: docs,
        }
    }

    /// Writes as provisioning does; how many were written (none failing).
    async fn written(
        f: &Fixture,
        author: iroh_docs::AuthorId,
        protocol: u8,
        entries: &[(String, String)],
    ) -> usize {
        let (n, _, error) =
            write_entries_to_doc(&f.doc, &f.blobs, author, protocol, entries, true).await;
        assert_eq!(error, None);
        n
    }

    fn entry(key: &str, value: &str) -> (String, String) {
        (key.to_string(), value.to_string())
    }

    async fn deleted_now(doc: &iroh_docs::api::Doc) -> Vec<String> {
        deleted_keys(&read_headers(doc, None).await).0
    }

    #[tokio::test]
    async fn an_unchanged_value_is_not_written_again() {
        let f = fixture().await;
        let book = [entry("book:1", r#"{"title":"Dune"}"#)];
        assert_eq!(written(&f, f.here, 2, &book).await, 1);
        assert_eq!(written(&f, f.here, 2, &book).await, 0);
        let edited = [entry("book:1", r#"{"title":"Dune Messiah"}"#)];
        assert_eq!(written(&f, f.here, 2, &edited).await, 1);
        // The same value from the other device is a different entry: ours is written.
        let theirs = [entry("book:2", "x")];
        assert_eq!(written(&f, f.there, 2, &theirs).await, 1);
        assert_eq!(written(&f, f.here, 2, &theirs).await, 1);
    }

    #[tokio::test]
    async fn whole_lists_go_only_to_devices_on_older_versions() {
        let f = fixture().await;
        let lists = [entry("annotations", "[]"), entry("anno:b:a", "{}")];
        assert_eq!(written(&f, f.here, 2, &lists).await, 1);
        assert!(f
            .doc
            .get_exact(f.here, "annotations", false)
            .await
            .unwrap()
            .is_none());
        assert_eq!(written(&f, f.here, 0, &lists).await, 1);
        assert!(f
            .doc
            .get_exact(f.here, "annotations", false)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn a_device_back_after_months_does_not_bring_back_what_was_deleted() {
        let f = fixture().await;
        let book = [entry("book:1", r#"{"title":"Dune"}"#)];
        written(&f, f.here, 2, &book).await;
        assert!(deleted_now(&f.doc).await.is_empty());

        // Deleted on the other device while this one was away.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        f.doc.del(f.there, "book:1").await.unwrap();
        assert_eq!(deleted_now(&f.doc).await, vec!["book:1".to_string()]);

        // This device starts again and provisions its unchanged copy: not
        // rewritten, so the deletion stays the newest entry.
        assert_eq!(written(&f, f.here, 2, &book).await, 0);
        assert_eq!(deleted_now(&f.doc).await, vec!["book:1".to_string()]);

        // A changed copy is not written over the deletion either: it is
        // reported, for the app to decide.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let edited = [entry("book:1", r#"{"title":"Dune","rating":5}"#)];
        let (n, reported, error) =
            write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edited, true).await;
        assert_eq!((n, error), (0, None));
        assert_eq!(reported.len(), 1);
        assert_eq!(reported[0].key, "book:1");
        assert_eq!(deleted_now(&f.doc).await, vec!["book:1".to_string()]);

        // Edited here after the deletion: the app writes it anyway and it stays.
        let (n, _, error) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edited, false).await;
        assert_eq!((n, error), (1, None));
        assert!(deleted_now(&f.doc).await.is_empty());
    }

    #[tokio::test]
    async fn a_device_that_never_sent_an_item_does_not_bring_it_back() {
        let f = fixture().await;
        // Written and deleted by the other device before this one wrote it.
        written(&f, f.there, 2, &[entry("book:7", r#"{"title":"Old"}"#)]).await;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        f.doc.del(f.there, "book:7").await.unwrap();

        let copy = [entry("book:7", r#"{"title":"Old"}"#), entry("book:8", "{}")];
        let (n, reported, error) =
            write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &copy, true).await;
        assert_eq!((n, error), (1, None));
        assert_eq!(
            reported.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(),
            vec!["book:7"]
        );
        assert!(reported[0].at > 0);
        assert_eq!(deleted_now(&f.doc).await, vec!["book:7".to_string()]);
        // Settings and the like are never held back.
        let (n, reported, _) = write_entries_to_doc(
            &f.doc,
            &f.blobs,
            f.here,
            2,
            &[entry("settings", "{}")],
            true,
        )
        .await;
        assert_eq!((n, reported.len()), (1, 0));
    }

    fn anno(id: &str, updated: i64, note: &str) -> String {
        format!(r#"{{"id":"{id}","bookId":"b1","updatedAt":{updated},"note":"{note}"}}"#)
    }

    async fn own_group(f: &Fixture, author: iroh_docs::AuthorId, book: &str) -> Option<String> {
        let entry = f
            .doc
            .get_exact(author, format!("annos:{book}:").into_bytes(), false)
            .await
            .unwrap()?;
        content_of(&f.blobs, entry.content_hash()).await
    }

    async fn read(f: &Fixture) -> DocRead {
        read_docs(std::slice::from_ref(&f.doc), &f.blobs, None, None).await
    }

    #[tokio::test]
    async fn annotations_go_into_one_group_per_book_rewritten_only_when_changed() {
        let f = fixture().await;
        let entries = [
            entry("anno:b1:x", &anno("x", 10, "x")),
            entry("anno:b1:y", &anno("y", 10, "y")),
            entry("anno:b2:z", &anno("z", 10, "z")),
            entry("book:b1", "{}"),
        ];
        assert_eq!(written(&f, f.here, 3, &entries).await, 4);
        // Two groups and the book; no single entries for a device on 3.
        let keys: Vec<String> = read_headers(&f.doc, None)
            .await
            .into_iter()
            .map(|(k, _, _)| k)
            .collect();
        assert_eq!(keys.len(), 3, "{keys:?}");
        assert!(keys.contains(&"annos:b1:".to_string()));
        assert!(keys.contains(&"annos:b2:".to_string()));
        let before = f
            .doc
            .get_exact(f.here, "annos:b1:", false)
            .await
            .unwrap()
            .unwrap();
        // Nothing changed: nothing written, the group keeps its date.
        assert_eq!(written(&f, f.here, 3, &entries).await, 0);
        let after = f
            .doc
            .get_exact(f.here, "annos:b1:", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before.timestamp(), after.timestamp());
        // One annotation changed: only its book's group is written.
        let edit = [entry("anno:b1:y", &anno("y", 20, "y2"))];
        assert_eq!(written(&f, f.here, 3, &edit).await, 1);
        let group =
            crate::sync_annotations::Group::parse(&own_group(&f, f.here, "b1").await.unwrap())
                .unwrap();
        assert_eq!(group.annotations["x"].get(), anno("x", 10, "x"));
        assert_eq!(group.annotations["y"].get(), anno("y", 20, "y2"));
        // Read back as one item per annotation, as the app knows them.
        let r = read(&f).await;
        assert_eq!(r.entries["anno:b1:y"], anno("y", 20, "y2"));
        assert_eq!(r.entries["anno:b2:z"], anno("z", 10, "z"));
        assert!(!r.entries.keys().any(|k| k.starts_with("annos:")));
        // A group is never taken from the app.
        assert_eq!(written(&f, f.here, 3, &[entry("annos:b9:", "{}")]).await, 0);
    }

    #[tokio::test]
    async fn devices_on_older_versions_also_get_one_entry_per_annotation() {
        let f = fixture().await;
        let entries = [entry("anno:b1:x", &anno("x", 10, "x"))];
        assert_eq!(written(&f, f.here, 2, &entries).await, 1);
        assert!(f
            .doc
            .get_exact(f.here, "anno:b1:x", false)
            .await
            .unwrap()
            .is_some());
        assert!(own_group(&f, f.here, "b1").await.is_some());
        assert_eq!(written(&f, f.here, 2, &entries).await, 0);
        // A newer edit goes into both.
        let edit = [entry("anno:b1:x", &anno("x", 20, "x2"))];
        assert_eq!(written(&f, f.here, 2, &edit).await, 1);
        let single = f
            .doc
            .get_exact(f.here, "anno:b1:x", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            content_of(&f.blobs, single.content_hash()).await.unwrap(),
            anno("x", 20, "x2")
        );
        // Emptied since (a deletion by an older version): held back like
        // any deletion newer than the record, unless the app insists.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        f.doc.del(f.here, "anno:b1:x").await.unwrap();
        let (n, held, _) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edit, true).await;
        assert_eq!((n, held.len()), (0, 1));
        let (n, _, _) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 2, &edit, false).await;
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn a_highlight_deleted_elsewhere_is_held_back_unless_changed_after() {
        let f = fixture().await;
        // The other device deleted x at 50 ms (a marker in its group).
        let mut theirs = crate::sync_annotations::Group::default();
        theirs.put_deleted("x", 50);
        f.doc
            .set_bytes(
                f.there,
                b"annos:b1:".to_vec(),
                theirs.to_json().into_bytes(),
            )
            .await
            .unwrap();
        // This device's copy predates it: held back, for the app to decide.
        let old = [entry("anno:b1:x", &anno("x", 40, "old"))];
        let (n, held, error) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 3, &old, true).await;
        assert_eq!((n, error), (0, None));
        assert_eq!(
            held,
            vec![DeletedDocKey {
                key: "anno:b1:x".into(),
                at: 50
            }]
        );
        assert!(own_group(&f, f.here, "b1").await.is_none());
        // Edited after the deletion: written, and it stays.
        let newer = [entry("anno:b1:x", &anno("x", 60, "kept"))];
        let (n, held, _) = write_entries_to_doc(&f.doc, &f.blobs, f.here, 3, &newer, true).await;
        assert_eq!((n, held.len()), (1, 0));
        let r = read(&f).await;
        assert_eq!(r.entries["anno:b1:x"], anno("x", 60, "kept"));
        assert!(r.deleted.is_empty());
    }

    #[tokio::test]
    async fn a_deleted_book_or_highlight_becomes_a_marker_in_the_group() {
        let f = fixture().await;
        let entries = [
            entry("anno:b1:x", &anno("x", 10, "x")),
            entry("anno:b1:y", &anno("y", 10, "y")),
            entry("anno:b2:z", &anno("z", 10, "z")),
            entry("anno:b12:w", &anno("w", 10, "w")),
        ];
        written(&f, f.here, 3, &entries).await;
        let deleted_entity = |kind: &str, id: &str| DeletedEntity {
            entity_type: kind.into(),
            entity_id: id.into(),
        };
        let n = purge_entities_in_doc(
            &f.doc,
            &f.blobs,
            f.here,
            &[
                deleted_entity("annotation", "x"),
                deleted_entity("book", "b2"),
            ],
            None,
        )
        .await;
        assert_eq!(n, 2);
        // Purging again changes nothing (the markers keep their time).
        let again = purge_entities_in_doc(
            &f.doc,
            &f.blobs,
            f.here,
            &[
                deleted_entity("annotation", "x"),
                deleted_entity("book", "b2"),
            ],
            None,
        )
        .await;
        assert_eq!(again, 0);
        let r = read(&f).await;
        let mut gone: Vec<&str> = r.deleted.iter().map(|d| d.key.as_str()).collect();
        gone.sort();
        assert_eq!(gone, vec!["anno:b1:x", "anno:b2:z"]);
        assert!(r.entries.contains_key("anno:b1:y"));
        assert!(r.entries.contains_key("anno:b12:w"), "book b12 is not b1");
        // The groups are still there: no empty entries.
        let empties = read_headers(&f.doc, None)
            .await
            .into_iter()
            .filter(|(_, _, h)| *h == iroh_blobs::Hash::EMPTY)
            .count();
        assert_eq!(empties, 0);
    }

    #[tokio::test]
    async fn old_deletions_are_copied_into_the_group_as_markers() {
        let f = fixture().await;
        // Before protocol 3: x and y written one entry each, x deleted.
        written(&f, f.here, 2, &[entry("anno:b1:x", &anno("x", 10, "x"))]).await;
        written(&f, f.here, 2, &[entry("anno:b1:y", &anno("y", 10, "y"))]).await;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        f.doc.del(f.here, "anno:b1:x").await.unwrap();
        let deleted_at = f
            .doc
            .get_exact(f.here, "anno:b1:x", true)
            .await
            .unwrap()
            .unwrap()
            .timestamp()
            / 1000;
        let before = read(&f).await;
        assert_eq!(before.deleted.len(), 1);

        let added = crate::sync_annotations::fold_single_deletions(&f.doc, &f.blobs, f.here)
            .await
            .unwrap();
        assert_eq!(added, 1);
        let group =
            crate::sync_annotations::Group::parse(&own_group(&f, f.here, "b1").await.unwrap())
                .unwrap();
        assert_eq!(group.deleted.get("x").copied(), Some(deleted_at as i64));
        assert!(group.annotations.contains_key("y"));
        // Nothing a read decides changes; doing it again adds nothing.
        let after = read(&f).await;
        assert_eq!(after.deleted, before.deleted);
        assert_eq!(after.entries, before.entries);
        assert_eq!(
            crate::sync_annotations::fold_single_deletions(&f.doc, &f.blobs, f.here)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn live_updates_deliver_the_combined_state_of_what_an_entry_mentions() {
        let f = fixture().await;
        written(
            &f,
            f.here,
            3,
            &[entry("anno:b1:x", &anno("x", 30, "mine, newer"))],
        )
        .await;
        let mut theirs = crate::sync_annotations::Group::default();
        theirs
            .put_record("x", &anno("x", 20, "theirs, older"))
            .unwrap();
        theirs.put_record("y", &anno("y", 20, "theirs")).unwrap();
        theirs.put_deleted("z", 25);
        let raw = theirs.to_json();
        f.doc
            .set_bytes(f.there, b"annos:b1:".to_vec(), raw.clone().into_bytes())
            .await
            .unwrap();
        let (mut entries, deleted) =
            crate::sync_annotations::live_annotations(&f.doc, &f.blobs, "annos:b1:", Some(&raw))
                .await;
        entries.sort();
        assert_eq!(
            entries,
            vec![
                ("anno:b1:x".to_string(), anno("x", 30, "mine, newer")),
                ("anno:b1:y".to_string(), anno("y", 20, "theirs")),
            ]
        );
        assert_eq!(
            deleted,
            vec![DeletedDocKey {
                key: "anno:b1:z".into(),
                at: 25
            }]
        );
        // An older device's single entry: only that annotation.
        let (entries, _) =
            crate::sync_annotations::live_annotations(&f.doc, &f.blobs, "anno:b1:y", Some("{}"))
                .await;
        assert_eq!(entries.len(), 1);
        // Keys that name no annotation deliver nothing.
        let (entries, deleted) =
            crate::sync_annotations::live_annotations(&f.doc, &f.blobs, "anno:", None).await;
        assert!(entries.is_empty() && deleted.is_empty());
    }

    #[tokio::test]
    async fn purge_single_entries_removes_shadowed_key_without_deleting_longer_sibling() {
        let f = fixture().await;
        f.doc
            .set_bytes(f.here, b"book:1".to_vec(), b"{}".to_vec())
            .await
            .unwrap();
        f.doc
            .set_bytes(
                f.here,
                b"book:10".to_vec(),
                b"{\"title\":\"Keep\"}".to_vec(),
            )
            .await
            .unwrap();

        let own_keys = own_entry_keys(&f.doc, f.here).await;
        let removed =
            purge_single_entries(&f.doc, f.here, &[deleted("book", "1")], &own_keys, None).await;
        assert_eq!(removed, 1);

        let gone = f.doc.get_exact(f.here, b"book:1", false).await.unwrap();
        let kept = f.doc.get_exact(f.here, b"book:10", false).await.unwrap();
        assert!(gone.is_none(), "shadowed key book:1 must be deleted");
        assert!(kept.is_some(), "longer sibling book:10 must stay live");
    }

    #[tokio::test]
    async fn write_annotations_does_not_wipe_own_group_when_blob_missing() {
        let f = fixture().await;
        let missing_hash = iroh_blobs::Hash::new(b"missing-group-payload-not-in-store");
        f.doc
            .set_hash(f.here, b"annos:b1:".to_vec(), missing_hash, 128)
            .await
            .unwrap();

        let (_, _, error) = write_entries_to_doc(
            &f.doc,
            &f.blobs,
            f.here,
            3,
            &[entry(
                "anno:b1:a2",
                r#"{"id":"a2","bookId":"b1","updatedAt":2,"note":"two"}"#,
            )],
            false,
        )
        .await;

        assert!(
            error.is_some(),
            "missing own-group blob must return a retryable error instead of wiping prior annotations"
        );
        let current = f
            .doc
            .get_exact(f.here, b"annos:b1:", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            current.content_hash(),
            missing_hash,
            "existing annos:b1: hash must not be overwritten with only the new entry"
        );
    }
}
