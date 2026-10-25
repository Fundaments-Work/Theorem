//! Keeping this device's deletions in the sync docs.
//!
//! A deletion in a doc is an emptied entry. iroh-docs 0.101 stores an
//! arriving entry unless its author already holds a *non-empty* entry at
//! that key, or at a key above it, that is as new or newer
//! (`ranger::Store::put` checks `prefixes_of`, which leaves empty entries
//! out). So when a paired device that was away still holds this device's
//! older entry for an item this device has since deleted, and sends it
//! during an exchange, it replaces the deletion here: the item comes back
//! on the next full read, and once deletion records have expired nothing
//! deletes it again. (The other device receives the deletion in the same
//! exchange, so the two then hold opposite states.)
//!
//! Only entries of this device's own author are affected, and nothing else
//! ever brings this device an entry of its own author older than what it
//! holds. So this device keeps a ledger of the deletions it wrote (doc, key,
//! when) next to the docs store, and when an older entry of its own replaces
//! one, puts the deletion back exactly as it was: the same empty entry with
//! the same timestamp, signed again with this device's keys. Nothing new
//! travels: peers receive the very entry they would have had.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The ledger file, in the docs folder (it goes with the docs it describes).
pub(crate) const LEDGER_FILE: &str = "own-deletions.jsonl";

#[derive(serde::Serialize, serde::Deserialize)]
struct Line {
    doc: String,
    key: String,
    /// The deletion entry's timestamp (µs, as iroh-docs keeps it).
    at: u64,
}

/// This device's deletions in its docs, and what puts one back.
pub(crate) struct OwnDeletions {
    path: PathBuf,
    by_doc: Mutex<HashMap<iroh_docs::NamespaceId, HashMap<Box<str>, u64>>>,
    sync: iroh_docs::actor::SyncHandle,
    author: iroh_docs::AuthorId,
    /// This node, named as where a restored entry came from.
    node: iroh_docs::PeerIdBytes,
}

impl OwnDeletions {
    /// Loads the ledger kept in `docs_dir` (none yet is an empty one).
    pub(crate) fn open(
        docs_dir: &Path,
        sync: iroh_docs::actor::SyncHandle,
        author: iroh_docs::AuthorId,
        node: iroh::EndpointId,
    ) -> Self {
        let path = docs_dir.join(LEDGER_FILE);
        let mut by_doc: HashMap<iroh_docs::NamespaceId, HashMap<Box<str>, u64>> = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                // A line cut off by a crash is skipped; the rest still count.
                let Ok(l) = serde_json::from_str::<Line>(line) else {
                    continue;
                };
                let Ok(doc) = l.doc.parse::<iroh_docs::NamespaceId>() else {
                    continue;
                };
                let slot = by_doc
                    .entry(doc)
                    .or_default()
                    .entry(l.key.into())
                    .or_insert(0);
                *slot = (*slot).max(l.at);
            }
        }
        OwnDeletions {
            path,
            by_doc: Mutex::new(by_doc),
            sync,
            author,
            node: *node.as_bytes(),
        }
    }

    /// When this device last deleted `key` in `doc` (µs), if it did.
    pub(crate) fn deleted_at(&self, doc: iroh_docs::NamespaceId, key: &str) -> Option<u64> {
        let by_doc = self.by_doc.lock().unwrap_or_else(|e| e.into_inner());
        by_doc.get(&doc)?.get(key).copied()
    }

    /// Whether an entry of this device's own author is an older copy of
    /// something it deleted since: then the deletion's time.
    pub(crate) fn replaced_deletion(
        &self,
        doc: iroh_docs::NamespaceId,
        author: iroh_docs::AuthorId,
        key: &str,
        timestamp: u64,
        hash: iroh_blobs::Hash,
    ) -> Option<u64> {
        if author != self.author || hash == iroh_blobs::Hash::EMPTY {
            return None;
        }
        self.deleted_at(doc, key).filter(|at| *at > timestamp)
    }

    /// Notes the deletion this device just wrote for `key` (its entry's
    /// timestamp is read back from the doc).
    pub(crate) async fn record(&self, doc: &iroh_docs::api::Doc, key: &str) {
        let Ok(Some(entry)) = doc.get_exact(self.author, key.as_bytes(), true).await else {
            return;
        };
        if entry.content_hash() != iroh_blobs::Hash::EMPTY {
            return;
        }
        let at = entry.timestamp();
        {
            let mut by_doc = self.by_doc.lock().unwrap_or_else(|e| e.into_inner());
            let slot = by_doc
                .entry(doc.id())
                .or_default()
                .entry(key.into())
                .or_insert(0);
            if *slot >= at {
                return;
            }
            *slot = at;
        }
        let line = Line {
            doc: doc.id().to_string(),
            key: key.to_string(),
            at,
        };
        let appended = serde_json::to_string(&line)
            .map_err(std::io::Error::other)
            .and_then(|mut s| {
                s.push('\n');
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?
                    .write_all(s.as_bytes())
            });
        if let Err(e) = appended {
            log::warn!("[iroh-sync] could not note a deletion: {e}");
        }
    }

    /// Puts back this device's deletion of `key` in `doc`, made at `at` (µs),
    /// which an older copy of its entry replaced. Returns whether it did.
    pub(crate) async fn restore(&self, doc: &iroh_docs::api::Doc, key: &str, at: u64) -> bool {
        match self.try_restore(doc, key, at).await {
            Ok(done) => {
                if done {
                    log::info!("[iroh-sync] put back a deletion an older copy had replaced");
                }
                done
            }
            Err(e) => {
                log::warn!("[iroh-sync] could not put back a deletion: {e}");
                false
            }
        }
    }

    async fn try_restore(
        &self,
        doc: &iroh_docs::api::Doc,
        key: &str,
        at: u64,
    ) -> Result<bool, String> {
        use futures::StreamExt;
        let err = |e: &dyn std::fmt::Display| e.to_string();
        // Only an older copy is replaced: something this device wrote after
        // the deletion (the item added again) stays.
        match doc
            .get_exact(self.author, key.as_bytes(), true)
            .await
            .map_err(|e| err(&e))?
        {
            Some(e) if e.timestamp() < at && e.content_hash() != iroh_blobs::Hash::EMPTY => {}
            _ => return Ok(false),
        }
        // The deletion removes this device's entries under `key` as old as
        // itself: as when it was first written, it is not put back over a
        // longer key of its own (book:1 over book:12).
        let under = doc
            .get_many(
                iroh_docs::store::Query::author(self.author)
                    .key_prefix(key.as_bytes())
                    .build(),
            )
            .await
            .map_err(|e| err(&e))?;
        let mut under = std::pin::pin!(under);
        while let Some(e) = under.next().await {
            let e = e.map_err(|e| err(&e))?;
            if e.key().len() > key.len() && e.timestamp() <= at {
                return Ok(false);
            }
        }
        let author = self
            .sync
            .export_author(self.author)
            .await
            .map_err(|e| err(&e))?
            .ok_or_else(|| "author key missing".to_string())?;
        let ticket = doc
            .share(
                iroh_docs::api::protocol::ShareMode::Write,
                iroh_docs::api::protocol::AddrInfoOptions::Id,
            )
            .await
            .map_err(|e| err(&e))?;
        let secret = ticket.capability.secret_key().map_err(|e| err(&e))?;
        let entry = iroh_docs::Entry::new(
            iroh_docs::RecordIdentifier::new(doc.id(), self.author, key),
            iroh_docs::Record::new(iroh_blobs::Hash::EMPTY, 0, at),
        )
        .sign(secret, &author);
        self.sync
            .insert_remote(
                doc.id(),
                entry,
                self.node,
                iroh_docs::ContentStatus::Complete,
            )
            .await
            .map_err(|e| err(&e))?;
        Ok(true)
    }
}

/// The docs engine, built as `iroh_docs::protocol::Docs::persistent` does,
/// keeping a handle to its store actor (needed to put a deletion back with
/// its own timestamp; the docs API stamps every write with the current time).
pub(crate) async fn spawn_docs(
    dir: &Path,
    endpoint: iroh::Endpoint,
    blobs: iroh_blobs::api::Store,
    gossip: iroh_gossip::net::Gossip,
) -> Result<(iroh_docs::protocol::Docs, iroh_docs::actor::SyncHandle), String> {
    let store =
        iroh_docs::store::Store::persistent(dir.join("docs.redb")).map_err(|e| format!("{e:?}"))?;
    let authors = iroh_docs::engine::DefaultAuthorStorage::Persistent(dir.join("default-author"));
    let downloader = blobs.downloader(&endpoint);
    let engine =
        iroh_docs::engine::Engine::spawn(endpoint, gossip, store, blobs, downloader, authors, None)
            .await
            .map_err(|e| format!("{e:?}"))?;
    let sync = engine.sync.clone();
    Ok((iroh_docs::protocol::Docs::new(engine), sync))
}
