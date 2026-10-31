//! Sync between several devices under realistic conditions, with real iroh
//! endpoints, docs engines and on-disk stores (one temp data folder each),
//! syncing over loopback. Each pairing has its own doc, as in the app.
//!
//! What the app does in TypeScript on top of the docs (provisioning, merging,
//! deletion records) is modelled by [`Device`] after the rules in
//! docs/sync.md; the doc layer underneath is the real code
//! ([`write_entries_to_doc`], [`read_docs`], [`purge_entities_in_doc`]).
//! A device can also run as a version before sync protocol 3 (`old`), which
//! writes and reads one entry per annotation, as those versions did.
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
    /// The sync protocol the other device reported.
    protocol: u8,
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
    /// The deletions this device wrote, and what puts one back.
    own: std::sync::Arc<crate::sync_deletions::OwnDeletions>,
    pairings: Vec<Pairing>,
    relay: Option<iroh::RelayMap>,
    /// The app's library: item key -> item.
    items: BTreeMap<String, Item>,
    /// Deletion records: item key -> when it was deleted.
    tombs: BTreeMap<String, u64>,
    applied: Option<HashMap<String, Vec<iroh_blobs::Hash>>>,
    /// Runs a version before sync protocol 3 (one entry per annotation).
    old: bool,
}

async fn node(
    dir: &std::path::Path,
    secret: iroh::SecretKey,
    relay: Option<iroh::RelayMap>,
) -> (
    iroh::protocol::Router,
    iroh_docs::protocol::Docs,
    iroh_blobs::api::Store,
    iroh_docs::actor::SyncHandle,
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
    let (docs, sync) = crate::sync_deletions::spawn_docs(
        &dir.join("docs"),
        ep.clone(),
        blobs.clone(),
        gossip.clone(),
    )
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
    (router, docs, blobs, sync)
}

/// This device's deletions, kept as the app keeps them (`iroh_sync`).
fn own_deletions(
    dir: &std::path::Path,
    sync: iroh_docs::actor::SyncHandle,
    author: iroh_docs::AuthorId,
    router: &iroh::protocol::Router,
) -> std::sync::Arc<crate::sync_deletions::OwnDeletions> {
    std::sync::Arc::new(crate::sync_deletions::OwnDeletions::open(
        &dir.join("docs"),
        sync,
        author,
        router.endpoint().id(),
    ))
}

impl Device {
    async fn new(name: &str, root: &std::path::Path, relay: Option<iroh::RelayMap>) -> Self {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let secret = iroh::SecretKey::generate();
        let (router, docs, blobs, sync) = node(&dir, secret.clone(), relay.clone()).await;
        let author = docs.api().author_default().await.unwrap();
        let own = own_deletions(&dir, sync, author, &router);
        Device {
            name: name.into(),
            dir,
            secret,
            router,
            docs,
            blobs,
            author,
            own,
            pairings: Vec::new(),
            relay,
            items: BTreeMap::new(),
            tombs: BTreeMap::new(),
            applied: None,
            old: false,
        }
    }

    /// The protocol this device speaks.
    fn protocol(&self) -> u8 {
        if self.old {
            2
        } else {
            theorem_sync_core::sync_protocol::SYNC_PROTOCOL
        }
    }

    /// Writes as this device's version does, into the doc shared with a
    /// device on `protocol`.
    async fn write(
        &self,
        doc: &iroh_docs::api::Doc,
        protocol: u8,
        entries: &[(String, String)],
        respect_deletions: bool,
    ) -> (usize, Vec<DeletedDocKey>, Option<String>) {
        if self.old {
            old_write(doc, self.author, entries, respect_deletions).await
        } else {
            write_entries_to_doc(
                doc,
                &self.blobs,
                self.author,
                protocol,
                entries,
                respect_deletions,
            )
            .await
        }
    }

    /// Removes (old) or marks deleted (now) this device's entries of `entities`.
    async fn purge_in(&self, doc: &iroh_docs::api::Doc, entities: &[DeletedEntity]) {
        if self.old {
            let own = own_entry_keys(doc, self.author).await;
            purge_single_entries(doc, self.author, entities, &own, None).await;
        } else {
            purge_entities_in_doc(doc, &self.blobs, self.author, entities, Some(&self.own)).await;
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
        let (router, docs, blobs, sync) =
            node(&self.dir, self.secret.clone(), self.relay.clone()).await;
        self.own = own_deletions(&self.dir, sync, self.author, &router);
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
        for p in &self.pairings {
            let (_, _, err) = self
                .write(
                    &p.doc,
                    p.protocol,
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
        for p in &self.pairings {
            let tomb = [(format!("tomb:{key}"), now_ms().to_string())];
            self.write(&p.doc, p.protocol, &tomb, false).await;
            self.purge_in(&p.doc, std::slice::from_ref(&entity)).await;
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
        for p in &self.pairings {
            if !self.old {
                // As `write_own_entries` does once per start.
                crate::sync_annotations::fold_single_deletions(&p.doc, &self.blobs, self.author)
                    .await
                    .unwrap();
            }
            for batch in entries.chunks(400) {
                let (_, found, err) = self.write(&p.doc, p.protocol, batch, true).await;
                assert_eq!(err, None);
                deleted_elsewhere.extend(found);
            }
        }
        for d in deleted_elsewhere {
            match self.items.get(&d.key).cloned() {
                // Changed here after it was deleted there: written anyway.
                Some(item) if item.at > d.at => {
                    for p in &self.pairings {
                        self.write(&p.doc, p.protocol, &[(d.key.clone(), encode(&item))], false)
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
        for p in &self.pairings {
            self.purge_in(&p.doc, &entities).await;
        }
    }

    /// `hydrateFromIrohDocs` + `mergeIncomingData`: newer items win,
    /// deletion records and doc deletions remove what did not change here
    /// after them.
    async fn hydrate(&mut self) -> DocRead {
        let docs = self.doc_list();
        let read_with = |docs: &'_ [iroh_docs::api::Doc]| {
            let (docs, blobs, applied, old, own) = (
                docs.to_vec(),
                self.blobs.clone(),
                self.applied.clone(),
                self.old,
                self.own.clone(),
            );
            async move {
                if old {
                    old_read_docs(&docs, &blobs, applied.as_ref()).await
                } else {
                    read_docs(&docs, &blobs, applied.as_ref(), Some(&own)).await
                }
            }
        };
        let mut read = read_with(&docs).await;
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
            read = read_with(&docs).await;
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
            if key.starts_with(crate::sync_annotations::GROUP_PREFIX) {
                // Never delivered by this version, and ignored by older ones.
                assert!(self.old, "{} was handed a group entry {key}", self.name);
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
        protocol: b.protocol(),
    });
    b.pairings.push(Pairing {
        peer: a.name.clone(),
        peer_id: a.id(),
        doc: theirs,
        protocol: a.protocol(),
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

/// Every entry of a doc (deletions included): author, key, timestamp, hash.
async fn doc_state(
    doc: &iroh_docs::api::Doc,
) -> Vec<(iroh_docs::AuthorId, Vec<u8>, u64, iroh_blobs::Hash)> {
    let stream = doc
        .get_many(iroh_docs::store::Query::all().include_empty().build())
        .await
        .unwrap();
    futures::pin_mut!(stream);
    let mut out = Vec::new();
    while let Some(Ok(e)) = stream.next().await {
        out.push((
            e.author(),
            e.key().to_vec(),
            e.timestamp(),
            e.content_hash(),
        ));
    }
    out
}

/// Whether `holder` has every entry of `entries`, or something that
/// supersedes it in iroh-docs: an entry of the same author, at the same key
/// or a key above it, as new or newer.
fn holds(
    holder: &[(iroh_docs::AuthorId, Vec<u8>, u64, iroh_blobs::Hash)],
    entries: &[(iroh_docs::AuthorId, Vec<u8>, u64, iroh_blobs::Hash)],
) -> bool {
    let index: HashMap<(iroh_docs::AuthorId, &[u8]), u64> = holder
        .iter()
        .map(|(author, key, at, _)| ((*author, key.as_slice()), *at))
        .collect();
    entries.iter().all(|(author, key, at, _)| {
        (1..=key.len()).any(|n| index.get(&(*author, &key[..n])).is_some_and(|t| t >= at))
    })
}

/// [`exchange`] with its own time limit.
///
/// The exchange is over when each end holds what the other held when it
/// began, not when `from` first hears "finished": when two devices meet
/// (pairing, a start, a peer coming online), both docs engines may ask for
/// an exchange at the same moment. iroh-docs lets the request of the device
/// with the smaller node ID through and turns the other away, but it checks
/// the connection's teardown before the sync's result, so the request
/// turned away is reported as "Failed to close connection", which counts as
/// synced (rightly: almost every completed exchange ends that way too), and
/// the end that answered the other request may report nothing for it (the
/// failed request resets its state for that peer). So `from` heard "done"
/// while the exchange carrying the entries was still running, and the reads
/// that followed missed them, or not, depending on which device had the
/// smaller node ID (`a_passed_on_copy_never_hides_a_newer_edit` failed about
/// half the time). In the app this costs nothing: what arrives after the
/// round's read is delivered live (`docs-entry-batch`).
async fn exchange_within(
    from: &Device,
    to: &Device,
    wait_for_content: bool,
    limit: Duration,
) -> Exchange {
    let doc = from.doc_with(&to.name);
    // The other end, while it still has the doc (it may have unpaired).
    let to_doc = to
        .pairings
        .iter()
        .find(|p| p.peer == from.name)
        .map(|p| p.doc.clone());
    let from_events = doc.subscribe().await.unwrap().map(|e| (true, e)).boxed();
    let to_events = match &to_doc {
        Some(d) => d.subscribe().await.unwrap().map(|e| (false, e)).boxed(),
        None => futures::stream::pending().boxed(),
    };
    let mut events = futures::stream::select(from_events, to_events);
    let from_before = doc_state(&doc).await;
    let to_before = match &to_doc {
        Some(d) => doc_state(d).await,
        None => Vec::new(),
    };
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
    let (to_id, from_id) = (from.peer_id(&to.name), from.id());
    let mut heard = false;
    let mut synced = None;
    let mut result = String::new();
    let mut content_after = None;
    // Content `from` still lacks, once the entries are there.
    let mut missing: Option<Vec<iroh_blobs::Hash>> = None;
    let deadline = tokio::time::Instant::now() + limit;
    // The state is looked at when an end reports an exchange or content,
    // and otherwise after a pause that doubles (up to 2 s): an end may never
    // report the exchange that carried the entries.
    let mut pause = Duration::from_millis(25);
    let mut next_look = tokio::time::Instant::now() + pause;
    loop {
        let event = tokio::select! {
            e = events.next() => e,
            _ = tokio::time::sleep_until(next_look.min(deadline)) => None,
        };
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let mut look = now >= next_look;
        match &event {
            Some((is_from, Ok(LiveEvent::SyncFinished(e))))
                if e.peer == if *is_from { to_id } else { from_id } =>
            {
                heard = true;
                look = true;
                if *is_from && matches!(e.origin, iroh_docs::engine::Origin::Connect(_)) {
                    let (ok, _, _) = crate::iroh_sync::sync_outcome(
                        e.result
                            .as_ref()
                            .map(|d| (d.entries_received, d.entries_sent))
                            .map_err(String::as_str),
                    );
                    result = format!("{:?}", e.result);
                    if !ok {
                        // Refused or unreachable: the app's round fails here.
                        synced = Some((false, started.elapsed()));
                        break;
                    }
                    if to_doc.is_none() && synced.is_none() {
                        // Nothing to hear from the other end: `from`'s word.
                        synced = Some((true, started.elapsed()));
                        if !wait_for_content {
                            break;
                        }
                    }
                }
            }
            Some((true, Ok(LiveEvent::PendingContentReady))) => look = true,
            _ => {}
        }
        if !look || !heard {
            if now >= next_look {
                next_look = now + pause;
            }
            continue;
        }
        if now >= next_look {
            pause = (pause * 2).min(Duration::from_secs(2));
        }
        next_look = now + pause;
        if synced.is_none() {
            let to_doc = to_doc.as_ref().unwrap();
            let (from_now, to_now) = (doc_state(&doc).await, doc_state(to_doc).await);
            if !(holds(&to_now, &from_before) && holds(&from_now, &to_before)) {
                continue;
            }
            synced = Some((true, started.elapsed()));
            if !wait_for_content {
                break;
            }
        }
        // The entries are there; now their content, on `from`.
        let wanted = match missing.take() {
            Some(hashes) => hashes,
            None => doc_state(&doc)
                .await
                .into_iter()
                .map(|(_, _, _, hash)| hash)
                .filter(|hash| *hash != iroh_blobs::Hash::EMPTY)
                .collect(),
        };
        let mut still = Vec::new();
        for hash in wanted {
            if !from.blobs.blobs().has(hash).await.unwrap_or(false) {
                still.push(hash);
            }
        }
        if still.is_empty() {
            content_after = Some(started.elapsed());
            break;
        }
        missing = Some(still);
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
    eprintln!(
        "  A: data folder {}, {} doc entries",
        mib(dir_size(&a.dir)),
        entries_in(&a.doc_with("B")).await
    );

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
    // A deleted highlight names no book: every group of this device is read.
    // (Highlight IDs here repeat across books, unlike the app's: one that
    // no group holds measures the reading alone.)
    a.tombs.insert("anno:b9:gone".into(), now_ms());
    timed("A: purge one deleted highlight", a.purge()).await;
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

// ── Versions before sync protocol 3, and the move to per-book entries ──────

/// `write_entries_to_doc` as versions before protocol 3 had it: one entry
/// per item, annotations included.
async fn old_write(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    entries: &[(String, String)],
    respect_deletions: bool,
) -> (usize, Vec<DeletedDocKey>, Option<String>) {
    let mut written = 0;
    let mut deleted = Vec::new();
    for (key, value) in entries {
        let unchanged = matches!(
            doc.get_exact(author, key.as_bytes(), false).await,
            Ok(Some(own)) if own.content_hash() == iroh_blobs::Hash::new(value.as_bytes())
        );
        if unchanged {
            continue;
        }
        if respect_deletions && is_deletable_key(key) {
            if let Some(at) = newest_deletion(doc, key).await {
                deleted.push(DeletedDocKey {
                    key: key.clone(),
                    at: at / 1000,
                });
                continue;
            }
        }
        doc.set_bytes(author, key.clone().into_bytes(), value.clone().into_bytes())
            .await
            .unwrap();
        written += 1;
    }
    (written, deleted, None)
}

/// `read_docs` as versions before protocol 3 had it: every key on its own,
/// a key whose newest copy is a deletion reported deleted.
async fn old_read_docs(
    docs: &[iroh_docs::api::Doc],
    blobs: &iroh_blobs::api::Store,
    applied: Option<&HashMap<String, Vec<iroh_blobs::Hash>>>,
) -> DocRead {
    let mut headers: Vec<EntryHeader> = Vec::new();
    for doc in docs {
        headers.extend(read_headers(doc, None).await);
    }
    let current = hashes_by_key(&headers);
    let changed: std::collections::HashSet<&String> = current
        .iter()
        .filter(|(key, hashes)| applied.is_none_or(|a| a.get(*key) != Some(*hashes)))
        .map(|(key, _)| key)
        .collect();
    let (deleted, gone) = deletions(&headers, &changed);
    let mut per_key: HashMap<String, Vec<(u64, String)>> = HashMap::new();
    let mut seen = current.clone();
    let mut missing = Vec::new();
    for (key, at, hash) in &headers {
        if !changed.contains(key) || gone.contains(key) || *hash == iroh_blobs::Hash::EMPTY {
            continue;
        }
        match content_of(blobs, *hash).await {
            Some(v) => per_key.entry(key.clone()).or_default().push((*at, v)),
            None => {
                missing.push(*hash);
                match applied.and_then(|a| a.get(key)) {
                    Some(previous) => {
                        seen.insert(key.clone(), previous.clone());
                    }
                    None => {
                        seen.remove(key);
                    }
                }
            }
        }
    }
    DocRead {
        entries: combine_doc_values(per_key),
        deleted,
        seen,
        missing,
    }
}

/// `who` now runs this version: it restarts (full reads), and its paired
/// devices learn its protocol from its next hello.
async fn upgrade(who: &mut Device, others: &mut [&mut Device]) {
    who.old = false;
    who.kill().await;
    who.restart().await;
    let protocol = who.protocol();
    for other in others.iter_mut() {
        for p in other.pairings.iter_mut().filter(|p| p.peer == who.name) {
            p.protocol = protocol;
        }
    }
}

/// How many entries of each kind `author` has in `doc`: (single annotation
/// entries with content, annotation groups).
async fn annotation_entries_of(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
) -> (usize, usize) {
    let (mut singles, mut groups) = (0, 0);
    let stream = doc
        .get_many(
            iroh_docs::store::Query::author(author)
                .include_empty()
                .build(),
        )
        .await
        .unwrap();
    futures::pin_mut!(stream);
    while let Some(Ok(entry)) = stream.next().await {
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if entry.content_hash() == iroh_blobs::Hash::EMPTY {
            continue;
        }
        if crate::sync_annotations::parse_single_key(&key).is_some() {
            singles += 1;
        } else if crate::sync_annotations::parse_group_key(&key).is_some() {
            groups += 1;
        }
    }
    (singles, groups)
}

/// Every entry in `doc` (deletions included).
async fn entries_in(doc: &iroh_docs::api::Doc) -> usize {
    read_headers(doc, None).await.len()
}

/// The same library on every device, and each of `keys` as expected there.
fn assert_everywhere(devices: &[&Device], expected: &[(&str, Option<&str>)]) {
    for d in devices {
        for (key, value) in expected {
            assert_eq!(has(d, key).as_deref(), *value, "{key} on {}", d.name);
        }
    }
    for d in &devices[1..] {
        assert_eq!(
            d.snapshot(),
            devices[0].snapshot(),
            "{} and {}",
            d.name,
            devices[0].name
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn edits_to_different_highlights_of_one_book_on_two_devices_both_survive() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    a.edit("anno:1:x", "x").await;
    a.edit("anno:1:y", "y").await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[("anno:1:x", Some("x")), ("anno:1:y", Some("y"))],
    );

    // At the same time, before either syncs: A edits x, C edits y and adds z.
    a.edit("anno:1:x", "x edited on A").await;
    c.edit("anno:1:y", "y edited on C").await;
    c.edit("anno:1:z", "z from C").await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[
            ("anno:1:x", Some("x edited on A")),
            ("anno:1:y", Some("y edited on C")),
            ("anno:1:z", Some("z from C")),
        ],
    );
    // One entry per book and device; no single annotation entries.
    for (d, peer) in [(&a, "B"), (&b, "A"), (&b, "C"), (&c, "B")] {
        assert_eq!(
            annotation_entries_of(&d.doc_with(peer), d.author).await,
            (0, 1),
            "{}",
            d.name
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_highlight_deleted_on_one_device_and_edited_on_another_follows_the_later_change() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    for id in ["p", "q", "r"] {
        a.edit(&format!("anno:1:{id}"), id).await;
    }
    settle(&mut a, &mut b, &mut c).await;

    // p: deleted on A, then edited on C (later): the edit keeps it.
    a.delete("anno:1:p").await;
    c.edit("anno:1:p", "p edited on C after").await;
    // q: edited on C, then deleted on A (later): gone.
    c.edit("anno:1:q", "q edited on C before").await;
    a.delete("anno:1:q").await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[
            ("anno:1:p", Some("p edited on C after")),
            ("anno:1:q", None),
            ("anno:1:r", Some("r")),
        ],
    );

    // Everyone restarts (full reads, full provisioning): nothing changes.
    for d in [&mut a, &mut b, &mut c] {
        d.kill().await;
        d.restart().await;
    }
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[
            ("anno:1:p", Some("p edited on C after")),
            ("anno:1:q", None),
        ],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_highlight_deleted_while_a_device_is_off_never_comes_back() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    a.edit("anno:1:x", "x").await;
    a.edit("anno:1:y", "y").await;
    a.edit("anno:2:z", "z").await;
    settle(&mut a, &mut b, &mut c).await;
    assert_eq!(has(&c, "anno:1:x").as_deref(), Some("x"));

    // C is off for months: x is deleted, and its deletion record expires.
    c.kill().await;
    a.delete("anno:1:x").await;
    a.edit("anno:1:y", "y edited on A").await;
    round(&mut a, &mut b).await;
    round(&mut b, &mut a).await;
    assert_eq!(has(&b, "anno:1:x"), None);
    a.expire_tombstones().await;
    b.expire_tombstones().await;
    round(&mut a, &mut b).await;

    // C comes back with its unchanged copy of x.
    c.restart().await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[
            ("anno:1:x", None),
            ("anno:1:y", Some("y edited on A")),
            ("anno:2:z", Some("z")),
        ],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_book_takes_its_highlights_everywhere() {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    a.edit("anno:1:x", "x").await;
    c.edit("anno:1:y", "y from C").await;
    a.edit("anno:2:z", "z").await;
    settle(&mut a, &mut b, &mut c).await;

    // Only the book's deletion record: each device's purge marks every
    // highlight of the book deleted in its own group.
    a.delete("book:1").await;
    settle(&mut a, &mut b, &mut c).await;
    // The highlights go as the deletions the docs report (the markers).
    assert_everywhere(
        &[&a, &b, &c],
        &[("book:1", None), ("anno:1:x", None), ("anno:1:y", None)],
    );
    for d in [&mut a, &mut b, &mut c] {
        d.expire_tombstones().await;
        d.kill().await;
        d.restart().await;
    }
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[
            ("anno:1:x", None),
            ("anno:1:y", None),
            ("anno:2:z", Some("z")),
        ],
    );
}

/// A device on an older version (one entry per annotation) paired with this
/// one: it still gets and sends every change, deletions included.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_on_an_older_version_still_gets_and_sends_every_highlight() {
    let root = tempfile::tempdir().unwrap();
    let mut a = Device::new("A", root.path(), None).await;
    let mut o = Device::new("O", root.path(), None).await;
    o.old = true;
    pair(&mut a, &mut o).await;
    assert_eq!(a.pairings[0].protocol, 2);

    a.edit("book:1", "Dune").await;
    a.edit("anno:1:x", "x from A").await;
    o.edit("anno:1:y", "y from O").await;
    o.edit("anno:1:w", "w from O").await;
    for _ in 0..2 {
        round(&mut a, &mut o).await;
        round(&mut o, &mut a).await;
    }
    for d in [&a, &o] {
        assert_eq!(
            has(d, "anno:1:x").as_deref(),
            Some("x from A"),
            "{}",
            d.name
        );
        assert_eq!(
            has(d, "anno:1:y").as_deref(),
            Some("y from O"),
            "{}",
            d.name
        );
    }
    // A writes single entries as well as its group, for O.
    let (singles, groups) = annotation_entries_of(&a.doc_with("O"), a.author).await;
    assert_eq!((singles, groups), (3, 1));

    // Different highlights of the book edited on both; one deleted on each.
    a.edit("anno:1:x", "x edited on A").await;
    o.edit("anno:1:y", "y edited on O").await;
    a.delete("anno:1:w").await;
    o.delete("anno:1:x").await;
    for _ in 0..2 {
        round(&mut a, &mut o).await;
        round(&mut o, &mut a).await;
    }
    for d in [&a, &o] {
        assert_eq!(has(d, "anno:1:x"), None, "{}", d.name);
        assert_eq!(has(d, "anno:1:w"), None, "{}", d.name);
        assert_eq!(
            has(d, "anno:1:y").as_deref(),
            Some("y edited on O"),
            "{}",
            d.name
        );
    }
    // Restarts with expired deletion records bring nothing back.
    for d in [&mut a, &mut o] {
        d.expire_tombstones().await;
        d.kill().await;
        d.restart().await;
    }
    for _ in 0..2 {
        round(&mut a, &mut o).await;
        round(&mut o, &mut a).await;
    }
    assert_eq!(a.snapshot(), o.snapshot());
    assert_eq!(has(&a, "anno:1:x"), None);
    assert_eq!(has(&a, "anno:1:w"), None);
}

/// Whether `author` has a single entry (with content) for `key` in `doc`.
async fn has_single(doc: &iroh_docs::api::Doc, author: iroh_docs::AuthorId, key: &str) -> bool {
    matches!(
        doc.get_exact(author, key.as_bytes(), false).await,
        Ok(Some(_))
    )
}

/// Devices that synced with one entry per annotation move to one per book,
/// one after another: no highlight is lost or comes back at any step. Where
/// both sides read groups, no single entry is written any more; those left
/// from before stay and never win over a newer change.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn moving_to_per_book_entries_loses_and_resurrects_nothing() {
    let root = tempfile::tempdir().unwrap();
    let mut a = Device::new("A", root.path(), None).await;
    let mut b = Device::new("B", root.path(), None).await;
    let mut c = Device::new("C", root.path(), None).await;
    for d in [&mut a, &mut b, &mut c] {
        d.old = true;
    }
    pair(&mut a, &mut b).await;
    pair(&mut b, &mut c).await;

    // A library synced the old way, with deletions (emptied entries).
    a.edit("book:1", "Dune").await;
    for id in ["k", "d1", "d2", "e"] {
        a.edit(&format!("anno:1:{id}"), id).await;
    }
    c.edit("anno:1:c", "c from C").await;
    c.edit("anno:global:g", "a note without a book").await;
    settle(&mut a, &mut b, &mut c).await;
    a.delete("anno:1:d1").await;
    c.delete("anno:1:d2").await;
    settle(&mut a, &mut b, &mut c).await;
    let expected: &[(&str, Option<&str>)] = &[
        ("anno:1:k", Some("k")),
        ("anno:1:d1", None),
        ("anno:1:d2", None),
        ("anno:1:e", Some("e")),
        ("anno:1:c", Some("c from C")),
        ("anno:global:g", Some("a note without a book")),
    ];
    assert_everywhere(&[&a, &b, &c], expected);
    let library = a.snapshot();

    // B moves first: it reads groups, the others still read single entries.
    upgrade(&mut b, &mut [&mut a, &mut c]).await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(&[&a, &b, &c], expected);
    assert_eq!(a.snapshot(), library);
    // Its peers are older: B writes its groups and its single entries.
    for peer in ["A", "C"] {
        let (singles, groups) = annotation_entries_of(&b.doc_with(peer), b.author).await;
        assert!(
            singles >= 4 && groups == 2,
            "B with {peer}: {singles} {groups}"
        );
    }

    // An edit and a deletion while versions are mixed.
    b.edit("anno:1:e", "e edited on B").await;
    a.delete("anno:1:k").await;
    settle(&mut a, &mut b, &mut c).await;
    let expected: &[(&str, Option<&str>)] = &[
        ("anno:1:k", None),
        ("anno:1:d1", None),
        ("anno:1:d2", None),
        ("anno:1:e", Some("e edited on B")),
        ("anno:1:c", Some("c from C")),
        ("anno:global:g", Some("a note without a book")),
    ];
    assert_everywhere(&[&a, &b, &c], expected);

    // A moves. Between A and B only groups are written from now on: a new
    // highlight and an edit go into the book's group; the edited
    // highlight's old single entry stays behind, stale, and never wins.
    upgrade(&mut a, &mut [&mut b]).await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(&[&a, &b, &c], expected);
    a.edit("anno:1:n", "new on A").await;
    b.edit("anno:1:c", "c edited on B").await;
    settle(&mut a, &mut b, &mut c).await;
    let expected: &[(&str, Option<&str>)] = &[
        ("anno:1:k", None),
        ("anno:1:d1", None),
        ("anno:1:d2", None),
        ("anno:1:e", Some("e edited on B")),
        ("anno:1:c", Some("c edited on B")),
        ("anno:1:n", Some("new on A")),
        ("anno:global:g", Some("a note without a book")),
    ];
    assert_everywhere(&[&a, &b, &c], expected);
    let ab = a.doc_with("B");
    for (d, who) in [(&a, a.author), (&b, b.author)] {
        assert!(!has_single(&ab, who, "anno:1:n").await, "{}", d.name);
        assert_eq!(annotation_entries_of(&ab, who).await.1, 2, "{}", d.name);
    }
    let stale = ab.get_exact(b.author, b"anno:1:c".to_vec(), false).await;
    let stale = stale.unwrap().expect("B's old single entry is still there");
    let stale = content_of(&a.blobs, stale.content_hash()).await.unwrap();
    assert_eq!(decode(&stale).unwrap().value, "c from C");
    // C, older, still gets the new highlight as a single entry from B.
    assert!(has_single(&b.doc_with("C"), b.author, "anno:1:n").await);

    // C moves last; every deletion record expires; everyone restarts.
    upgrade(&mut c, &mut [&mut b]).await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(&[&a, &b, &c], expected);
    for d in [&mut a, &mut b, &mut c] {
        d.expire_tombstones().await;
        d.kill().await;
        d.restart().await;
    }
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(&[&a, &b, &c], expected);

    // And changes still travel afterwards, with no single entries.
    c.edit("anno:1:m", "new on C").await;
    c.edit("anno:1:c", "c edited on C").await;
    a.delete("anno:1:e").await;
    settle(&mut a, &mut b, &mut c).await;
    assert_everywhere(
        &[&a, &b, &c],
        &[
            ("anno:1:m", Some("new on C")),
            ("anno:1:c", Some("c edited on C")),
            ("anno:1:e", None),
            ("anno:1:k", None),
        ],
    );
    for (d, peer) in [(&a, "B"), (&b, "A"), (&b, "C"), (&c, "B")] {
        assert!(
            !has_single(&d.doc_with(peer), d.author, "anno:1:m").await,
            "{} with {peer}",
            d.name
        );
    }
}

// ── A deletion against an older copy of the same entry ─────────────────────

/// What `author` holds for `key` in `doc`: whether it is a deletion (an
/// emptied entry), and its timestamp.
async fn own_entry(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    key: &str,
) -> Option<(bool, u64)> {
    let e = doc.get_exact(author, key.as_bytes(), true).await.unwrap()?;
    Some((e.content_hash() == iroh_blobs::Hash::EMPTY, e.timestamp()))
}

/// iroh-docs 0.101 checks an arriving entry only against the *non-empty*
/// entries its author holds at that key or above it, so an older copy of an
/// entry its author has since emptied replaces the deletion
/// (`sync_deletions`). A deletes a book while B is off with A's older entry
/// for it (and C, behind B, with B's). When B comes back, whichever device
/// starts the exchange, the book stays deleted everywhere, even once every
/// deletion record has expired (months later, nothing else would hold it),
/// and A's deletion is the one it made, with its own time. With
/// `b_read_it`, B read the book before A deleted it, so B's copy is newer
/// than A's own older one and differs from it.
async fn deletion_against_an_older_copy(b_starts: bool, b_read_it: bool) {
    let root = tempfile::tempdir().unwrap();
    let (mut a, mut b, mut c) = three_devices(root.path()).await;
    a.edit("book:1", "Dune").await;
    a.edit("book:2", "Emma").await;
    settle(&mut a, &mut b, &mut c).await;
    if b_read_it {
        b.edit("book:1", "Dune (read on B)").await;
        round(&mut b, &mut a).await;
        assert_eq!(has(&a, "book:1").as_deref(), Some("Dune (read on B)"));
    }
    assert!(has(&c, "book:1").is_some());
    let held = own_entry(&b.doc_with("A"), a.author, "book:1").await;
    assert_eq!(held.map(|(empty, _)| empty), Some(false));

    // B and C are off; A deletes, and its record expires (months pass, A's
    // app restarts meanwhile).
    b.kill().await;
    c.kill().await;
    a.delete("book:1").await;
    a.provision().await;
    a.expire_tombstones().await;
    a.kill().await;
    a.restart().await;
    let ab = a.doc_with("B");
    let (empty, deleted_at) = own_entry(&ab, a.author, "book:1").await.unwrap();
    assert!(empty);

    b.restart().await;
    c.restart().await;
    let ex = if b_starts {
        exchange(&b, &a, true).await
    } else {
        exchange(&a, &b, true).await
    };
    assert!(ex.synced, "{ex:?}");
    // A's app reads what arrived; a full read, as the first after a start
    // (and one every 30 minutes) is: a changed-only read compares content
    // hashes, and the older copy has the hash A last read.
    a.applied = None;
    a.hydrate().await;
    b.hydrate().await;
    let case = format!("B starts: {b_starts}, B read it: {b_read_it}");
    assert_eq!(has(&a, "book:1"), None, "book:1 came back on A ({case})");
    // The deletion is back as it was: same time, nothing newer made up.
    assert_eq!(
        own_entry(&ab, a.author, "book:1").await,
        Some((true, deleted_at)),
        "A's deletion on A ({case})"
    );
    settle(&mut a, &mut b, &mut c).await;
    for d in [&a, &b, &c] {
        assert_eq!(
            has(d, "book:1"),
            None,
            "book:1 came back on {} ({case})",
            d.name
        );
        assert_eq!(
            has(d, "book:2").as_deref(),
            Some("Emma"),
            "{} ({case})",
            d.name
        );
    }
    for (name, doc) in [("A", a.doc_with("B")), ("B", b.doc_with("A"))] {
        assert_eq!(
            own_entry(&doc, a.author, "book:1").await,
            Some((true, deleted_at)),
            "A's deletion on {name} ({case})"
        );
    }
    for d in [&mut a, &mut b, &mut c] {
        d.kill().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_older_copy_of_a_deleted_entry_never_brings_it_back() {
    for b_starts in [true, false] {
        deletion_against_an_older_copy(b_starts, false).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_older_copy_of_a_deleted_entry_never_brings_it_back_after_another_device_read_it() {
    for b_starts in [true, false] {
        deletion_against_an_older_copy(b_starts, true).await;
    }
}

/// An optional extension must survive the real transport, legacy statistics,
/// independent reading while disconnected, and both exchange orders.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reading_rhythm_converges_after_offline_reading_and_legacy_statistics() {
    use theorem_core::reading_rhythm::{evaluate, RhythmRequest, RhythmState};
    fn progress(state: Option<RhythmState>, incoming: Option<RhythmState>) -> RhythmState {
        evaluate(RhythmRequest {
            today: "2026-10-31".into(),
            state,
            incoming,
            goal: None,
            legacy_activity: Vec::new(),
            reading: None,
        })
        .unwrap()
        .state
    }
    fn initial(source: &str, seconds: u32) -> RhythmState {
        evaluate(serde_json::from_value(serde_json::json!({
            "today":"2026-10-31", "goal":{"days":1,"stamp":"2026-10-31T00:00:00.000Z","id":"initial"},
            "reading":{"date":"2026-10-31","source":source,"seconds":seconds}
        })).unwrap()).unwrap().state
    }
    async fn publish(device: &Device, state: Option<&RhythmState>) {
        let mut value = serde_json::json!({"dailyActivity":[]});
        if let Some(state) = state {
            value["rhythm"] = serde_json::to_value(state).unwrap();
        }
        for p in &device.pairings {
            let (_, _, error) = device
                .write(
                    &p.doc,
                    p.protocol,
                    &[("reading_stats".into(), value.to_string())],
                    true,
                )
                .await;
            assert_eq!(error, None);
        }
    }
    async fn receive(device: &Device, existing: RhythmState) -> RhythmState {
        let read = read_docs(&device.doc_list(), &device.blobs, None, Some(&device.own)).await;
        let incoming = read
            .entries
            .get("reading_stats")
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
            .and_then(|value| value.get("rhythm").cloned())
            .map(|value| serde_json::from_value(value).unwrap());
        progress(Some(existing), incoming)
    }
    for reverse in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (a, b, c) = three_devices(root.path()).await;
        let mut sa = initial("A", 120);
        let mut sb = initial("B", 120);
        let mut sc = initial("C", 60);
        publish(&a, Some(&sa)).await;
        publish(&b, Some(&sb)).await;
        publish(&c, Some(&sc)).await;
        // C contributes its offline reading when it rejoins the exchanges below.
        assert!(exchange(&a, &b, true).await.synced);
        sa = receive(&a, sa).await;
        sb = receive(&b, sb).await;
        assert!(sa.awards.is_empty());
        assert!(sb.awards.is_empty());
        for _ in 0..3 {
            publish(&a, Some(&sa)).await;
            publish(&b, Some(&sb)).await;
            publish(&c, Some(&sc)).await;
            let pairs = if reverse {
                [(&b, &c), (&a, &b)]
            } else {
                [(&a, &b), (&b, &c)]
            };
            for (from, to) in pairs {
                assert!(exchange(from, to, true).await.synced);
            }
            sa = receive(&a, sa).await;
            sb = receive(&b, sb).await;
            sc = receive(&c, sc).await;
        }
        assert_eq!(sa, sb);
        assert_eq!(sb, sc);
        assert_eq!(sa.awards.values().sum::<u32>(), 30);
        publish(&b, None).await;
        assert!(exchange(&a, &b, true).await.synced);
        assert_eq!(receive(&a, sa.clone()).await, sa);
    }
}
