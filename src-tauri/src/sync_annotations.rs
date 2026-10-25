//! Annotations in the sync docs: one entry per book.
//!
//! Each device writes `annos:{bookId}:` (`annos:global:` for annotations
//! with no book) holding every annotation of that book it has, by ID, and a
//! deletion marker (ID and when it was deleted, ms) for each one it deleted:
//!
//! ```json
//! {"annotations":{"a1":{...record...}},"deleted":{"a2":1761400000000}}
//! ```
//!
//! A library of 5,000 books with 50,000 highlights is then 10,000 entries
//! instead of 55,000, and iroh-docs storing entries is what made the first
//! exchange of a large library take minutes.
//!
//! The key ends in `:` because iroh-docs keys are paths: writing a key
//! removes the same device's older entries under it, so `annos:b1` would
//! wipe `annos:b12`. The book part never contains `:` (it is read from
//! `anno:{book}:{id}` up to the first one), so no group key extends another.
//!
//! Before sync protocol 3 every annotation was its own entry,
//! `anno:{bookId}:{annotationId}`, and a deletion was that entry emptied.
//! Those are still read (from devices on older versions, and as left in
//! docs), and still written, alongside the groups, to docs shared with a
//! device on an older version. Reading combines, **per annotation**, every
//! device's group and every single entry by the record's own stamps, so a
//! highlight missing from one device's group is never taken as deleted, and
//! edits to different highlights of one book on two devices both survive.
//! The app keeps working with `anno:` keys: groups are expanded into them
//! when read and built from them when written.
//!
//! Single entries already in a doc stay there. Removing them is not safe:
//! emptying one is a deletion to every reader, and a prefix deletion does
//! not hold in iroh-docs 0.101 (an entry arriving from a device that still
//! has an older copy under the prefix is put back, as only non-empty
//! entries are checked). They never win wrongly: this device stops writing
//! them where they are not read, so its group always holds its newer
//! change, and the merge goes by stamps, not by kind of entry. Its old
//! deletions are copied into its groups as markers
//! ([`fold_single_deletions`]), and markers, unlike empty entries, cannot be
//! put back over. A new pairing gets a new doc: groups only.

use crate::sync_commands::{content_of, record_meta, DeletedDocKey};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, HashMap, HashSet};

/// One entry per book (sync protocol 3).
pub(crate) const GROUP_PREFIX: &str = "annos:";
/// One entry per annotation (before protocol 3).
pub(crate) const SINGLE_PREFIX: &str = "anno:";

/// Whether a device on `protocol` still reads only the single entries.
pub(crate) fn reads_single_annotations(protocol: u8) -> bool {
    protocol < 3
}

pub(crate) fn group_key(book: &str) -> String {
    format!("{GROUP_PREFIX}{book}:")
}

pub(crate) fn single_key(book: &str, id: &str) -> String {
    format!("{SINGLE_PREFIX}{book}:{id}")
}

/// `anno:{book}:{id}` as (book, id); the ID may itself contain `:`.
pub(crate) fn parse_single_key(key: &str) -> Option<(&str, &str)> {
    let (book, id) = key.strip_prefix(SINGLE_PREFIX)?.split_once(':')?;
    (!book.is_empty() && !id.is_empty()).then_some((book, id))
}

/// `annos:{book}:` as its book.
pub(crate) fn parse_group_key(key: &str) -> Option<&str> {
    key.strip_prefix(GROUP_PREFIX)?
        .strip_suffix(':')
        .filter(|book| !book.is_empty() && !book.contains(':'))
}

/// Keys read and written here rather than as plain items: groups, single
/// entries, and any other `anno:` key (read as nothing).
pub(crate) fn is_annotation_key(key: &str) -> bool {
    key.starts_with(SINGLE_PREFIX) || key.starts_with(GROUP_PREFIX)
}

/// The book an annotation key belongs to.
pub(crate) fn book_of(key: &str) -> Option<&str> {
    parse_group_key(key).or_else(|| parse_single_key(key).map(|(book, _)| book))
}

/// One device's annotations of one book.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Group {
    /// Records as the app wrote them, byte for byte.
    #[serde(default)]
    pub annotations: BTreeMap<String, Box<RawValue>>,
    /// Annotations this device deleted: when (ms since the epoch).
    #[serde(default)]
    pub deleted: BTreeMap<String, i64>,
}

impl Group {
    pub(crate) fn parse(raw: &str) -> Option<Group> {
        serde_json::from_str(raw).ok()
    }

    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Records `raw` as annotation `id` (no longer deleted). Whether the
    /// group changed; an error when `raw` is not JSON.
    pub(crate) fn put_record(&mut self, id: &str, raw: &str) -> Result<bool, String> {
        let unchanged = self.annotations.get(id).is_some_and(|r| r.get() == raw)
            && !self.deleted.contains_key(id);
        if unchanged {
            return Ok(false);
        }
        let value = RawValue::from_string(raw.to_string())
            .map_err(|e| format!("annotation {id} is not JSON: {e}"))?;
        self.annotations.insert(id.to_string(), value);
        self.deleted.remove(id);
        Ok(true)
    }

    /// Marks annotation `id` deleted at `at` (ms). Whether the group changed.
    pub(crate) fn put_deleted(&mut self, id: &str, at: i64) -> bool {
        let had_record = self.annotations.remove(id).is_some();
        let previous = self.deleted.insert(id.to_string(), at);
        had_record || previous != Some(at)
    }

    /// Every annotation ID it mentions, deleted or not.
    pub(crate) fn ids(&self) -> impl Iterator<Item = &String> {
        self.annotations.keys().chain(self.deleted.keys())
    }
}

/// One device's copy of a book's annotations, as found in a doc.
#[derive(Debug)]
pub(crate) enum Copy {
    /// A group (`annos:`); `hash` is its entry's content hash.
    Group {
        written: u64,
        hash: iroh_blobs::Hash,
        group: Group,
    },
    /// A single entry (`anno:`); `None` is a deletion (an empty entry).
    Single {
        id: String,
        written: u64,
        value: Option<String>,
    },
}

/// What a copy says about one annotation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State<'a> {
    Record(&'a str),
    Deleted,
}

#[derive(Debug, Clone, Copy)]
struct Candidate<'a> {
    /// When the change was made (ms): the record's stamps, a marker's
    /// `deletedAt`, or, failing those, when the entry was written.
    stamp: i64,
    /// When the entry was written (µs).
    written: u64,
    state: State<'a>,
}

impl Candidate<'_> {
    /// The newer change wins; on a tie a deletion wins (an edit keeps an
    /// item only when made after the deletion), then the later write.
    fn order(&self) -> (i64, bool, u64) {
        (
            self.stamp,
            matches!(self.state, State::Deleted),
            self.written,
        )
    }
}

/// An annotation's state after combining every copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolved {
    Record(String),
    /// Deleted at (ms).
    Deleted(i64),
}

fn written_ms(written: u64) -> i64 {
    i64::try_from(written / 1000).unwrap_or(i64::MAX)
}

/// The record's stamp, unless it names another annotation (its own `id` is
/// a string different from `id`), which is ignored.
fn record_candidate<'a>(id: &str, raw: &'a str, written: u64) -> Option<Candidate<'a>> {
    let (own_id, stamp) = record_meta(raw)?;
    if own_id.is_some_and(|own| own != id) {
        return None;
    }
    Some(Candidate {
        stamp: stamp.unwrap_or_else(|| written_ms(written)),
        written,
        state: State::Record(raw),
    })
}

/// The stamp a record written now would be compared with.
pub(crate) fn record_stamp_of(raw: &str) -> i64 {
    record_meta(raw).and_then(|(_, s)| s).unwrap_or(i64::MIN)
}

/// Combines the copies of one book per annotation: the newest change wins.
pub(crate) fn resolve(copies: &[Copy]) -> BTreeMap<String, Resolved> {
    let mut best: BTreeMap<&str, Candidate<'_>> = BTreeMap::new();
    for copy in copies {
        match copy {
            Copy::Group { written, group, .. } => {
                for (id, raw) in &group.annotations {
                    if let Some(c) = record_candidate(id, raw.get(), *written) {
                        consider(&mut best, id, c);
                    }
                }
                for (id, at) in &group.deleted {
                    consider(
                        &mut best,
                        id,
                        Candidate {
                            stamp: *at,
                            written: *written,
                            state: State::Deleted,
                        },
                    );
                }
            }
            Copy::Single { id, written, value } => {
                let candidate = match value {
                    Some(raw) => record_candidate(id, raw, *written),
                    None => Some(Candidate {
                        stamp: written_ms(*written),
                        written: *written,
                        state: State::Deleted,
                    }),
                };
                if let Some(c) = candidate {
                    consider(&mut best, id, c);
                }
            }
        }
    }
    best.into_iter()
        .map(|(id, c)| {
            let resolved = match c.state {
                State::Record(raw) => Resolved::Record(raw.to_string()),
                State::Deleted => Resolved::Deleted(c.stamp),
            };
            (id.to_string(), resolved)
        })
        .collect()
}

fn consider<'a>(best: &mut BTreeMap<&'a str, Candidate<'a>>, id: &'a str, c: Candidate<'a>) {
    match best.get(id) {
        Some(current) if current.order() >= c.order() => {}
        _ => {
            best.insert(id, c);
        }
    }
}

/// Adds `resolved` to a read's entries and deletions, for the annotations in
/// `ids` (all of them with `None`).
pub(crate) fn deliver(
    book: &str,
    resolved: &BTreeMap<String, Resolved>,
    ids: Option<&HashSet<String>>,
    entries: &mut Vec<(String, String)>,
    deleted: &mut Vec<DeletedDocKey>,
) {
    for (id, state) in resolved {
        if ids.is_some_and(|ids| !ids.contains(id)) {
            continue;
        }
        let key = single_key(book, id);
        match state {
            Resolved::Record(raw) => entries.push((key, raw.clone())),
            Resolved::Deleted(at) => deleted.push(DeletedDocKey {
                key,
                at: u64::try_from(*at).unwrap_or(0),
            }),
        }
    }
}

/// A copy from an entry, given its content (`None` for an empty entry).
/// `None` when the entry says nothing about annotations (an empty group, a
/// group that cannot be read, an `anno:` key naming no annotation).
pub(crate) fn copy_from_entry(
    key: &str,
    written: u64,
    hash: iroh_blobs::Hash,
    content: Option<&str>,
) -> Option<Copy> {
    if parse_group_key(key).is_some() {
        let group = Group::parse(content?);
        if group.is_none() {
            log::warn!("[iroh-sync] Ignored sync entry {key}: not an annotation group");
        }
        return Some(Copy::Group {
            written,
            hash,
            group: group?,
        });
    }
    let (_, id) = parse_single_key(key)?;
    Some(Copy::Single {
        id: id.to_string(),
        written,
        value: content.map(str::to_string),
    })
}

/// Serializes changes to this device's own groups (read, change, write):
/// provisioning, live edits, purges and retiring can otherwise overwrite
/// each other's change to the same group.
static OWN_GROUPS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Every copy of `book`'s annotations in `doc`, deletions included, and the
/// content hashes of copies whose content is not here (left out).
pub(crate) async fn copies_in_doc(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    book: &str,
) -> (Vec<Copy>, Vec<iroh_blobs::Hash>) {
    use futures::StreamExt;
    let mut headers = Vec::new();
    let queries = [
        iroh_docs::store::Query::all()
            .key_exact(group_key(book))
            .include_empty()
            .build(),
        // The trailing `:` keeps `anno:b1:` from matching book b10.
        iroh_docs::store::Query::all()
            .key_prefix(format!("{SINGLE_PREFIX}{book}:"))
            .include_empty()
            .build(),
    ];
    for query in queries {
        if let Ok(stream) = doc.get_many(query).await {
            futures::pin_mut!(stream);
            while let Some(Ok(entry)) = stream.next().await {
                headers.push((
                    String::from_utf8_lossy(entry.key()).to_string(),
                    entry.timestamp(),
                    entry.content_hash(),
                ));
            }
        }
    }
    let mut copies = Vec::new();
    let mut missing = Vec::new();
    for (key, written, hash) in headers {
        let content = if hash == iroh_blobs::Hash::EMPTY {
            None
        } else {
            match content_of(blobs, hash).await {
                Some(c) => Some(c),
                None => {
                    missing.push(hash);
                    continue;
                }
            }
        };
        if let Some(copy) = copy_from_entry(&key, written, hash, content.as_deref()) {
            copies.push(copy);
        }
    }
    (copies, missing)
}

/// This device's group for `book` in `doc` (empty when it has none) and
/// when it was written.
async fn own_group(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    book: &str,
) -> (Group, Option<(iroh_blobs::Hash, u64)>) {
    let key = group_key(book);
    let Ok(Some(entry)) = doc.get_exact(author, key.as_bytes(), false).await else {
        return (Group::default(), None);
    };
    let found = Some((entry.content_hash(), entry.timestamp()));
    match content_of(blobs, entry.content_hash()).await {
        Some(raw) => match Group::parse(&raw) {
            Some(group) => (group, found),
            None => {
                log::warn!("[iroh-sync] This device's {key} could not be read; starting it again");
                (Group::default(), found)
            }
        },
        None => {
            log::warn!(
                "[iroh-sync] The content of this device's {key} is missing; starting it again"
            );
            (Group::default(), found)
        }
    }
}

/// Writes `group` as this device's group for `book`, unless that is what is
/// there already. Whether it was written.
async fn save_group(
    doc: &iroh_docs::api::Doc,
    author: iroh_docs::AuthorId,
    book: &str,
    group: &Group,
    existing: Option<(iroh_blobs::Hash, u64)>,
) -> Result<bool, String> {
    let json = group.to_json();
    if existing.is_some_and(|(hash, _)| hash == iroh_blobs::Hash::new(json.as_bytes())) {
        return Ok(false);
    }
    let key = group_key(book);
    doc.set_bytes(author, key.clone().into_bytes(), json.into_bytes())
        .await
        .map(|_| true)
        .map_err(|e| format!("set_bytes {key}: {e}"))
}

/// Writes annotation entries (`anno:{book}:{id}` → record) as this device
/// into `doc`, shared with a device on `protocol`: into this device's group
/// of each book, and, for a device on an older version, as single entries
/// too. Nothing unchanged is written again. With `respect_deletions`, an
/// annotation whose newest change in this doc is a deletion at least as new
/// as the record is not written but returned, as provisioning does for
/// every item. Returns how many entries were written (in any form), those
/// held back, and the first failure.
pub(crate) async fn write_annotations(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    protocol: u8,
    entries: &[(&str, &str)],
    respect_deletions: bool,
) -> (usize, Vec<DeletedDocKey>, Option<String>) {
    let mut by_book: BTreeMap<&str, Vec<(&str, &str, &str)>> = BTreeMap::new();
    for (key, value) in entries {
        if let Some((book, id)) = parse_single_key(key) {
            by_book.entry(book).or_default().push((id, key, value));
        }
    }
    let singles = reads_single_annotations(protocol);
    let mut written = 0usize;
    let mut held = Vec::new();
    let mut error = None;
    let _own = OWN_GROUPS.lock().await;
    for (book, items) in by_book {
        let (mut group, existing) = own_group(doc, blobs, author, book).await;
        let mut changed = false;
        let mut resolved: Option<BTreeMap<String, Resolved>> = None;
        for (id, key, value) in items {
            let in_group = group.annotations.get(id).is_some_and(|r| r.get() == value)
                && !group.deleted.contains_key(id);
            let single_hash = iroh_blobs::Hash::new(value.as_bytes());
            let single_unchanged = !singles
                || matches!(
                    doc.get_exact(author, key.as_bytes(), false).await,
                    Ok(Some(own)) if own.content_hash() == single_hash
                );
            if in_group && single_unchanged {
                continue;
            }
            if respect_deletions {
                if resolved.is_none() {
                    let (copies, _) = copies_in_doc(doc, blobs, book).await;
                    resolved = Some(resolve(&copies));
                }
                if let Some(Resolved::Deleted(at)) = resolved.as_ref().and_then(|r| r.get(id)) {
                    if *at >= record_stamp_of(value) {
                        // Deleted after this change was made: the app decides.
                        held.push(DeletedDocKey {
                            key: key.to_string(),
                            at: u64::try_from(*at).unwrap_or(0),
                        });
                        continue;
                    }
                }
            }
            let mut wrote = false;
            if !in_group {
                match group.put_record(id, value) {
                    Ok(c) => {
                        changed |= c;
                        wrote = c;
                    }
                    Err(e) => {
                        error.get_or_insert(e);
                        continue;
                    }
                }
            }
            if !single_unchanged {
                match doc
                    .set_bytes(author, key.as_bytes().to_vec(), value.as_bytes().to_vec())
                    .await
                {
                    Ok(_) => wrote = true,
                    Err(e) => {
                        error.get_or_insert(format!("set_bytes {key}: {e}"));
                    }
                }
            }
            if wrote {
                written += 1;
            }
        }
        if changed {
            if let Err(e) = save_group(doc, author, book, &group, existing).await {
                error.get_or_insert(e);
            }
        }
    }
    (written, held, error)
}

/// Turns this device's records of deleted annotations into deletion markers
/// (`now`, ms): every annotation of a book in `books`, and those in
/// `annotation_ids`. `own_keys` are this device's keys in `doc`. Returns how
/// many records became markers.
pub(crate) async fn purge_groups(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
    own_keys: &[String],
    books: &HashSet<&str>,
    annotation_ids: &HashSet<&str>,
    now: i64,
) -> usize {
    let targets: Vec<&str> = own_keys
        .iter()
        .filter_map(|k| parse_group_key(k))
        .filter(|book| books.contains(book) || !annotation_ids.is_empty())
        .collect();
    if targets.is_empty() {
        return 0;
    }
    let mut converted = 0usize;
    let _own = OWN_GROUPS.lock().await;
    for book in targets {
        let (mut group, existing) = own_group(doc, blobs, author, book).await;
        let whole_book = books.contains(book);
        let gone: Vec<String> = group
            .annotations
            .keys()
            .filter(|id| whole_book || annotation_ids.contains(id.as_str()))
            .cloned()
            .collect();
        if gone.is_empty() {
            continue;
        }
        for id in &gone {
            group.put_deleted(id, now);
        }
        match save_group(doc, author, book, &group, existing).await {
            Ok(_) => converted += gone.len(),
            Err(e) => log::warn!("[iroh-sync] could not mark deletions in {book}: {e}"),
        }
    }
    converted
}

/// Copies this device's deletions of single annotation entries in `doc`
/// (empty entries, written before protocol 3) into its groups as deletion
/// markers of the same moment, unless the group holds a newer change. What
/// a read decides does not change (it already counts those deletions); the
/// deletion now also lives where it cannot be put back over (see the module
/// comment), whatever happens to the empty entry. Returns how many markers
/// were added.
pub(crate) async fn fold_single_deletions(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    author: iroh_docs::AuthorId,
) -> Result<usize, String> {
    use futures::StreamExt;
    let mut by_book: BTreeMap<String, Vec<Copy>> = BTreeMap::new();
    let stream = doc
        .get_many(
            iroh_docs::store::Query::author(author)
                .key_prefix(SINGLE_PREFIX.as_bytes())
                .include_empty()
                .build(),
        )
        .await
        .map_err(|e| format!("list annotation entries: {e}"))?;
    futures::pin_mut!(stream);
    while let Some(entry) = stream.next().await {
        let entry = entry.map_err(|e| format!("list annotation entries: {e}"))?;
        if entry.content_hash() != iroh_blobs::Hash::EMPTY {
            continue;
        }
        let key = String::from_utf8_lossy(entry.key()).to_string();
        if let Some((book, _)) = parse_single_key(&key) {
            let book = book.to_string();
            if let Some(copy) =
                copy_from_entry(&key, entry.timestamp(), iroh_blobs::Hash::EMPTY, None)
            {
                by_book.entry(book).or_default().push(copy);
            }
        }
    }
    if by_book.is_empty() {
        return Ok(0);
    }
    let _own = OWN_GROUPS.lock().await;
    let mut added = 0usize;
    for (book, deletions) in by_book {
        let (mut group, existing) = own_group(doc, blobs, author, &book).await;
        let ids: Vec<String> = deletions
            .iter()
            .filter_map(|c| match c {
                Copy::Single { id, .. } => Some(id.clone()),
                Copy::Group { .. } => None,
            })
            .collect();
        let (hash, written) = existing.unwrap_or((iroh_blobs::Hash::EMPTY, 0));
        let mut copies = deletions;
        copies.push(Copy::Group {
            written,
            hash,
            group: group.clone(),
        });
        let resolved = resolve(&copies);
        let mut changed = false;
        for id in ids {
            if let Some(Resolved::Deleted(at)) = resolved.get(&id) {
                if group.put_deleted(&id, *at) {
                    changed = true;
                    added += 1;
                }
            }
        }
        if changed {
            save_group(doc, author, &book, &group, existing).await?;
        }
    }
    Ok(added)
}

/// A remote entry for an annotation key, as the live updates deliver it:
/// the combined state, in this doc, of the annotations it mentions (all of
/// the book's for a deleted group). Nothing while a copy's content is still
/// missing: the round's read delivers it then.
pub(crate) async fn live_annotations(
    doc: &iroh_docs::api::Doc,
    blobs: &iroh_blobs::api::Store,
    key: &str,
    value: Option<&str>,
) -> (Vec<(String, String)>, Vec<DeletedDocKey>) {
    let mut entries = Vec::new();
    let mut deleted = Vec::new();
    let Some(book) = book_of(key) else {
        return (entries, deleted);
    };
    let ids: Option<HashSet<String>> = match (parse_single_key(key), value) {
        (Some((_, id)), _) => Some(HashSet::from([id.to_string()])),
        (None, Some(raw)) => match Group::parse(raw) {
            Some(group) => Some(group.ids().cloned().collect()),
            None => return (entries, deleted),
        },
        (None, None) => None,
    };
    let (copies, missing) = copies_in_doc(doc, blobs, book).await;
    if !missing.is_empty() {
        return (entries, deleted);
    }
    deliver(
        book,
        &resolve(&copies),
        ids.as_ref(),
        &mut entries,
        &mut deleted,
    );
    (entries, deleted)
}

/// What a read delivers for one book whose copies changed.
#[derive(Debug, Default)]
pub(crate) struct BookChange {
    /// Every annotation (a first or full read, a copy that went away).
    pub all: bool,
    /// Annotations named by single entries that changed.
    pub ids: HashSet<String>,
    /// Group copies that are new since the last read.
    pub new_copies: HashSet<iroh_blobs::Hash>,
}

/// Books whose annotation copies changed since `applied` (every book with
/// `None`), and what to deliver of each. `current` is every key's copies.
pub(crate) fn changed_books(
    current: &HashMap<String, Vec<iroh_blobs::Hash>>,
    applied: Option<&HashMap<String, Vec<iroh_blobs::Hash>>>,
) -> HashMap<String, BookChange> {
    let mut books: HashMap<String, BookChange> = HashMap::new();
    for (key, hashes) in current {
        if !is_annotation_key(key) {
            continue;
        }
        let Some(book) = book_of(key) else {
            continue;
        };
        let previous = applied.and_then(|a| a.get(key));
        if applied.is_some() && previous == Some(hashes) {
            continue;
        }
        let change = books.entry(book.to_string()).or_default();
        if applied.is_none() {
            change.all = true;
            continue;
        }
        let previous: &[iroh_blobs::Hash] = previous.map(Vec::as_slice).unwrap_or(&[]);
        let content =
            |hs: &[iroh_blobs::Hash]| hs.iter().filter(|h| **h != iroh_blobs::Hash::EMPTY).count();
        match parse_single_key(key) {
            Some((_, id)) => {
                change.ids.insert(id.to_string());
            }
            None if content(hashes) < content(previous) => {
                // A group went away (its doc was dropped): what it held is
                // decided by the other copies now.
                change.all = true;
            }
            None => change.new_copies.extend(
                hashes
                    .iter()
                    .filter(|h| !previous.contains(h) && **h != iroh_blobs::Hash::EMPTY),
            ),
        }
    }
    books
}

/// The annotations of a changed book to deliver, given its copies.
pub(crate) fn ids_to_deliver(change: &BookChange, copies: &[Copy]) -> Option<HashSet<String>> {
    if change.all {
        return None;
    }
    let mut ids = change.ids.clone();
    for copy in copies {
        if let Copy::Group { hash, group, .. } = copy {
            if change.new_copies.contains(hash) {
                ids.extend(group.ids().cloned());
            }
        }
    }
    Some(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, updated: i64, note: &str) -> String {
        format!(r#"{{"id":"{id}","bookId":"b","updatedAt":{updated},"note":"{note}"}}"#)
    }

    fn group(records: &[(&str, &str)], deleted: &[(&str, i64)]) -> Group {
        let mut g = Group::default();
        for (id, raw) in records {
            g.put_record(id, raw).unwrap();
        }
        for (id, at) in deleted {
            g.put_deleted(id, *at);
        }
        g
    }

    fn gcopy(written: u64, g: Group) -> Copy {
        let json = g.to_json();
        Copy::Group {
            written,
            hash: iroh_blobs::Hash::new(json.as_bytes()),
            group: g,
        }
    }

    fn single(id: &str, written: u64, value: Option<&str>) -> Copy {
        Copy::Single {
            id: id.into(),
            written,
            value: value.map(str::to_string),
        }
    }

    #[test]
    fn keys_are_parsed_without_crossing_books() {
        assert_eq!(parse_single_key("anno:b1:a1"), Some(("b1", "a1")));
        assert_eq!(parse_single_key("anno:b1:a:b"), Some(("b1", "a:b")));
        assert_eq!(parse_single_key("anno:global:x"), Some(("global", "x")));
        for key in [
            "anno:",
            "anno:b1",
            "anno:b1:",
            "anno::a",
            "annos:b1:",
            "book:1",
        ] {
            assert_eq!(parse_single_key(key), None, "{key}");
        }
        assert_eq!(parse_group_key("annos:b1:"), Some("b1"));
        assert_eq!(group_key("b1"), "annos:b1:");
        for key in ["annos:", "annos::", "annos:b1", "annos:a:b:"] {
            assert_eq!(parse_group_key(key), None, "{key}");
        }
        // No group key extends another (a write would remove the other).
        assert!(!group_key("b12").starts_with(&group_key("b1")));
        assert_eq!(parse_group_key("anno:b1:a"), None);
        assert!(is_annotation_key("anno:"));
        assert!(is_annotation_key("annos:b:"));
        assert!(!is_annotation_key("annotations"));
        assert!(!is_annotation_key("annotation:a1"));
        assert_eq!(book_of("anno:"), None);
        assert_eq!(book_of("anno:b2:x"), Some("b2"));
        assert_eq!(book_of("annos:b2:"), Some("b2"));
        assert!(reads_single_annotations(0));
        assert!(reads_single_annotations(2));
        assert!(!reads_single_annotations(
            theorem_sync_core::sync_protocol::SYNC_PROTOCOL
        ));
    }

    #[test]
    fn a_group_keeps_records_verbatim_and_is_stable() {
        let raw = r#"{"id":"a1", "note" : "spaced",  "updatedAt":5}"#;
        let mut g = Group::default();
        assert!(g.put_record("a1", raw).unwrap());
        assert!(!g.put_record("a1", raw).unwrap());
        assert!(g.put_record("a0", &rec("a0", 1, "x")).unwrap());
        let json = g.to_json();
        let back = Group::parse(&json).unwrap();
        assert_eq!(back.annotations["a1"].get(), raw);
        // Same content, same bytes: an unchanged group is never rewritten.
        assert_eq!(back.to_json(), json);
        assert!(g.put_record("bad", "not json").is_err());
        // A marker replaces the record; a record replaces the marker.
        assert!(g.put_deleted("a1", 9));
        assert!(!g.put_deleted("a1", 9));
        assert!(!g.annotations.contains_key("a1"));
        assert!(g.put_record("a1", raw).unwrap());
        assert!(!g.deleted.contains_key("a1"));
        assert_eq!(Group::parse("[1]").map(|_| ()), None);
        assert!(Group::parse("{}").is_some());
    }

    #[test]
    fn edits_to_different_highlights_on_two_devices_both_survive() {
        let a = group(
            &[
                ("x", &rec("x", 20, "edited on A")),
                ("y", &rec("y", 10, "y")),
            ],
            &[],
        );
        let c = group(
            &[
                ("x", &rec("x", 10, "x")),
                ("y", &rec("y", 30, "edited on C")),
            ],
            &[],
        );
        for copies in [vec![gcopy(100, a), gcopy(50, c)], {
            let a = group(
                &[
                    ("x", &rec("x", 20, "edited on A")),
                    ("y", &rec("y", 10, "y")),
                ],
                &[],
            );
            let c = group(
                &[
                    ("x", &rec("x", 10, "x")),
                    ("y", &rec("y", 30, "edited on C")),
                ],
                &[],
            );
            vec![gcopy(50, c), gcopy(100, a)]
        }] {
            let r = resolve(&copies);
            assert_eq!(r["x"], Resolved::Record(rec("x", 20, "edited on A")));
            assert_eq!(r["y"], Resolved::Record(rec("y", 30, "edited on C")));
        }
    }

    #[test]
    fn a_highlight_missing_from_one_group_is_not_deleted() {
        let a = group(&[("x", &rec("x", 10, "x")), ("y", &rec("y", 10, "y"))], &[]);
        // B's group has only y (it never had x, or wrote before x arrived).
        let b = group(&[("y", &rec("y", 10, "y"))], &[]);
        let r = resolve(&[gcopy(1, a), gcopy(2_000_000, b)]);
        assert_eq!(r.len(), 2);
        assert!(matches!(r["x"], Resolved::Record(_)));
    }

    #[test]
    fn deletion_and_edit_follow_the_newer_change() {
        // Deleted on A at 20, edited on C at 30 (after): the edit wins.
        let a = group(&[], &[("x", 20)]);
        let c = group(&[("x", &rec("x", 30, "kept"))], &[]);
        assert_eq!(
            resolve(&[gcopy(5, a), gcopy(1, c)])["x"],
            Resolved::Record(rec("x", 30, "kept"))
        );
        // Edited on C at 30, deleted on A at 40 (after): the deletion wins,
        // whatever order the copies were written in.
        let a = group(&[], &[("x", 40)]);
        let c = group(&[("x", &rec("x", 30, "edit"))], &[]);
        assert_eq!(
            resolve(&[gcopy(1, a), gcopy(9, c)])["x"],
            Resolved::Deleted(40)
        );
        // The same moment: the deletion.
        let a = group(&[], &[("x", 30)]);
        let c = group(&[("x", &rec("x", 30, "edit"))], &[]);
        assert_eq!(
            resolve(&[gcopy(1, a), gcopy(9, c)])["x"],
            Resolved::Deleted(30)
        );
    }

    #[test]
    fn old_single_entries_and_groups_merge_by_stamps_not_by_kind() {
        // An older device's single entry with a newer edit beats a group.
        let g = group(&[("x", &rec("x", 10, "group"))], &[]);
        let newer = rec("x", 50, "single");
        let r = resolve(&[gcopy(900_000, g), single("x", 1_000, Some(&newer))]);
        assert_eq!(r["x"], Resolved::Record(newer));
        // A single entry emptied (deleted) at 60 ms beats a record of 50 ms...
        let g = group(&[("x", &rec("x", 50, "group"))], &[]);
        let r = resolve(&[gcopy(1, g), single("x", 60_000, None)]);
        assert_eq!(r["x"], Resolved::Deleted(60));
        // ...and loses to a record edited after it.
        let g = group(&[("x", &rec("x", 70, "group"))], &[]);
        let r = resolve(&[gcopy(1, g), single("x", 60_000, None)]);
        assert_eq!(r["x"], Resolved::Record(rec("x", 70, "group")));
        // A marker beats an older single record.
        let g = group(&[], &[("x", 80)]);
        let r = resolve(&[gcopy(1, g), single("x", 999_000, Some(&rec("x", 70, "s")))]);
        assert_eq!(r["x"], Resolved::Deleted(80));
    }

    #[test]
    fn records_without_stamps_fall_back_to_when_they_were_written() {
        let r = resolve(&[
            single("x", 10_000, Some(r#"{"id":"x","n":1}"#)),
            single("x", 30_000, Some(r#"{"id":"x","n":3}"#)),
        ]);
        assert_eq!(r["x"], Resolved::Record(r#"{"id":"x","n":3}"#.into()));
        // Same stamp: the later write.
        let r = resolve(&[
            single("x", 20_000, Some(&rec("x", 5, "later"))),
            single("x", 10_000, Some(&rec("x", 5, "earlier"))),
        ]);
        assert_eq!(r["x"], Resolved::Record(rec("x", 5, "later")));
    }

    #[test]
    fn a_record_filed_under_another_id_is_ignored() {
        let g = group(&[("x", &rec("y", 99, "planted"))], &[]);
        let r = resolve(&[gcopy(1, g), single("x", 1_000, Some(&rec("x", 1, "real")))]);
        assert_eq!(r["x"], Resolved::Record(rec("x", 1, "real")));
        // Unreadable records say nothing.
        let r = resolve(&[single("z", 1, Some("not json"))]);
        assert!(r.is_empty());
    }

    #[test]
    fn deliveries_name_each_annotation_by_its_old_key() {
        let g = group(&[("x", &rec("x", 1, "x"))], &[("y", 7)]);
        let r = resolve(&[gcopy(1, g)]);
        let (mut entries, mut deleted) = (Vec::new(), Vec::new());
        deliver("b1", &r, None, &mut entries, &mut deleted);
        assert_eq!(entries, vec![("anno:b1:x".to_string(), rec("x", 1, "x"))]);
        assert_eq!(
            deleted,
            vec![DeletedDocKey {
                key: "anno:b1:y".into(),
                at: 7
            }]
        );
        let only: HashSet<String> = ["y".to_string()].into();
        let (mut entries, mut deleted) = (Vec::new(), Vec::new());
        deliver("b1", &r, Some(&only), &mut entries, &mut deleted);
        assert!(entries.is_empty());
        assert_eq!(deleted.len(), 1);
    }

    #[test]
    fn a_changed_copy_delivers_only_what_it_holds() {
        let h = |s: &str| iroh_blobs::Hash::new(s.as_bytes());
        let mut applied = HashMap::new();
        applied.insert("annos:b1:".to_string(), vec![h("a"), h("b")]);
        applied.insert("annos:b2:".to_string(), vec![h("c")]);
        applied.insert("anno:b3:x".to_string(), vec![h("d")]);
        applied.insert("annos:b4:".to_string(), vec![h("e"), h("f")]);
        let mut current = applied.clone();
        let mut b1 = vec![h("a"), h("b2")];
        b1.sort();
        current.insert("annos:b1:".into(), b1);
        current.insert("anno:b3:x".into(), vec![iroh_blobs::Hash::EMPTY]);
        current.insert("annos:b4:".into(), vec![h("e")]);
        current.insert("annos:b5:".into(), vec![h("g")]);
        current.insert("anno:".into(), vec![iroh_blobs::Hash::EMPTY]);
        let changed = changed_books(&current, Some(&applied));
        let mut names: Vec<&String> = changed.keys().collect();
        names.sort();
        assert_eq!(names, vec!["b1", "b3", "b4", "b5"]);
        assert!(!changed["b1"].all);
        assert_eq!(changed["b1"].new_copies, HashSet::from([h("b2")]));
        assert_eq!(changed["b3"].ids, HashSet::from(["x".to_string()]));
        assert!(
            !changed["b3"].all,
            "a deleted single entry names its annotation"
        );
        assert!(changed["b4"].all, "a copy went away");
        assert_eq!(changed["b5"].new_copies, HashSet::from([h("g")]));
        // A full read delivers everything.
        assert!(changed_books(&current, None).values().all(|c| c.all));

        let new = group(&[("p", &rec("p", 1, "p"))], &[("q", 3)]);
        let old = group(&[("r", &rec("r", 1, "r"))], &[]);
        let new_copy = gcopy(1, new);
        let new_hash = match &new_copy {
            Copy::Group { hash, .. } => *hash,
            Copy::Single { .. } => unreachable!(),
        };
        let change = BookChange {
            new_copies: HashSet::from([new_hash]),
            ..Default::default()
        };
        let ids = ids_to_deliver(&change, &[new_copy, gcopy(2, old)]).unwrap();
        assert_eq!(ids, HashSet::from(["p".to_string(), "q".to_string()]));
    }
}
