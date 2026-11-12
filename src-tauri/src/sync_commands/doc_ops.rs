use crate::iroh_sync;
use crate::sync_state::*;

pub(super) async fn docs_create_sync_doc(
    app: tauri::AppHandle,
    peer_device_id: String,
) -> Result<String, String> {
    let api = get_docs_api(&app).await?;
    let _author = get_docs_author(&app).await?;
    let doc = api.create().await.map_err(|e| format!("create doc: {e}"))?;
    let doc_id = doc.id();
    let ticket = doc
        .share(
            iroh_docs::api::protocol::ShareMode::Write,
            Default::default(),
        )
        .await
        .map_err(|e| format!("share doc: {e}"))?;

    if let Ok(blobs) = get_blobs_store(&app).await {
        iroh_sync::subscribe_doc_events(app.clone(), doc, blobs);
    }

    let sync_state = get_sync_state(&app)?;
    let mut devices = sync_state.transport_state.paired_devices.lock().await;
    if let Some(device) = devices.get_mut(&peer_device_id) {
        device.sync_doc_id = doc_id.to_string();
        let _ = sync_state.transport_state.persist_paired(&devices);
    }

    Ok(ticket.to_string())
}

pub(super) async fn docs_import_sync_doc(
    app: tauri::AppHandle,
    peer_device_id: String,
    ticket_str: String,
) -> Result<(), String> {
    let api = get_docs_api(&app).await?;
    let ticket: iroh_docs::DocTicket = ticket_str
        .parse()
        .map_err(|e| format!("parse ticket: {e}"))?;
    let doc = api
        .import(ticket)
        .await
        .map_err(|e| format!("import doc: {e}"))?;
    let doc_id = doc.id();

    if let Ok(blobs) = get_blobs_store(&app).await {
        iroh_sync::subscribe_doc_events(app.clone(), doc, blobs);
    }

    let sync_state = get_sync_state(&app)?;
    let mut devices = sync_state.transport_state.paired_devices.lock().await;
    if let Some(device) = devices.get_mut(&peer_device_id) {
        device.sync_doc_id = doc_id.to_string();
        let _ = sync_state.transport_state.persist_paired(&devices);
    }

    Ok(())
}

/// The paired docs, each with the protocol of the device it is shared with.
pub(super) async fn sync_doc_targets(
    app: &tauri::AppHandle,
) -> Result<Vec<(iroh_docs::NamespaceId, u8)>, String> {
    let sync_state = get_sync_state(app)?;
    let devices = sync_state.transport_state.paired_devices.lock().await;
    Ok(devices
        .values()
        .filter_map(|d| {
            d.sync_doc_id
                .parse::<iroh_docs::NamespaceId>()
                .ok()
                .map(|doc_id| (doc_id, d.protocol))
        })
        .collect())
}

/// Writes entries as this device to every paired doc and returns how many
/// were written. An entry equal to what this device last wrote under its key
/// is skipped: rewriting it would date it now, as if just edited, which
/// would bring back an item another device deleted meanwhile (and send it
/// again for nothing). Whole-list entries go only where they are still read.
async fn write_own_entries(
    app: &tauri::AppHandle,
    entries: &[(String, String)],
    respect_deletions: bool,
) -> Result<DocWriteResult, String> {
    let snapshot = get_docs_snapshot(app).await?;
    let targets = sync_doc_targets(app).await?;

    // Surface write failures instead of silently dropping data, so the
    // frontend knows the sync doc wasn't updated and can retry.
    let mut first_error: Option<String> = None;
    let mut written = 0usize;
    let mut deleted: Vec<DeletedDocKey> = Vec::new();
    for (doc_id, protocol) in &targets {
        let doc = match snapshot.api.open(*doc_id).await {
            Ok(Some(doc)) => doc,
            Ok(None) => {
                first_error.get_or_insert_with(|| format!("sync doc not found: {doc_id}"));
                continue;
            }
            Err(e) => {
                first_error.get_or_insert_with(|| format!("open doc {doc_id}: {e}"));
                continue;
            }
        };
        fold_single_deletions_once(&doc, &snapshot.blobs, snapshot.author).await;
        let (n, found, error) = write_entries_to_doc(
            &doc,
            &snapshot.blobs,
            snapshot.author,
            *protocol,
            entries,
            respect_deletions,
        )
        .await;
        written += n;
        for d in found {
            if !deleted.iter().any(|x| x.key == d.key) {
                deleted.push(d);
            }
        }
        if let Some(e) = error {
            let msg = format!("{doc_id}: {e}");
            log::warn!("[iroh-sync] {msg}");
            first_error.get_or_insert(msg);
        }
    }

    match first_error {
        Some(err) => Err(err),
        None => Ok(DocWriteResult { written, deleted }),
    }
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocWriteResult {
    pub written: usize,
    /// Items not written because another device deleted them since this
    /// device last wrote them (see [`write_own_entries`]).
    pub deleted: Vec<DeletedDocKey>,
}

/// [`write_own_entries`] for one doc, shared with a device on `protocol`.
/// Returns how many entries were written, the items left unwritten because
/// their newest entry is a deletion (with `respect_deletions`), and the
/// first failure. Annotations go into this device's group of their book
/// (see `sync_annotations`).
pub(super) async fn write_entries_to_doc(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    protocol: u8,
    entries: &[(String, String)],
    respect_deletions: bool,
) -> (usize, Vec<DeletedDocKey>, Option<String>) {
    let mut written = 0usize;
    let mut deleted = Vec::new();
    let mut error = None;
    let mut annotations: Vec<(&str, &str)> = Vec::new();
    for (key, value) in entries {
        if crate::sync_annotations::is_annotation_key(key) {
            // Groups are built here, never taken whole from the app.
            if crate::sync_annotations::parse_single_key(key).is_some() {
                annotations.push((key, value));
            }
            continue;
        }
        if is_legacy_list_key(key) && !reads_legacy_lists(protocol) {
            continue;
        }
        let unchanged = matches!(
            doc.get_exact(author, key.as_bytes(), false).await,
            Ok(Some(own)) if own.content_hash() == iroh_blobs::Hash::new(value.as_bytes())
        );
        if unchanged {
            continue;
        }
        if respect_deletions && is_deletable_key(key) {
            if let Some(at) = newest_deletion(doc, key).await {
                // Deleted since this device last wrote it (or before it ever
                // did): writing now would undo that. The app decides.
                deleted.push(DeletedDocKey {
                    key: key.clone(),
                    at: at / 1000,
                });
                continue;
            }
        }
        match doc
            .set_bytes(author, key.clone().into_bytes(), value.clone().into_bytes())
            .await
        {
            Ok(_) => written += 1,
            Err(e) => {
                error.get_or_insert(format!("set_bytes {key}: {e}"));
            }
        }
    }
    if !annotations.is_empty() {
        let (n, held, e) = crate::sync_annotations::write_annotations(
            doc,
            blobs,
            author,
            protocol,
            &annotations,
            respect_deletions,
        )
        .await;
        written += n;
        deleted.extend(held);
        if let Some(e) = e {
            error.get_or_insert(e);
        }
    }
    (written, deleted, error)
}

/// Docs whose single annotation deletions from this device were copied into
/// its groups since start (`sync_annotations::fold_single_deletions`).
type DocSet = std::collections::HashSet<iroh_docs::NamespaceId>;
static SINGLE_DELETIONS_FOLDED: std::sync::Mutex<Option<DocSet>> = std::sync::Mutex::new(None);

/// [`crate::sync_annotations::fold_single_deletions`] once per doc and
/// start; retried while it fails.
pub(super) async fn fold_single_deletions_once(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
) {
    let id = doc.id();
    let done = SINGLE_DELETIONS_FOLDED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|set| set.contains(&id));
    if done {
        return;
    }
    match crate::sync_annotations::fold_single_deletions(doc, blobs, author).await {
        Ok(n) => {
            if n > 0 {
                log::info!("[iroh-sync] {n} annotation deletions copied into per-book entries");
            }
            SINGLE_DELETIONS_FOLDED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert_with(Default::default)
                .insert(id);
        }
        Err(e) => log::warn!("[iroh-sync] annotation deletions not copied yet: {e}"),
    }
}

/// When `key`'s newest entry in `doc` (by any device) is a deletion, when
/// that deletion was made (microseconds).
pub(super) async fn newest_deletion(doc: &iroh_docs::api::Doc, key: &str) -> Option<u64> {
    let newest = doc
        .get_one(
            iroh_docs::store::Query::single_latest_per_key()
                .key_exact(key.as_bytes())
                .include_empty()
                .build(),
        )
        .await
        .ok()??;
    (newest.content_hash() == iroh_blobs::Hash::EMPTY).then(|| newest.timestamp())
}

pub(super) async fn docs_set_entry(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    // A change made on this device just now: newer than any deletion.
    write_own_entries(&app, &[(key, value)], false)
        .await
        .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct DocEntryInput {
    pub key: String,
    pub value: String,
}

/// Several entries in one call (provisioning sends every item at once);
/// see [`write_own_entries`]. Provisioning writes what this device holds,
/// which may predate a deletion made elsewhere: an item whose newest entry is
/// a deletion is not written but returned in `deleted`, for the app to apply
/// the deletion, or (the item changed here since) to write it with `force`.
pub(super) async fn docs_set_entries(
    app: tauri::AppHandle,
    entries: Vec<DocEntryInput>,
    force: Option<bool>,
) -> Result<DocWriteResult, String> {
    let entries: Vec<(String, String)> = entries.into_iter().map(|e| (e.key, e.value)).collect();
    write_own_entries(&app, &entries, !force.unwrap_or(false)).await
}

/// Removes this device's entries under `prefix` whose keys are not in `keep`
/// (deletion records that expired, for one). Returns how many were removed.
pub(super) async fn docs_retain_own_entries(
    app: tauri::AppHandle,
    prefix: String,
    keep: Vec<String>,
) -> Result<usize, String> {
    use futures::pin_mut;
    use futures::StreamExt;
    if prefix.is_empty() {
        return Err("a prefix is required".to_string());
    }
    let snapshot = get_docs_snapshot(&app).await?;
    let keep: std::collections::HashSet<String> = keep.into_iter().collect();
    let mut removed = 0usize;
    for (doc_id, _) in sync_doc_targets(&app).await? {
        let Ok(Some(doc)) = snapshot.api.open(doc_id).await else {
            continue;
        };
        let mut own_keys = Vec::new();
        if let Ok(stream) = doc
            .get_many(
                iroh_docs::store::Query::author(snapshot.author)
                    .key_prefix(prefix.as_bytes())
                    .build(),
            )
            .await
        {
            pin_mut!(stream);
            while let Some(Ok(entry)) = stream.next().await {
                own_keys.push(String::from_utf8_lossy(entry.key()).to_string());
            }
        }
        for key in own_keys.iter().filter(|k| !keep.contains(*k)) {
            if shadows_other_key(key, &own_keys, &keep) {
                continue;
            }
            match doc.del(snapshot.author, key.clone().into_bytes()).await {
                Ok(n) => removed += n,
                Err(e) => log::warn!("[iroh-sync] could not remove {key}: {e}"),
            }
        }
    }
    Ok(removed)
}

/// A doc deletion is by prefix: deleting `key` would also delete any longer
/// key starting with it (book:12 takes book:123). True when such a key is
/// one to keep.
pub(super) fn shadows_other_key(
    key: &str,
    own_keys: &[String],
    keep: &std::collections::HashSet<String>,
) -> bool {
    own_keys
        .iter()
        .any(|other| other.len() > key.len() && other.starts_with(key) && keep.contains(other))
}
