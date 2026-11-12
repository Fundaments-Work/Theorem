use crate::sync_state::*;

pub(super) fn reset_delivery_cache() {
    *DELIVERY.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

pub(super) async fn docs_get_all_entries(
    app: tauri::AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(read_doc_entries(&app, None).await?.entries)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDocEntries {
    pub entries: std::collections::HashMap<String, String>,
    /// Items deleted on another device. Doc deletions never expire, unlike
    /// the app's deletion records (90 days), so a device that was away for
    /// longer still learns about them instead of sending the items back.
    pub deleted: Vec<DeletedDocKey>,
    /// Pass to `docs_ack_entries` once `entries` are applied.
    pub token: u64,
}

/// The doc contents the app has applied, per key (the content hashes of
/// every device's copy), and the read waiting to be acknowledged.
#[derive(Default)]
pub(super) struct Delivery {
    applied: std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    pending:
        std::collections::HashMap<u64, std::collections::HashMap<String, Vec<iroh_blobs::Hash>>>,
    next_token: u64,
}

impl Delivery {
    pub(super) fn record_pending(
        &mut self,
        seen: std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    ) -> u64 {
        const MAX_PENDING_TOKENS: usize = 16;
        self.next_token += 1;
        let token = self.next_token;
        self.pending.insert(token, seen);
        while self.pending.len() > MAX_PENDING_TOKENS {
            let Some(&oldest) = self.pending.keys().min() else {
                break;
            };
            self.pending.remove(&oldest);
        }
        token
    }

    pub(super) fn ack(&mut self, token: u64) -> Result<(), String> {
        match self.pending.remove(&token) {
            Some(seen) => {
                self.applied = seen;
                Ok(())
            }
            None => Err("stale sync read".to_string()),
        }
    }
}

static DELIVERY: std::sync::Mutex<Option<Delivery>> = std::sync::Mutex::new(None);

/// Like `docs_get_all_entries`, but only keys whose content changed since
/// the last read the app acknowledged. Comparing content, not timestamps,
/// means a device with a wrong clock is never skipped; an unacknowledged
/// read (the merge failed) is simply sent again.
/// With `full`, every entry is returned (a periodic safety net), and the
/// acknowledgement still records them for the reads after it.
pub(super) async fn docs_get_changed_entries(
    app: tauri::AppHandle,
    full: Option<bool>,
) -> Result<ChangedDocEntries, String> {
    let applied = DELIVERY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .applied
        .clone();
    let baseline = (!full.unwrap_or(false)).then_some(&applied);
    let read = read_doc_entries(&app, baseline).await?;
    let mut guard = DELIVERY.lock().unwrap_or_else(|e| e.into_inner());
    let delivery = guard.get_or_insert_with(Default::default);
    let token = delivery.record_pending(read.seen);
    Ok(ChangedDocEntries {
        entries: read.entries,
        deleted: read.deleted,
        token,
    })
}

/// The entries of read `token` are applied: later reads skip them.
pub(super) async fn docs_ack_entries(token: u64) -> Result<(), String> {
    let mut guard = DELIVERY.lock().unwrap_or_else(|e| e.into_inner());
    let delivery = guard.get_or_insert_with(Default::default);
    delivery.ack(token)
}

pub(super) struct DocRead {
    pub(super) entries: std::collections::HashMap<String, String>,
    pub(super) deleted: Vec<DeletedDocKey>,
    /// Every key's copies as now read, for the next diff.
    pub(super) seen: std::collections::HashMap<String, Vec<iroh_blobs::Hash>>,
    /// Content of entries that are here without it (left out of the read).
    pub(super) missing: Vec<iroh_blobs::Hash>,
}

/// The newest entry header of one key in one doc: when it was written
/// (microseconds) and its content hash (`Hash::EMPTY` for a deletion).
pub(super) type EntryHeader = (String, u64, iroh_blobs::Hash);

/// Reads the paired docs. With `applied`, returns only keys whose copies
/// differ from it; always also returns what is now there, for the next diff.
/// A copy whose content has not arrived yet is left out of both, so it is
/// read again next time. Deletions are read too: a key whose newest copy (in
/// any doc) is a deletion comes back in `deleted`, not `entries`.
pub(super) async fn read_doc_entries(
    app: &tauri::AppHandle,
    applied: Option<&std::collections::HashMap<String, Vec<iroh_blobs::Hash>>>,
) -> Result<DocRead, String> {
    let api = get_docs_api(app).await?;
    let sync_state = get_sync_state(app)?;
    let (blobs, own) = {
        let guard = sync_state.transport_state.docs_api.lock().await;
        let snapshot = guard
            .as_ref()
            .ok_or_else(|| "iroh-docs not initialized".to_string())?;
        (snapshot.blobs.clone(), Some(snapshot.own_deletions.clone()))
    };
    // Copy the doc IDs and let go of the lock: reading the docs takes a while,
    // and pairing, writes and book transfers all need it meanwhile.
    let (doc_ids, peers): (Vec<iroh_docs::NamespaceId>, Vec<iroh::EndpointId>) = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        let doc_ids = devices
            .values()
            .filter(|d| !d.sync_doc_id.is_empty())
            .map(|d| d.sync_doc_id.parse())
            .collect::<Result<_, _>>()
            .map_err(|e| format!("parse doc id: {e}"))?;
        let peers = devices
            .values()
            .filter_map(|d| d.iroh_node_id.parse().ok())
            .collect();
        (doc_ids, peers)
    };

    let mut docs = Vec::with_capacity(doc_ids.len());
    for doc_id in doc_ids {
        if let Ok(Some(doc)) = api.open(doc_id).await {
            docs.push(doc);
        }
    }
    let read = read_docs(&docs, &blobs, applied, own.as_deref()).await;
    if read.missing.is_empty() {
        return Ok(read);
    }
    let Ok(endpoint) = get_or_init_iroh(app).await else {
        return Ok(read);
    };
    let fetched = fetch_missing_content(
        &blobs,
        &endpoint.endpoint,
        &peers,
        &read.missing,
        MISSING_CONTENT_BUDGET,
    )
    .await;
    if fetched == 0 {
        return Ok(read);
    }
    Ok(read_docs(&docs, &blobs, applied, own.as_deref()).await)
}

/// How long a read spends fetching content that never arrived.
pub(super) const MISSING_CONTENT_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

/// Fetches from the paired devices the content of doc entries that are here
/// without it, within `budget`; returns how many arrived. iroh-docs asks for
/// an entry's content once, when the entry arrives (again only when a
/// neighbour announces it, and it forgets what is missing on restart). An
/// exchange cut off after the entries but before their content, or an app
/// closed meanwhile, left those entries without content for good: later
/// exchanges bring no new entries, so nothing asked again, and the items
/// never reached this device.
pub(super) async fn fetch_missing_content(
    blobs: &iroh_blobs::api::Store,
    endpoint: &iroh::Endpoint,
    peers: &[iroh::EndpointId],
    hashes: &[iroh_blobs::Hash],
    budget: std::time::Duration,
) -> usize {
    use futures::StreamExt;
    if hashes.is_empty() || peers.is_empty() {
        return 0;
    }
    let downloader = blobs.downloader(endpoint);
    let fetched = std::sync::atomic::AtomicUsize::new(0);
    let mut unique: Vec<iroh_blobs::Hash> = hashes.to_vec();
    unique.sort();
    unique.dedup();
    let total = unique.len();
    let work = futures::stream::iter(unique)
        .map(|hash| {
            let (downloader, peers) = (downloader.clone(), peers.to_vec());
            async move { downloader.download(hash, peers).await.is_ok() }
        })
        .buffer_unordered(32)
        .for_each(|ok| {
            if ok {
                fetched.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            std::future::ready(())
        });
    let _ = tokio::time::timeout(budget, work).await;
    let fetched = fetched.load(std::sync::atomic::Ordering::Relaxed);
    log::info!("[iroh-sync] fetched {fetched} of {total} missing doc contents");
    fetched
}

/// [`read_doc_entries`] over open docs (one per paired device) and the blob
/// store holding their content. Annotations are combined per annotation
/// across every copy (see `sync_annotations`) and delivered as `anno:` items.
pub(super) async fn read_docs(
    docs: &[iroh_docs::api::Doc],
    blobs: &iroh_blobs::api::Store,
    applied: Option<&std::collections::HashMap<String, Vec<iroh_blobs::Hash>>>,
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> DocRead {
    use crate::sync_annotations as annos;
    // First the entry headers (cheap), then content only for keys that changed.
    let mut headers: Vec<EntryHeader> = Vec::new();
    for doc in docs {
        headers.extend(read_headers(doc, own).await);
    }
    let current = hashes_by_key(&headers);
    let item_headers: Vec<EntryHeader> = headers
        .iter()
        .filter(|(key, _, _)| !annos::is_annotation_key(key))
        .cloned()
        .collect();
    let changed: std::collections::HashSet<&String> = current
        .iter()
        .filter(|(key, hashes)| {
            !annos::is_annotation_key(key) && applied.is_none_or(|a| a.get(*key) != Some(*hashes))
        })
        .map(|(key, _)| key)
        .collect();
    let (mut deleted, gone) = deletions(&item_headers, &changed);
    let wanted: Vec<&EntryHeader> = item_headers
        .iter()
        .filter(|(key, _, hash)| {
            changed.contains(key) && !gone.contains(key) && *hash != iroh_blobs::Hash::EMPTY
        })
        .collect();

    // Books whose annotations changed: all their copies are read.
    let books = annos::changed_books(&current, applied);
    let mut book_headers: std::collections::HashMap<&str, Vec<&EntryHeader>> =
        std::collections::HashMap::new();
    for header in &headers {
        if let Some(book) = annos::book_of(&header.0) {
            if books.contains_key(book) {
                book_headers.entry(book).or_default().push(header);
            }
        }
    }

    let contents = load_contents(
        blobs,
        wanted
            .iter()
            .map(|h| h.2)
            .chain(book_headers.values().flatten().map(|h| h.2)),
    )
    .await;

    let mut per_key: std::collections::HashMap<String, Vec<(u64, String)>> =
        std::collections::HashMap::new();
    let mut incomplete: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut missing_hashes = Vec::new();
    for (key, at, hash) in wanted {
        match contents.get(hash) {
            Some(v) => per_key
                .entry(key.clone())
                .or_default()
                .push((*at, v.clone())),
            None => {
                incomplete.insert(key.clone());
                missing_hashes.push(*hash);
            }
        }
    }

    let mut annotation_entries: Vec<(String, String)> = Vec::new();
    for (book, change) in &books {
        let copies_of = book_headers
            .get(book.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let absent: Vec<iroh_blobs::Hash> = copies_of
            .iter()
            .map(|h| h.2)
            .filter(|hash| *hash != iroh_blobs::Hash::EMPTY && !contents.contains_key(hash))
            .collect();
        if !absent.is_empty() {
            // Read again next time, whole: a copy not here yet may hold a
            // newer change (a deletion) of any of the book's annotations.
            incomplete.extend(copies_of.iter().map(|h| h.0.clone()));
            missing_hashes.extend(absent);
            continue;
        }
        let copies: Vec<annos::Copy> = copies_of
            .iter()
            .filter_map(|(key, at, hash)| {
                let content = (*hash != iroh_blobs::Hash::EMPTY)
                    .then(|| contents.get(hash).map(String::as_str))
                    .flatten();
                annos::copy_from_entry(key, *at, *hash, content)
            })
            .collect();
        let ids = annos::ids_to_deliver(change, &copies);
        annos::deliver(
            book,
            &annos::resolve(&copies),
            ids.as_ref(),
            &mut annotation_entries,
            &mut deleted,
        );
    }
    deleted.sort_by(|a, b| a.key.cmp(&b.key));
    log::debug!(
        "[iroh-sync] read {} changed doc keys and {} books' annotations of {} keys ({} deleted, {} waiting for content)",
        changed.len(),
        books.len(),
        current.len(),
        deleted.len(),
        incomplete.len()
    );

    let mut seen = current;
    for key in &incomplete {
        // Keep what was applied before, so the key counts as changed again.
        match applied.and_then(|a| a.get(key)) {
            Some(previous) => {
                seen.insert(key.clone(), previous.clone());
            }
            None => {
                seen.remove(key);
            }
        }
    }
    let mut entries = combine_doc_values(per_key);
    entries.extend(annotation_entries);
    DocRead {
        entries,
        deleted,
        seen,
        missing: missing_hashes,
    }
}

/// The content of each of `hashes` that is here. Content usually arrives
/// with the exchange; what is still missing gets one short wait in all
/// (never one per entry: after an exchange cut off midway, thousands of
/// entries can be waiting for content that is not coming, and the read
/// stalled for minutes). Anything still missing is read again next time.
async fn load_contents(
    blobs: &iroh_blobs::api::Store,
    hashes: impl Iterator<Item = iroh_blobs::Hash>,
) -> std::collections::HashMap<iroh_blobs::Hash, String> {
    let mut unique: Vec<iroh_blobs::Hash> = hashes
        .filter(|hash| *hash != iroh_blobs::Hash::EMPTY)
        .collect();
    unique.sort();
    unique.dedup();
    let mut contents = std::collections::HashMap::with_capacity(unique.len());
    let mut missing = Vec::new();
    for hash in unique {
        match content_of(blobs, hash).await {
            Some(v) => {
                contents.insert(hash, v);
            }
            None => missing.push(hash),
        }
    }
    if !missing.is_empty() {
        tokio::time::sleep(CONTENT_GRACE).await;
        for hash in missing {
            if let Some(v) = content_of(blobs, hash).await {
                contents.insert(hash, v);
            }
        }
    }
    contents
}

/// How long a read waits, once, for content still on its way.
const CONTENT_GRACE: std::time::Duration = std::time::Duration::from_millis(150);

/// Every device's newest entry of every key in `doc` (each author keeps one
/// per key), deletions included. Not only the newest entry per key: the copy
/// written last is not always the newest change (see [`combine_doc_values`]),
/// and reading only it hid the newer one for good.
pub(super) async fn read_headers(
    doc: &iroh_docs::api::Doc,
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> Vec<EntryHeader> {
    use futures::StreamExt;
    let mut headers = Vec::new();
    let mut replaced = Vec::new();
    if let Ok(stream) = doc
        .get_many(iroh_docs::store::Query::all().include_empty().build())
        .await
    {
        futures::pin_mut!(stream);
        while let Some(Ok(entry)) = stream.next().await {
            let key = String::from_utf8_lossy(entry.key()).to_string();
            let deleted_at = own.and_then(|o| {
                o.replaced_deletion(
                    doc.id(),
                    entry.author(),
                    &key,
                    entry.timestamp(),
                    entry.content_hash(),
                )
            });
            match deleted_at {
                // An older copy of an entry this device deleted replaced the
                // deletion (see `sync_deletions`): read as the deletion, and
                // put back below.
                Some(at) => {
                    headers.push((key.clone(), at, iroh_blobs::Hash::EMPTY));
                    replaced.push((key, at));
                }
                None => headers.push((key, entry.timestamp(), entry.content_hash())),
            }
        }
    }
    if let Some(own) = own {
        for (key, at) in replaced {
            own.restore(doc, &key, at).await;
        }
    }
    headers
}

/// Among the `changed` keys, those whose newest copy across the docs is a
/// deletion: the items to report deleted, and every such key (items or not),
/// whose older copies must not be delivered as if current.
pub(super) fn deletions(
    headers: &[EntryHeader],
    changed: &std::collections::HashSet<&String>,
) -> (Vec<DeletedDocKey>, std::collections::HashSet<String>) {
    let mut newest: std::collections::HashMap<&String, (u64, iroh_blobs::Hash)> =
        std::collections::HashMap::new();
    for (key, at, hash) in headers {
        if !changed.contains(key) {
            continue;
        }
        let slot = newest.entry(key).or_insert((*at, *hash));
        if *at > slot.0 {
            *slot = (*at, *hash);
        }
    }
    let mut deleted = Vec::new();
    let mut gone = std::collections::HashSet::new();
    for (key, (at, hash)) in newest {
        if hash != iroh_blobs::Hash::EMPTY {
            continue;
        }
        gone.insert(key.clone());
        if is_deletable_key(key) {
            deleted.push(DeletedDocKey {
                key: key.clone(),
                at: at / 1000,
            });
        }
    }
    deleted.sort_by(|a, b| a.key.cmp(&b.key));
    (deleted, gone)
}

/// Every device's copy of each key, as content hashes in a stable order.
pub(super) fn hashes_by_key(
    headers: &[EntryHeader],
) -> std::collections::HashMap<String, Vec<iroh_blobs::Hash>> {
    let mut by_key: std::collections::HashMap<String, Vec<iroh_blobs::Hash>> =
        std::collections::HashMap::new();
    for (key, _, hash) in headers {
        by_key.entry(key.clone()).or_default().push(*hash);
    }
    for hashes in by_key.values_mut() {
        hashes.sort();
    }
    by_key
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedEntity {
    pub entity_type: String,
    pub entity_id: String,
}

/// Which of `keys` hold a record of a deleted entity: a book's entry, cover
/// and annotations, an annotation, collection, article or word.
pub(super) fn keys_of_deleted(entities: &[DeletedEntity], keys: &[String]) -> Vec<String> {
    let mut books = std::collections::HashSet::new();
    let mut by_kind: std::collections::HashMap<&str, std::collections::HashSet<&str>> =
        std::collections::HashMap::new();
    for e in entities {
        if e.entity_id.is_empty() {
            continue;
        }
        if e.entity_type == "book" {
            books.insert(e.entity_id.as_str());
        }
        by_kind
            .entry(e.entity_type.as_str())
            .or_default()
            .insert(e.entity_id.as_str());
    }
    let is = |kind: &str, id: &str| by_kind.get(kind).is_some_and(|ids| ids.contains(id));
    keys.iter()
        .filter(|key| {
            if let Some(id) = key
                .strip_prefix("book:")
                .or_else(|| key.strip_prefix("cover:"))
            {
                return books.contains(id);
            }
            if let Some(rest) = key.strip_prefix("anno:") {
                // anno:{bookId}:{annotationId}
                return match rest.split_once(':') {
                    Some((book, ann)) => books.contains(book) || is("annotation", ann),
                    None => false,
                };
            }
            if let Some(id) = key.strip_prefix("annotation:") {
                return is("annotation", id);
            }
            if let Some(id) = key.strip_prefix("collection:") {
                return is("collection", id);
            }
            if let Some(id) = key.strip_prefix("rss_article:") {
                return is("rss_article", id);
            }
            if let Some(id) = key.strip_prefix("rss_feed:") {
                return is("feed", id) || is("rss_feed", id);
            }
            if let Some(id) = key
                .strip_prefix("vocab:")
                .or_else(|| key.strip_prefix("vocabulary:"))
            {
                return is("vocabulary", id);
            }
            false
        })
        .cloned()
        .collect()
}

/// Removes this device's doc entries for deleted entities. Doc entries
/// outlive deletions, so once the deletion record expired (90 days) every
/// device used to bring the item back from them. Each device removes its own
/// copies (a doc deletion only covers its author), as tombstones reach it.
/// Returns how many entries were removed.
pub(super) async fn docs_purge_entities(
    app: tauri::AppHandle,
    entities: Vec<DeletedEntity>,
) -> Result<usize, String> {
    if entities.is_empty() {
        return Ok(0);
    }
    let snapshot = get_docs_snapshot(&app).await?;
    let sync_state = get_sync_state(&app)?;
    let doc_ids: Vec<iroh_docs::NamespaceId> = {
        let devices = sync_state.transport_state.paired_devices.lock().await;
        devices
            .values()
            .filter_map(|d| d.sync_doc_id.parse().ok())
            .collect()
    };
    let mut removed = 0usize;
    for doc_id in doc_ids {
        let Ok(Some(doc)) = snapshot.api.open(doc_id).await else {
            continue;
        };
        removed += purge_entities_in_doc(
            &doc,
            &snapshot.blobs,
            snapshot.author,
            &entities,
            Some(&snapshot.own_deletions),
        )
        .await;
    }
    Ok(removed)
}

/// [`docs_purge_entities`] for one doc: this device's entries of deleted
/// items are removed, and in its annotation groups the records of deleted
/// annotations (and of every annotation of a deleted book) become deletion
/// markers. Returns how many entries were removed or records marked.
pub(super) async fn purge_entities_in_doc(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    entities: &[DeletedEntity],
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> usize {
    let own_keys = own_entry_keys(doc, author).await;
    let removed = purge_single_entries(doc, author, entities, &own_keys, own).await;
    let of_kind = |kind: &str| -> std::collections::HashSet<&str> {
        entities
            .iter()
            .filter(|e| e.entity_type == kind && !e.entity_id.is_empty())
            .map(|e| e.entity_id.as_str())
            .collect()
    };
    let now = chrono::Utc::now().timestamp_millis();
    removed
        + crate::sync_annotations::purge_groups(
            doc,
            blobs,
            author,
            &own_keys,
            &of_kind("book"),
            &of_kind("annotation"),
            now,
        )
        .await
}

/// This device's keys in `doc` (deletions left out).
pub(super) async fn own_entry_keys(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
) -> Vec<String> {
    use futures::pin_mut;
    use futures::StreamExt;
    let mut own_keys = Vec::new();
    if let Ok(stream) = doc
        .get_many(iroh_docs::store::Query::author(author).build())
        .await
    {
        pin_mut!(stream);
        while let Some(Ok(entry)) = stream.next().await {
            own_keys.push(String::from_utf8_lossy(entry.key()).to_string());
        }
    }
    own_keys
}

/// Removes this device's entries (`own_keys`) that hold a deleted entity,
/// noting each deletion in `own` (see `sync_deletions`).
pub(super) async fn purge_single_entries(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    entities: &[DeletedEntity],
    own_keys: &[String],
    own: Option<&crate::sync_deletions::OwnDeletions>,
) -> usize {
    let to_delete = keys_of_deleted(entities, own_keys);
    let delete_set: std::collections::HashSet<&str> =
        to_delete.iter().map(String::as_str).collect();
    let mut removed = 0usize;
    for key in &to_delete {
        // `doc.del(prefix)` clears every entry starting with `prefix`
        // (`book:1` also clears `book:10`). Snapshot any live longer siblings
        // first, run `doc.del`, then re-insert them with a newer timestamp so
        // Willow/iroh-docs keeps those siblings on all devices.
        let shadowed_live: Vec<&str> = own_keys
            .iter()
            .map(String::as_str)
            .filter(|other| {
                other.len() > key.len()
                    && other.starts_with(key.as_str())
                    && !delete_set.contains(*other)
            })
            .collect();
        let mut preserved = Vec::new();
        let mut snapshot_ok = true;
        for other in &shadowed_live {
            match doc.get_exact(author, other.as_bytes(), false).await {
                Ok(Some(entry)) if entry.content_hash() != iroh_blobs::Hash::EMPTY => {
                    preserved.push((*other, entry.content_hash(), entry.content_len()));
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!(
                        "[iroh-sync] could not read shadowed sibling {other} before deleting {key}: {e}"
                    );
                    snapshot_ok = false;
                    break;
                }
            }
        }
        if !snapshot_ok {
            continue;
        }
        match doc.del(author, key.clone().into_bytes()).await {
            Ok(n) => {
                let mut restored = 0usize;
                if !preserved.is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    for (other, hash, size) in preserved {
                        for attempt in 0..4 {
                            match doc
                                .set_hash(author, other.as_bytes().to_vec(), hash, size)
                                .await
                            {
                                Ok(()) => {
                                    restored += 1;
                                    break;
                                }
                                Err(e)
                                    if attempt < 3
                                        && e.to_string().contains("NewerEntryExists") =>
                                {
                                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[iroh-sync] failed restoring sibling {other} after deleting {key}: {e}"
                                    );
                                    break;
                                }
                            }
                        }
                    }
                }
                removed += n.saturating_sub(restored);
                if let Some(own) = own {
                    own.record(doc, key).await;
                }
            }
            Err(e) => log::warn!("[iroh-sync] could not remove {key}: {e}"),
        }
    }
    removed
}

/// Keys that hold one record each: with several paired devices, the copy
/// written last wins whole.
pub(super) fn is_per_entity_key(key: &str) -> bool {
    [
        "book:",
        "anno:",
        "annotation:",
        "collection:",
        "cover:",
        "rss_article:",
        "rss_feed:",
        "tomb:",
        "vocab:",
        "vocabulary:",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

/// Independent edits must survive selecting the newest whole-book snapshot.
/// Missing fields on the winning version are removals, not an invitation to
/// bring the previous value back from a stale author's copy.
pub(super) fn combine_book_versions(values: &[(u64, String)], newest: String) -> String {
    let versions: Vec<_> = values
        .iter()
        .filter_map(|(written, raw)| {
            serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .filter(|v| v.is_object())
                .map(|v| (*written, v))
        })
        .collect();
    let Ok(mut merged) = serde_json::from_str::<serde_json::Value>(&newest) else {
        return newest;
    };
    let original = merged.clone();
    let Some(object) = merged.as_object_mut() else {
        return newest;
    };
    let stamp = |record: &serde_json::Value, field: &str| {
        record.get(field).and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_i64(),
            serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.timestamp_millis()),
            _ => None,
        })
    };
    for (field, fields) in [
        ("metadataUpdatedAt", crate::database::BOOK_EDITABLE_FIELDS),
        ("lastReadAt", crate::database::BOOK_READING_FIELDS),
        (
            "coverUpdatedAt",
            &[
                "coverUpdatedAt",
                "coverBlobHash",
                "coverPath",
                "coverExtractionDone",
            ][..],
        ),
    ] {
        let winner = versions
            .iter()
            .filter(|(_, v)| stamp(v, field).is_some())
            .max_by(|(wa, a), (wb, b)| {
                stamp(a, field)
                    .cmp(&stamp(b, field))
                    .then_with(|| {
                        if field == "lastReadAt" {
                            a.get("progress")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0)
                                .total_cmp(
                                    &b.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                )
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    })
                    .then(wa.cmp(wb))
            });
        if let Some((_, winner)) = winner {
            for key in fields {
                if let Some(value) = winner.get(*key) {
                    object.insert((*key).into(), value.clone());
                } else {
                    object.remove(*key);
                }
            }
        }
    }
    if merged == original {
        newest
    } else {
        serde_json::to_string(&merged).unwrap_or(newest)
    }
}

/// One value per key from the copies in each paired device's doc (each with
/// the time it was written). Records: the copy with the newest change (by
/// the record's own stamps; by when it was written when they tie or are
/// missing). The time of writing alone misleads: a device that passes on an
/// item it received writes its copy when it provisions, which can be after
/// another device's newer edit it has not read yet; that stale copy then hid
/// the edit from it, and from every device behind it, for good. Objects
/// (settings, stats): merged field by field, newer copies winning. Lists:
/// concatenated oldest first, for the app's merge to deduplicate. Anything
/// else: newest.
pub(super) fn combine_doc_values(
    per_key: std::collections::HashMap<String, Vec<(u64, String)>>,
) -> std::collections::HashMap<String, String> {
    let mut results = std::collections::HashMap::new();
    for (key, mut values) in per_key {
        values.sort_by_key(|(at, _)| *at);
        let newest = || values.last().map(|(_, v)| v.clone()).unwrap_or_default();
        if values.len() == 1 {
            results.insert(key, newest());
            continue;
        }
        if is_per_entity_key(&key) {
            let latest = values
                .iter()
                .map(|(at, v)| ((record_stamp(v).unwrap_or(i64::MIN), *at), v))
                .max_by_key(|(order, _)| *order)
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            let latest = if key.starts_with("book:") {
                combine_book_versions(&values, latest)
            } else {
                latest
            };
            results.insert(key, latest);
            continue;
        }
        let parsed: Vec<serde_json::Value> = values
            .iter()
            .filter_map(|(_, v)| serde_json::from_str(v).ok())
            .collect();
        let all_parsed = parsed.len() == values.len();
        let all_objects = all_parsed && parsed.iter().all(|v| v.is_object());
        let all_arrays = all_parsed && parsed.iter().all(|v| v.is_array());
        let combined = if all_objects {
            let mut merged = serde_json::Map::new();
            for obj in parsed.iter().filter_map(|v| v.as_object()) {
                for (k, val) in obj {
                    merged.insert(k.clone(), val.clone());
                }
            }
            // A shallow replacement would discard another author's offline reading.
            // Merge the optional extension independently; old peers still send legacy stats.
            if key == "reading_stats" {
                let mut rhythm = None;
                for value in &parsed {
                    if let Some(raw) = value.get("rhythm").filter(|v| !v.is_null()) {
                        if let Ok(incoming) = serde_json::from_value(raw.clone()) {
                            let request = theorem_core::reading_rhythm::RhythmRequest {
                                today: chrono::Local::now()
                                    .format("%Y-%m-%d")
                                    .to_string()
                                    .into_boxed_str(),
                                state: rhythm.clone(),
                                incoming: Some(incoming),
                                goal: None,
                                reading: None,
                                legacy_activity: Vec::new(),
                            };
                            if let Ok(progress) = theorem_core::reading_rhythm::evaluate(request) {
                                rhythm = Some(progress.state);
                            }
                        }
                    }
                }
                if let Some(rhythm) = rhythm {
                    if let Ok(value) = serde_json::to_value(rhythm) {
                        merged.insert("rhythm".into(), value);
                    }
                }
            }
            serde_json::to_string(&merged).ok()
        } else if all_arrays {
            let merged: Vec<serde_json::Value> = parsed
                .iter()
                .filter_map(|v| v.as_array())
                .flatten()
                .cloned()
                .collect();
            serde_json::to_string(&merged).ok()
        } else {
            None
        };
        let value = combined.unwrap_or_else(newest);
        results.insert(key, value);
    }
    results
}
