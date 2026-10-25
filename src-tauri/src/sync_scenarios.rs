//! Sync between several devices under realistic conditions, with real iroh
//! endpoints, docs engines and on-disk stores (one temp data folder each),
//! syncing over loopback. Each pairing has its own doc, as in the app.
//!
//! What the app does in TypeScript on top of the docs (provisioning, merging,
//! deletion records) is modelled by [`Device`] after the rules in
//! docs/sync.md; the doc layer underneath is the real code
//! ([`write_entries_to_doc`], [`read_docs`], [`purge_entities_in_doc`]).
//!
//! The heavy measurements are `#[ignore]`d:
//! `cargo test --lib scenarios -- --ignored --nocapture`.

use super::*;
use futures::StreamExt;
use iroh_docs::engine::LiveEvent;
use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Waits long enough that the next write has a later timestamp (ms).
async fn tick() {
    tokio::time::sleep(Duration::from_millis(3)).await;
}

/// An item as the app stores it: a value and when it last changed here or
/// on the device it came from.
#[derive(Clone, Debug, PartialEq)]
struct Item {
    value: String,
    at: u64,
}

fn encode(item: &Item) -> String {
    let stamp = chrono::DateTime::from_timestamp_millis(item.at as i64)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    serde_json::json!({ "v": item.value, "updatedAt": stamp }).to_string()
}

fn decode(raw: &str) -> Option<Item> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    Some(Item {
        value: v["v"].as_str()?.to_string(),
        at: chrono::DateTime::parse_from_rfc3339(v["updatedAt"].as_str()?)
            .ok()?
            .timestamp_millis() as u64,
    })
}

/// The app's entity for an item key (what a deletion record names).
fn entity_of(key: &str) -> DeletedEntity {
    let (entity_type, entity_id) = if let Some(rest) = key.strip_prefix("anno:") {
        (
            "annotation",
            rest.split_once(':').map(|(_, a)| a).unwrap_or(rest),
        )
    } else {
        let (kind, id) = key.split_once(':').unwrap();
        (kind, id)
    };
    DeletedEntity {
        entity_type: entity_type.into(),
        entity_id: entity_id.into(),
    }
}

struct Pairing {
    peer: String,
    peer_id: iroh::EndpointId,
    doc: iroh_docs::api::Doc,
}

/// One device: an iroh node with its own data folder, and the app's state.
struct Device {
    name: String,
    dir: std::path::PathBuf,
    secret: iroh::SecretKey,
    router: iroh::protocol::Router,
    docs: iroh_docs::protocol::Docs,
    blobs: iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    pairings: Vec<Pairing>,
    relay: Option<iroh::RelayMap>,
    /// The app's library: item key -> item.
    items: BTreeMap<String, Item>,
    /// Deletion records: item key -> when it was deleted.
    tombs: BTreeMap<String, u64>,
    applied: Option<HashMap<String, Vec<iroh_blobs::Hash>>>,
}

async fn node(
    dir: &std::path::Path,
    secret: iroh::SecretKey,
    relay: Option<iroh::RelayMap>,
) -> (
    iroh::protocol::Router,
    iroh_docs::protocol::Docs,
    iroh_blobs::api::Store,
) {
    let builder = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal).secret_key(secret);
    let builder = match relay {
        // Relay only: the devices cannot reach each other directly.
        Some(map) => builder
            .relay_mode(iroh::RelayMode::Custom(map))
            .ca_tls_config(iroh_relay::tls::CaTlsConfig::insecure_skip_verify())
            .clear_ip_transports()
            .transport_config(crate::iroh_sync::transport_config()),
        None => builder,
    };
    let ep = builder.bind().await.unwrap();
    let blobs: iroh_blobs::api::Store = iroh_blobs::store::fs::FsStore::load(dir.join("blobs"))
        .await
        .unwrap()
        .into();
    let gossip = iroh_gossip::net::Gossip::builder().spawn(ep.clone());
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    let docs = iroh_docs::protocol::Docs::persistent(dir.join("docs"))
        .spawn(ep.clone(), blobs.clone(), gossip.clone())
        .await
        .unwrap();
    let router = iroh::protocol::Router::builder(ep)
        .accept(
            iroh_blobs::ALPN,
            iroh_blobs::BlobsProtocol::new(&blobs, None),
        )
        .accept(iroh_gossip::ALPN, gossip)
        .accept(iroh_docs::ALPN, docs.clone())
        .spawn();
    (router, docs, blobs)
}

impl Device {
    async fn new(name: &str, root: &std::path::Path, relay: Option<iroh::RelayMap>) -> Self {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let secret = iroh::SecretKey::generate();
        let (router, docs, blobs) = node(&dir, secret.clone(), relay.clone()).await;
        let author = docs.api().author_default().await.unwrap();
        Device {
            name: name.into(),
            dir,
            secret,
            router,
            docs,
            blobs,
            author,
            pairings: Vec::new(),
            relay,
            items: BTreeMap::new(),
            tombs: BTreeMap::new(),
            applied: None,
        }
    }

    fn id(&self) -> iroh::EndpointId {
        self.router.endpoint().id()
    }

    fn doc_list(&self) -> Vec<iroh_docs::api::Doc> {
        self.pairings.iter().map(|p| p.doc.clone()).collect()
    }

    /// The app is killed (no clean shutdown of anything in flight).
    async fn kill(&mut self) {
        let _ = self.router.shutdown().await;
        let _ = self.blobs.shutdown().await;
    }

    /// The app starts again from its data folder: the docs are reopened, the
    /// first read after start is a full one.
    async fn restart(&mut self) {
        let (router, docs, blobs) = node(&self.dir, self.secret.clone(), self.relay.clone()).await;
        let api = docs.api().clone();
        for p in &mut self.pairings {
            p.doc = api.open(p.doc.id()).await.unwrap().expect("doc kept");
            // As `iroh_start` does: every paired doc is live again.
            p.doc.start_sync(vec![]).await.unwrap();
        }
        self.router = router;
        self.docs = docs;
        self.blobs = blobs;
        self.applied = None;
    }

    /// A change made here, written to every paired doc at once (the live
    /// store->docs bridge, `docs_set_entry`).
    async fn edit(&mut self, key: &str, value: &str) {
        tick().await;
        let item = Item {
            value: value.into(),
            at: now_ms(),
        };
        self.items.insert(key.into(), item.clone());
        self.tombs.remove(key);
        for doc in self.doc_list() {
            let (_, _, err) = write_entries_to_doc(
                &doc,
                self.author,
                2,
                &[(key.to_string(), encode(&item))],
                false,
            )
            .await;
            assert_eq!(err, None);
        }
    }

    /// An edit made while the sync engine was not running (written by the
    /// next provisioning, not at once).
    async fn edit_offline(&mut self, key: &str, value: &str) {
        tick().await;
        self.items.insert(
            key.into(),
            Item {
                value: value.into(),
                at: now_ms(),
            },
        );
    }

    async fn delete(&mut self, key: &str) {
        tick().await;
        self.apply_deletion(key, now_ms());
        let entity = entity_of(key);
        for doc in self.doc_list() {
            let tomb = [(format!("tomb:{key}"), now_ms().to_string())];
            write_entries_to_doc(&doc, self.author, 2, &tomb, false).await;
            purge_entities_in_doc(&doc, self.author, std::slice::from_ref(&entity)).await;
        }
    }

    fn apply_deletion(&mut self, key: &str, at: u64) {
        self.items.remove(key);
        let slot = self.tombs.entry(key.to_string()).or_insert(at);
        *slot = (*slot).max(at);
    }

    /// The entries provisioning writes: every item and deletion record.
    fn entries(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .items
            .iter()
            .map(|(k, item)| (k.clone(), encode(item)))
            .collect();
        out.extend(
            self.tombs
                .iter()
                .map(|(k, at)| (format!("tomb:{k}"), at.to_string())),
        );
        out
    }

    /// `provisionToIrohDocs`: writes everything in batches of 400 (Rust skips
    /// what is unchanged), settles items deleted elsewhere, then removes this
    /// device's entries of deleted items.
    async fn provision(&mut self) {
        let entries = self.entries();
        let mut deleted_elsewhere = Vec::new();
        for doc in self.doc_list() {
            for batch in entries.chunks(400) {
                let (_, found, err) = write_entries_to_doc(&doc, self.author, 2, batch, true).await;
                assert_eq!(err, None);
                deleted_elsewhere.extend(found);
            }
        }
        for d in deleted_elsewhere {
            match self.items.get(&d.key).cloned() {
                // Changed here after it was deleted there: written anyway.
                Some(item) if item.at > d.at => {
                    for doc in self.doc_list() {
                        write_entries_to_doc(
                            &doc,
                            self.author,
                            2,
                            &[(d.key.clone(), encode(&item))],
                            false,
                        )
                        .await;
                    }
                }
                Some(_) => self.apply_deletion(&d.key, d.at),
                None => {}
            }
        }
        self.purge().await;
    }

    async fn purge(&mut self) {
        let entities: Vec<DeletedEntity> = self.tombs.keys().map(|k| entity_of(k)).collect();
        for doc in self.doc_list() {
            purge_entities_in_doc(&doc, self.author, &entities).await;
        }
    }

    /// `hydrateFromIrohDocs` + `mergeIncomingData`: newer items win,
    /// deletion records and doc deletions remove what did not change here
    /// after them.
    async fn hydrate(&mut self) -> DocRead {
        let docs = self.doc_list();
        let mut read = read_docs(&docs, &self.blobs, self.applied.as_ref()).await;
        // As `read_doc_entries`: content that never came is fetched.
        let peers: Vec<iroh::EndpointId> = self.pairings.iter().map(|p| p.peer_id).collect();
        let endpoint = self.router.endpoint().clone();
        let fetched = fetch_missing_content(
            &self.blobs,
            &endpoint,
            &peers,
            &read.missing,
            MISSING_CONTENT_BUDGET,
        )
        .await;
        if std::env::var("SCENARIO_DEBUG").is_ok() && !read.missing.is_empty() {
            eprintln!(
                "{}: {} without content, {fetched} fetched",
                self.name,
                read.missing.len()
            );
        }
        if fetched > 0 {
            read = read_docs(&docs, &self.blobs, self.applied.as_ref()).await;
        }
        let mut incoming: Vec<(&String, &String)> = read.entries.iter().collect();
        incoming.sort();
        for (key, raw) in incoming {
            if let Some(item_key) = key.strip_prefix("tomb:") {
                let at: u64 = raw.parse().unwrap();
                let keep = self.items.get(item_key).is_some_and(|i| i.at > at);
                if !keep {
                    self.apply_deletion(item_key, at);
                }
                continue;
            }
            let Some(item) = decode(raw) else { continue };
            if self.tombs.get(key).is_some_and(|at| *at >= item.at) {
                continue;
            }
            if self.items.get(key).is_none_or(|mine| mine.at < item.at) {
                self.tombs.remove(key);
                self.items.insert(key.clone(), item);
            }
        }
        for d in &read.deleted {
            let keep = self.items.get(&d.key).is_some_and(|i| i.at > d.at);
            if !keep && self.items.contains_key(&d.key) {
                self.apply_deletion(&d.key, d.at);
            }
        }
        self.applied = Some(read.seen.clone());
        read
    }

    /// Deletion records expire after 90 days; their `tomb:` entries leave the
    /// docs with them (`docs_retain_own_entries`).
    async fn expire_tombstones(&mut self) {
        self.tombs.clear();
        for doc in self.doc_list() {
            use futures::pin_mut;
            let mut own = Vec::new();
            let stream = doc
                .get_many(
                    iroh_docs::store::Query::author(self.author)
                        .key_prefix(b"tomb:")
                        .build(),
                )
                .await
                .unwrap();
            pin_mut!(stream);
            while let Some(Ok(e)) = stream.next().await {
                own.push(e.key().to_vec());
            }
            for key in own {
                doc.del(self.author, key).await.unwrap();
            }
        }
    }

    fn doc_with(&self, peer: &str) -> iroh_docs::api::Doc {
        self.pairings
            .iter()
            .find(|p| p.peer == peer)
            .unwrap()
            .doc
            .clone()
    }

    fn peer_id(&self, peer: &str) -> iroh::EndpointId {
        self.pairings
            .iter()
            .find(|p| p.peer == peer)
            .unwrap()
            .peer_id
    }

    /// Unpairing: the doc shared with that device is closed and dropped.
    async fn unpair(&mut self, peer: &str) {
        let doc = self.doc_with(peer);
        let id = doc.id();
        let _ = doc.leave().await;
        drop(doc);
        self.pairings.retain(|p| p.peer != peer);
        let _ = self.docs.api().drop_doc(id).await;
    }

    fn snapshot(&self) -> BTreeMap<String, String> {
        self.items
            .iter()
            .map(|(k, i)| (k.clone(), i.value.clone()))
            .collect()
    }
}

/// Pairs two devices: one creates the doc they share, the other imports it
/// with write access.
async fn pair(a: &mut Device, b: &mut Device) {
    let doc = a.docs.api().create().await.unwrap();
    let ticket = doc
        .share(
            iroh_docs::api::protocol::ShareMode::Write,
            iroh_docs::api::protocol::AddrInfoOptions::Id,
        )
        .await
        .unwrap();
    let theirs = b
        .docs
        .api()
        .import_namespace(ticket.capability)
        .await
        .unwrap();
    // Both devices keep the doc live, as the app does from pairing on.
    doc.start_sync(vec![]).await.unwrap();
    theirs.start_sync(vec![]).await.unwrap();
    a.pairings.push(Pairing {
        peer: b.name.clone(),
        peer_id: b.id(),
        doc,
    });
    b.pairings.push(Pairing {
        peer: a.name.clone(),
        peer_id: a.id(),
        doc: theirs,
    });
}

/// How a sync exchange went, as `docs_sync_now` + `docs-sync-finished` see it.
#[derive(Debug)]
struct Exchange {
    synced: bool,
    /// What iroh-docs reported (shown when an assertion fails).
    #[allow(dead_code)]
    result: String,
    took: Duration,
    /// Until every entry's content had arrived on the side that asked.
    content_after: Option<Duration>,
}

/// `docs_sync_now`: `from` syncs the doc it shares with `to` and waits for the
/// exchange to finish (30 s at most, as the app). With `wait_for_content`,
/// also until the content of what arrived is there.
async fn exchange(from: &Device, to: &Device, wait_for_content: bool) -> Exchange {
    exchange_within(from, to, wait_for_content, Duration::from_secs(30)).await
}

async fn exchange_within(
    from: &Device,
    to: &Device,
    wait_for_content: bool,
    limit: Duration,
) -> Exchange {
    let doc = from.doc_with(&to.name);
    let mut events = doc.subscribe().await.unwrap();
    let started = Instant::now();
    // Through a relay, all the other device's address is its relay URL.
    let addr = match &to.relay {
        Some(map) => {
            let url = map.urls::<Vec<_>>().into_iter().next().unwrap();
            iroh::EndpointAddr::new(to.id()).with_relay_url(url)
        }
        None => to.router.endpoint().addr(),
    };
    doc.start_sync(vec![addr]).await.unwrap();
    let peer = from.peer_id(&to.name);
    let mut synced = None;
    let mut result = String::new();
    let mut content_after = None;
    let deadline = tokio::time::Instant::now() + limit;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next()).await {
        match event {
            Ok(LiveEvent::SyncFinished(e)) if e.peer == peer => {
                let (ok, _, _) = crate::iroh_sync::sync_outcome(
                    e.result
                        .as_ref()
                        .map(|d| (d.entries_received, d.entries_sent))
                        .map_err(String::as_str),
                );
                synced = Some((ok, started.elapsed()));
                result = format!("{:?}", e.result);
                if !wait_for_content || !ok {
                    break;
                }
            }
            Ok(LiveEvent::PendingContentReady) if synced.is_some() => {
                content_after = Some(started.elapsed());
                break;
            }
            _ => {}
        }
    }
    let (synced, took) = synced.unwrap_or((false, started.elapsed()));
    Exchange {
        synced,
        result,
        took,
        content_after,
    }
}

/// A sync round as `runDeviceSync` runs it on `from`: provision, sync with
/// `to`, read and merge. The other device merges what arrived live.
async fn round(from: &mut Device, to: &mut Device) -> Exchange {
    from.provision().await;
    let ex = exchange(from, to, true).await;
    assert!(ex.synced, "{} -> {}: {ex:?}", from.name, to.name);
    let r1 = from.hydrate().await;
    let r2 = to.hydrate().await;
    if std::env::var("SCENARIO_DEBUG").is_ok() {
        eprintln!(
            "{}->{}: {ex:?} from got {:?} del {:?}; to got {:?} del {:?}",
            from.name,
            to.name,
            r1.entries.keys().collect::<Vec<_>>(),
            r1.deleted,
            r2.entries.keys().collect::<Vec<_>>(),
            r2.deleted
        );
    }
    ex
}

/// Rounds over every pairing, as the app does on each device, until no
/// device's library changes (or `max` passes).
async fn settle(a: &mut Device, b: &mut Device, c: &mut Device) {
    for _ in 0..4 {
        let before = (a.snapshot(), b.snapshot(), c.snapshot());
        round(a, b).await;
        round(c, b).await;
        round(b, a).await;
        round(b, c).await;
        if before == (a.snapshot(), b.snapshot(), c.snapshot()) {
            return;
        }
    }
}

/// A <-> B <-> C: A and C are not paired, everything reaches C through B.
async fn three_devices(root: &std::path::Path) -> (Device, Device, Device) {
    let mut a = Device::new("A", root, None).await;
    let mut b = Device::new("B", root, None).await;
    let mut c = Device::new("C", root, None).await;
    pair(&mut a, &mut b).await;
    pair(&mut b, &mut c).await;
    (a, b, c)
}

fn has(d: &Device, key: &str) -> Option<String> {
    d.items.get(key).map(|i| i.value.clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_devices_converge_through_the_middle_one() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;

    a.edit("book:1", "Dune").await;
    a.edit("book:2", "Emma").await;
    a.edit("book:3", "Ulysses").await;
    a.edit("anno:1:x", "a highlight").await;
    c.edit("book:9", "Middlemarch").await;
    settle(&mut a, &mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(d.items.len(), 5, "{}: {:?}", d.name, d.snapshot());
    }

    // Edited on both ends of the chain: the later edit wins everywhere.
    c.edit("book:1", "Dune (C)").await;
    a.edit("book:1", "Dune (A, later)").await;
    // An annotation edited on C, the book's other annotation deleted on A.
    c.edit("anno:1:y", "from C").await;
    a.delete("anno:1:x").await;
    settle(&mut a, &mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(
            has(d, "book:1").as_deref(),
            Some("Dune (A, later)"),
            "{}",
            d.name
        );
        assert_eq!(has(d, "anno:1:x"), None, "{}", d.name);
        assert_eq!(has(d, "anno:1:y").as_deref(), Some("from C"), "{}", d.name);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deletion_reaches_a_device_that_was_offline_and_nothing_comes_back() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    a.edit("book:2", "Emma").await;
    a.edit("book:3", "Ulysses").await;
    settle(&mut a, &mut b, &mut c).await;
    assert_eq!(c.items.len(), 3);

    // C goes away. A deletes two books; B learns it.
    c.kill().await;
    a.delete("book:2").await;
    a.delete("book:3").await;
    round(&mut a, &mut b).await;
    assert_eq!(has(&b, "book:2"), None);

    // Meanwhile C, offline, read book:3 *after* it was deleted: that keeps it
    // (a change made after the deletion, anywhere, wins over it).
    c.restart().await;
    c.edit_offline("book:3", "Ulysses (read on C)").await;
    // C's app starts: provisioning, then its rounds; A and B carry on too.
    settle(&mut a, &mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(has(d, "book:2"), None, "book:2 came back on {}", d.name);
        assert_eq!(
            has(d, "book:3").as_deref(),
            Some("Ulysses (read on C)"),
            "{}",
            d.name
        );
        assert_eq!(has(d, "book:1").as_deref(), Some("Dune"), "{}", d.name);
    }

    // 90 days later every deletion record has expired; every app restarts
    // (full reads, full provisioning). The doc deletions still hold.
    for d in [&mut a, &mut b, &mut c] {
        d.expire_tombstones().await;
        d.kill().await;
        d.restart().await;
    }
    settle(&mut a, &mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(has(d, "book:2"), None, "book:2 came back on {}", d.name);
        assert!(has(d, "book:3").is_some(), "{}", d.name);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_offline_through_the_deletion_and_its_expiry_does_not_bring_it_back() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    a.edit("book:2", "Emma").await;
    settle(&mut a, &mut b, &mut c).await;

    // C is off for months: the deletion and the expiry of its record both
    // happen while it is away.
    c.kill().await;
    a.delete("book:2").await;
    round(&mut a, &mut b).await;
    round(&mut b, &mut a).await;
    a.expire_tombstones().await;
    b.expire_tombstones().await;
    round(&mut a, &mut b).await;

    c.restart().await;
    settle(&mut a, &mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(has(d, "book:2"), None, "book:2 came back on {}", d.name);
        assert_eq!(has(d, "book:1").as_deref(), Some("Dune"), "{}", d.name);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unpaired_device_gets_nothing_more_and_the_others_carry_on() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    settle(&mut a, &mut b, &mut c).await;
    assert!(has(&c, "book:1").is_some());

    b.unpair("C").await;
    a.edit("book:2", "Emma").await;
    round(&mut a, &mut b).await;
    b.provision().await;
    assert_eq!(has(&b, "book:2").as_deref(), Some("Emma"));
    // C still holds its copy of the old doc, but B no longer has it. (The
    // app's probe refuses C before this, with close code 403.)
    exchange(&c, &b, false).await;
    c.hydrate().await;
    assert_eq!(has(&c, "book:2"), None);
    // C keeps what it had.
    assert_eq!(has(&c, "book:1").as_deref(), Some("Dune"));
}

/// A book entry about the size of a real one (description, cover reference).
fn book_value(i: usize) -> String {
    format!(
        "{{\"title\":\"Book {i}\",\"author\":\"Author {a}\",\"description\":\"{d}\",\"coverPath\":\"theorem-cover://{i}\",\"progress\":0.{p},\"tags\":[\"fiction\",\"tag{t}\"]}}",
        a = i % 700,
        d = "A long description of the book. ".repeat(12),
        p = i % 10,
        t = i % 40,
    )
}

fn annotation_value(i: usize) -> String {
    format!(
        "{{\"type\":\"highlight\",\"cfi\":\"epubcfi(/6/{c}!/4/2/{i})\",\"text\":\"{t}\",\"color\":\"yellow\"}}",
        c = i % 60,
        t = "highlighted words ".repeat(8),
    )
}

/// A library of `books` books with `per_book` highlights each.
fn fill_library(d: &mut Device, books: usize, per_book: usize) {
    let at = now_ms();
    for i in 0..books {
        d.items.insert(
            format!("book:b{i}"),
            Item {
                value: book_value(i),
                at,
            },
        );
        for j in 0..per_book {
            d.items.insert(
                format!("anno:b{i}:a{j}"),
                Item {
                    value: annotation_value(i * per_book + j),
                    at,
                },
            );
        }
    }
}

fn dir_size(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| match e.file_type() {
                    Ok(t) if t.is_dir() => dir_size(&e.path()),
                    _ => e.metadata().map(|m| m.len()).unwrap_or(0),
                })
                .sum()
        })
        .unwrap_or(0)
}

/// Peak resident memory of this process (MiB).
fn peak_rss_mib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
        })
        .unwrap_or(0)
        / 1024
}

async fn timed<T>(label: &str, f: impl std::future::Future<Output = T>) -> T {
    let started = Instant::now();
    let out = f.await;
    eprintln!(
        "  {label}: {:.2} s (peak RSS {} MiB)",
        started.elapsed().as_secs_f64(),
        peak_rss_mib()
    );
    out
}

fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / 1_048_576.0)
}

/// 5,000 books and 50,000 highlights between two devices.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement: cargo test --lib scenarios -- --ignored --nocapture"]
async fn a_large_library() {
    let root = tempfile::tempdir().unwrap();
    let mut a = Device::new("A", root.path(), None).await;
    let mut b = Device::new("B", root.path(), None).await;
    pair(&mut a, &mut b).await;
    fill_library(&mut a, 5_000, 10);
    let total = a.items.len();
    let bytes: usize = a.entries().iter().map(|(k, v)| k.len() + v.len()).sum();
    eprintln!(
        "large library: {total} entries, {}, start RSS {} MiB",
        mib(bytes as u64),
        peak_rss_mib()
    );

    timed(
        "A: first provisioning (all written, batches of 400)",
        a.provision(),
    )
    .await;
    timed(
        "A: provisioning again, nothing changed (app restart)",
        a.provision(),
    )
    .await;
    eprintln!("  A: data folder {}", mib(dir_size(&a.dir)));

    // The app waits 30 s for the exchange; how long does it really take?
    let ex = timed(
        "A -> B: first exchange",
        exchange_within(&a, &b, true, Duration::from_secs(1200)),
    )
    .await;
    assert!(ex.synced, "{ex:?}");
    eprintln!(
        "  exchange finished after {:.2} s, all content after {:?}",
        ex.took.as_secs_f64(),
        ex.content_after
    );
    // The app reads as soon as the exchange finished.
    let read = timed("B: first read right after the exchange", b.hydrate()).await;
    eprintln!(
        "  B: {} entries delivered of {total} (rest waiting for content)",
        read.entries.len()
    );
    let mut reads = 1;
    while b.items.len() < total && reads < 30 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let read = timed("B: next read", b.hydrate()).await;
        eprintln!("  B: {} more entries delivered", read.entries.len());
        reads += 1;
    }
    assert_eq!(b.items.len(), total);
    eprintln!("  B: data folder {}", mib(dir_size(&b.dir)));

    // Steady state: a round with nothing changed on either side.
    let ex = timed("A -> B: exchange, nothing changed", exchange(&a, &b, false)).await;
    assert!(ex.synced);
    let read = timed("A: read, nothing changed", a.hydrate()).await;
    eprintln!("  A: {} entries delivered", read.entries.len());
    let read = timed("A: read again, nothing changed", a.hydrate()).await;
    assert!(read.entries.is_empty());
    let read = timed("B: read, nothing changed", b.hydrate()).await;
    assert!(read.entries.is_empty());

    // One edit: only it travels.
    b.edit("book:b42", "edited on B").await;
    let ex = timed("B -> A: exchange, one edit", exchange(&b, &a, false)).await;
    assert!(ex.synced);
    let read = timed("A: read, one edit", a.hydrate()).await;
    eprintln!("  A: {} entries delivered", read.entries.len());
    assert_eq!(has(&a, "book:b42").as_deref(), Some("edited on B"));
    // Purging deletion records over a large doc (first round after start).
    b.tombs.insert("book:b7".into(), now_ms());
    timed("B: purge one deleted book", b.purge()).await;
    eprintln!(
        "  data folders after: A {}, B {}",
        mib(dir_size(&a.dir)),
        mib(dir_size(&b.dir))
    );
}

/// The connection drops in the middle of a large first exchange (the other
/// device is killed). What arrived is delivered only with its content, the
/// rest is read again, and the next round completes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_exchange_cut_off_midway_completes_on_the_next_round() {
    let root = tempfile::tempdir().unwrap();
    let mut a = Device::new("A", root.path(), None).await;
    let mut b = Device::new("B", root.path(), None).await;
    pair(&mut a, &mut b).await;
    fill_library(&mut a, 100, 3);
    let total = a.items.len();
    a.provision().await;

    // B asks; A is killed as soon as the first entries reach B.
    let doc = b.doc_with("A");
    let mut events = doc.subscribe().await.unwrap();
    doc.start_sync(vec![a.router.endpoint().addr()])
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next()).await {
        if matches!(event, Ok(LiveEvent::InsertRemote { .. })) {
            break;
        }
    }
    drop(events);
    a.kill().await;
    // B's docs engine is busy storing what arrived (slow in a debug build);
    // the read below is timed once it is done.
    let _ = doc.get_exact(b.author, b"-".to_vec(), false).await;

    // B merges whatever is complete; every value delivered is whole. The
    // read must not stall on content that is not coming (A is gone).
    let started = Instant::now();
    let first = b.hydrate().await;
    eprintln!("read after the cut: {:?}", started.elapsed());
    assert!(
        started.elapsed() < MISSING_CONTENT_BUDGET + Duration::from_secs(2),
        "the read waited {:?} for missing content",
        started.elapsed()
    );
    for (key, value) in &first.entries {
        assert!(decode(value).is_some(), "{key} delivered half: {value}");
    }
    let got = b.items.len();
    eprintln!("cut off after {got} of {total} entries");

    // A comes back; the next round completes everything.
    a.restart().await;
    let ex = exchange(&b, &a, true).await;
    assert!(ex.synced, "{ex:?}");
    for _ in 0..20 {
        b.hydrate().await;
        if b.items.len() == total {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(b.items.len(), total);
    assert_eq!(b.snapshot(), a.snapshot());
}

/// Devices that cannot reach each other directly (no direct addresses at
/// all) sync through a relay; the exchange stays well within the app's
/// timeouts (6 s probe, 30 s for the exchange).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn devices_sync_through_a_relay_alone() {
    let (relay_map, _url, _relay) = iroh::test_utils::run_relay_server().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut a = Device::new("A", root.path(), Some(relay_map.clone())).await;
    let mut b = Device::new("B", root.path(), Some(relay_map)).await;
    pair(&mut a, &mut b).await;
    fill_library(&mut a, 20, 5);
    b.edit("book:mine", "from B").await;

    let started = Instant::now();
    let ex = round(&mut a, &mut b).await;
    eprintln!("first exchange through the relay: {ex:?}");
    assert!(ex.took < Duration::from_secs(6), "{ex:?}");
    // What arrives after the exchange reaches the app live (modelled by
    // reading again).
    converge(&mut a, &mut b).await;
    eprintln!("both devices equal after {:?}", started.elapsed());

    a.edit("book:b1", "edited on A").await;
    let started = Instant::now();
    let ex = round(&mut b, &mut a).await;
    eprintln!("next exchange through the relay: {ex:?}");
    assert!(ex.took < Duration::from_secs(6), "{ex:?}");
    converge(&mut a, &mut b).await;
    eprintln!("edit on the other device after {:?}", started.elapsed());
    assert_eq!(has(&b, "book:b1").as_deref(), Some("edited on A"));
}

/// Reads on both devices until they hold the same library (5 s at most).
async fn converge(a: &mut Device, b: &mut Device) {
    for _ in 0..50 {
        if a.snapshot() == b.snapshot() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        a.hydrate().await;
        b.hydrate().await;
    }
    let (sa, sb) = (a.snapshot(), b.snapshot());
    let differ: Vec<&String> = sa
        .keys()
        .chain(sb.keys())
        .filter(|k| sa.get(*k) != sb.get(*k))
        .collect();
    panic!("not converged: {differ:?}");
}

/// B passes on a book it received from A; A edits it before B's next
/// provisioning, which writes B's copy later than A's edit. A's edit must
/// still reach B, and C behind it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_passed_on_copy_never_hides_a_newer_edit() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    round(&mut a, &mut b).await;
    assert_eq!(has(&b, "book:1").as_deref(), Some("Dune"));

    a.edit("book:1", "Dune (edited on A)").await;
    // B's round: it provisions first (its copy of "Dune", written now).
    round(&mut b, &mut a).await;
    round(&mut b, &mut c).await;
    round(&mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(
            has(d, "book:1").as_deref(),
            Some("Dune (edited on A)"),
            "{}",
            d.name
        );
    }
}
