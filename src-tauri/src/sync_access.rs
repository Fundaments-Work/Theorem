//! Who may talk to this device over sync, and what they may ask for.
//!
//! Every sync protocol except pairing is open only to paired devices
//! ([`PeerGate`]). Pairing itself needs the one-time secret from the QR code
//! ([`PairingSessions`]). A book request names a book, never a path, and is
//! answered only from book files ([`is_valid_book_id`], [`servable_book_path`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use iroh::endpoint::{AfterHandshakeOutcome, Connection, EndpointHooks};
use iroh::PublicKey;
use theorem_sync_core::sync_protocol::PairedDevice;

/// The largest pairing message either side accepts. Real ones are under 2 KiB.
pub const MAX_PAIRING_FRAME: usize = 64 * 1024;

/// How long a pairing QR code stays valid.
pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);

/// Wrong secrets tolerated before the QR code stops working.
pub const MAX_PAIRING_ATTEMPTS: u8 = 5;

/// How long the scanning device lets the host it is pairing with connect back
/// before the host is saved as paired.
pub const PENDING_PEER_TTL: Duration = Duration::from_secs(2 * 60);

/// Book formats a peer may download from outside the app's own folder.
const BOOK_EXTENSIONS: &[&str] = &[
    "epub", "mobi", "azw", "azw3", "fb2", "fbz", "zip", "cbz", "cbr", "pdf",
];

/// The devices allowed to connect: the paired ones, plus, for a short while,
/// the host a pairing is in progress with.
#[derive(Debug, Default)]
pub struct PeerAllowlist {
    paired: RwLock<HashSet<PublicKey>>,
    pending: Mutex<HashMap<PublicKey, Instant>>,
}

impl PeerAllowlist {
    pub fn from_devices(devices: &HashMap<String, PairedDevice>) -> Self {
        let list = Self::default();
        list.set_paired(devices);
        list
    }

    /// Replaces the paired set; called whenever the paired devices change.
    pub fn set_paired(&self, devices: &HashMap<String, PairedDevice>) {
        let keys = devices
            .values()
            .filter_map(|d| d.iroh_node_id.parse::<PublicKey>().ok())
            .collect();
        *self.paired.write().unwrap_or_else(|e| e.into_inner()) = keys;
    }

    /// Lets `peer` connect for `ttl` (the host while a pairing completes).
    pub fn allow_pending(&self, peer: PublicKey, ttl: Duration) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        pending.retain(|_, until| *until > now);
        pending.insert(peer, now + ttl);
    }

    /// Ends the short-lived permission given by `allow_pending`.
    pub fn forget_pending(&self, peer: &PublicKey) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer);
    }

    pub fn is_allowed(&self, peer: &PublicKey) -> bool {
        if self
            .paired
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains(peer)
        {
            return true;
        }
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer)
            .is_some_and(|until| *until > Instant::now())
    }
}

/// Endpoint hook: every connection, incoming or outgoing, on every protocol
/// (docs, blobs, gossip, book files) is closed unless the other device is
/// allowed. The pairing protocol is the one exception, and it demands the QR
/// code's secret instead. Outgoing connections are gated too, so an unpaired
/// device stops receiving our data at once, even if a doc still lists it.
#[derive(Debug, Clone)]
pub struct PeerGate {
    allowlist: Arc<PeerAllowlist>,
    open_alpn: &'static [u8],
}

impl PeerGate {
    pub fn new(allowlist: Arc<PeerAllowlist>, pairing_alpn: &'static [u8]) -> Self {
        Self {
            allowlist,
            open_alpn: pairing_alpn,
        }
    }

    pub fn admits(&self, alpn: &[u8], peer: &PublicKey) -> bool {
        alpn == self.open_alpn || self.allowlist.is_allowed(peer)
    }
}

/// QUIC close code sent to a device that is not paired.
pub const NOT_PAIRED: u32 = 403;

impl EndpointHooks for PeerGate {
    async fn after_handshake<'a>(&'a self, conn: &'a Connection) -> AfterHandshakeOutcome {
        if self.admits(conn.alpn(), &conn.remote_id()) {
            AfterHandshakeOutcome::Accept
        } else {
            AfterHandshakeOutcome::Reject {
                error_code: NOT_PAIRED.into(),
                reason: b"not paired".to_vec(),
            }
        }
    }
}

/// The secret in the QR code currently on screen. Pairing needs it, it works
/// once, and it expires after [`PAIRING_TTL`] or [`MAX_PAIRING_ATTEMPTS`]
/// wrong guesses.
#[derive(Debug, Default)]
pub struct PairingSessions {
    current: Mutex<Option<PairingSession>>,
}

#[derive(Debug)]
struct PairingSession {
    secret: [u8; 32],
    expires: Instant,
    failures: u8,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairingCheck {
    Accepted,
    /// No QR code is showing, or it expired or was used.
    NoSession,
    WrongSecret,
}

impl PairingSessions {
    /// Starts a new pairing window and returns its secret, hex-encoded.
    /// Any earlier secret stops working.
    pub fn open(&self) -> String {
        use rand::TryRng;
        let mut secret = [0u8; 32];
        rand::rngs::SysRng
            .try_fill_bytes(&mut secret)
            .expect("OS random number generator failed");
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some(PairingSession {
            secret,
            expires: Instant::now() + PAIRING_TTL,
            failures: 0,
        });
        hex_encode(&secret)
    }

    pub fn close(&self) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Checks `presented` and, if it matches, uses the secret up.
    pub fn redeem(&self, presented: &str) -> PairingCheck {
        self.redeem_at(presented, Instant::now())
    }

    fn redeem_at(&self, presented: &str, now: Instant) -> PairingCheck {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = current.as_mut() else {
            return PairingCheck::NoSession;
        };
        if now >= session.expires {
            *current = None;
            return PairingCheck::NoSession;
        }
        let matches =
            hex_decode_32(presented).is_some_and(|p| constant_time_eq(&p, &session.secret));
        if matches {
            *current = None;
            return PairingCheck::Accepted;
        }
        session.failures += 1;
        if session.failures >= MAX_PAIRING_ATTEMPTS {
            *current = None;
        }
        PairingCheck::WrongSecret
    }
}

/// The six digits both devices show while a pairing waits for approval.
/// They depend on both identities and the QR secret, so a different device,
/// or a pairing through someone in the middle, shows different digits.
pub fn verification_code(host: &PublicKey, joiner: &PublicKey, secret: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"theorem-pair-code-v1");
    hasher.update(host.as_bytes());
    hasher.update(joiner.as_bytes());
    hasher.update(secret.trim().to_ascii_lowercase().as_bytes());
    let digest = hasher.finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{n:06}")
}

/// A random identifier for one pairing request.
pub fn random_id() -> String {
    use rand::TryRng;
    let mut bytes = [0u8; 12];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS random number generator failed");
    hex_encode(&bytes)
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn hex_decode_32(s: &str) -> Option<[u8; 32]> {
    let s = s.trim().as_bytes();
    if s.len() != 64 {
        return None;
    }
    let digit = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut out = [0u8; 32];
    for (i, pair) in s.chunks_exact(2).enumerate() {
        out[i] = (digit(pair[0])? << 4) | digit(pair[1])?;
    }
    Some(out)
}

/// A book ID as the library makes them (UUIDs and content hashes). Rejects
/// anything that could name another file: separators, `..`, absolute paths.
pub fn is_valid_book_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && !id.contains("..")
}

/// The real file to send for `candidate`, or `None` when it must not be sent:
/// it does not exist or is empty, lies in the app's data folder outside
/// `book-cache` (where the database and the sync key live), or lies outside
/// the data folder without a book file's extension.
/// Symbolic links are resolved first, so a link cannot point past these checks.
pub fn servable_book_path(candidate: &Path, data_dir: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(candidate).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    if let Ok(data_dir) = std::fs::canonicalize(data_dir) {
        if real.starts_with(&data_dir) {
            // book-cache holds only books, some stored without an extension.
            return real
                .starts_with(data_dir.join("book-cache"))
                .then_some(real);
        }
    }
    let ext = real.extension()?.to_str()?.to_ascii_lowercase();
    BOOK_EXTENSIONS.contains(&ext.as_str()).then_some(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_ids_cannot_name_other_files() {
        assert!(is_valid_book_id("3f2504e0-4f89-11d3-9a0c-0305e82c3301"));
        assert!(is_valid_book_id("a1b2c3d4e5f6"));
        assert!(is_valid_book_id("book_42"));
        for bad in [
            "",
            "../iroh-key",
            "..",
            "../../etc/passwd",
            "/etc/passwd",
            "C:\\Windows\\win.ini",
            "book-cache/x",
            ".hidden",
            "a..b",
            "id\0.book",
            "id with space",
            "ünïcode",
        ] {
            assert!(!is_valid_book_id(bad), "{bad:?} should be rejected");
        }
        assert!(!is_valid_book_id(&"a".repeat(129)));
        assert!(is_valid_book_id(&"a".repeat(128)));
    }

    #[test]
    fn only_book_files_outside_private_data_are_served() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let cache = data.join("book-cache");
        let library = root.path().join("Books");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::create_dir_all(&library).unwrap();

        let cached = cache.join("abc.book");
        std::fs::write(&cached, b"epub").unwrap();
        let cached_bare = cache.join("3f2504e0-4f89");
        std::fs::write(&cached_bare, b"epub").unwrap();
        let in_library = library.join("Novel.EPUB");
        std::fs::write(&in_library, b"epub").unwrap();
        let db = data.join("theorem.db");
        std::fs::write(&db, b"sqlite").unwrap();
        let key = data.join("iroh-key");
        std::fs::write(&key, [7u8; 32]).unwrap();
        // A book-looking file in the private folder is still private.
        let private_pdf = data.join("export.pdf");
        std::fs::write(&private_pdf, b"pdf").unwrap();
        let empty = library.join("empty.epub");
        std::fs::write(&empty, b"").unwrap();
        let notes = library.join("notes.txt");
        std::fs::write(&notes, b"text").unwrap();

        assert!(servable_book_path(&cached, &data).is_some());
        assert!(servable_book_path(&cached_bare, &data).is_some());
        assert!(servable_book_path(&in_library, &data).is_some());
        assert!(servable_book_path(&db, &data).is_none());
        assert!(servable_book_path(&key, &data).is_none());
        assert!(servable_book_path(&private_pdf, &data).is_none());
        assert!(servable_book_path(&empty, &data).is_none());
        assert!(servable_book_path(&notes, &data).is_none());
        assert!(servable_book_path(&library.join("missing.epub"), &data).is_none());
        assert!(servable_book_path(&cache, &data).is_none());
        // Climbing out of book-cache by `..` lands on the database: refused.
        assert!(servable_book_path(&cache.join("../theorem.db"), &data).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_dressed_as_a_book_is_followed_and_refused() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let cache = data.join("book-cache");
        std::fs::create_dir_all(&cache).unwrap();
        let key = data.join("iroh-key");
        std::fs::write(&key, [7u8; 32]).unwrap();
        let outside = root.path().join("secret.txt");
        std::fs::write(&outside, b"secret").unwrap();

        let to_key = cache.join("x.book");
        std::os::unix::fs::symlink(&key, &to_key).unwrap();
        let to_outside = root.path().join("y.epub");
        std::os::unix::fs::symlink(&outside, &to_outside).unwrap();

        assert!(servable_book_path(&to_key, &data).is_none());
        assert!(servable_book_path(&to_outside, &data).is_none());
    }

    #[test]
    fn a_pairing_secret_works_once() {
        let sessions = PairingSessions::default();
        assert_eq!(sessions.redeem("00"), PairingCheck::NoSession);
        let secret = sessions.open();
        assert_eq!(secret.len(), 64);
        assert_eq!(
            sessions.redeem(&secret.to_uppercase()),
            PairingCheck::Accepted
        );
        assert_eq!(sessions.redeem(&secret), PairingCheck::NoSession);
    }

    #[test]
    fn a_new_qr_code_replaces_the_old_secret() {
        let sessions = PairingSessions::default();
        let old = sessions.open();
        let new = sessions.open();
        assert_ne!(old, new);
        assert_eq!(sessions.redeem(&old), PairingCheck::WrongSecret);
        assert_eq!(sessions.redeem(&new), PairingCheck::Accepted);
    }

    #[test]
    fn wrong_guesses_burn_the_secret() {
        let sessions = PairingSessions::default();
        let secret = sessions.open();
        for guess in ["", "nothex", &"0".repeat(64), &"f".repeat(63)][..]
            .iter()
            .cycle()
            .take(usize::from(MAX_PAIRING_ATTEMPTS))
        {
            assert_eq!(sessions.redeem(guess), PairingCheck::WrongSecret);
        }
        // Even the right secret no longer works.
        assert_eq!(sessions.redeem(&secret), PairingCheck::NoSession);
    }

    #[test]
    fn a_pairing_secret_expires() {
        let sessions = PairingSessions::default();
        let secret = sessions.open();
        let later = Instant::now() + PAIRING_TTL + Duration::from_secs(1);
        assert_eq!(sessions.redeem_at(&secret, later), PairingCheck::NoSession);
        assert_eq!(sessions.redeem(&secret), PairingCheck::NoSession);
    }

    #[test]
    fn closing_the_qr_code_ends_pairing() {
        let sessions = PairingSessions::default();
        let secret = sessions.open();
        sessions.close();
        assert_eq!(sessions.redeem(&secret), PairingCheck::NoSession);
    }

    fn key(seed: u8) -> PublicKey {
        iroh::SecretKey::from_bytes(&[seed; 32]).public()
    }

    fn device(id: &str, node: &PublicKey) -> PairedDevice {
        PairedDevice {
            device_id: id.into(),
            device_name: id.into(),
            iroh_node_id: node.to_string(),
            last_ip: String::new(),
            last_port: 0,
            paired_at: String::new(),
            last_sync_at: None,
            fingerprint: String::new(),
            peer_relay_url: String::new(),
            sync_doc_id: String::new(),
            sync_doc_ticket: String::new(),
            protocol: 0,
        }
    }

    #[test]
    fn only_paired_devices_are_allowed() {
        let (a, b, stranger) = (key(1), key(2), key(3));
        let mut devices = HashMap::new();
        devices.insert("a".to_string(), device("a", &a));
        devices.insert("b".to_string(), device("b", &b));
        devices.insert("broken".to_string(), {
            let mut d = device("broken", &a);
            d.iroh_node_id = "not a key".into();
            d
        });
        let list = PeerAllowlist::from_devices(&devices);
        assert!(list.is_allowed(&a));
        assert!(list.is_allowed(&b));
        assert!(!list.is_allowed(&stranger));

        // Unpairing revokes at once.
        devices.remove("b");
        list.set_paired(&devices);
        assert!(!list.is_allowed(&b));
    }

    #[test]
    fn both_devices_derive_the_same_code_and_others_do_not() {
        let (host, joiner, intruder) = (key(1), key(2), key(3));
        let code = verification_code(&host, &joiner, "AB12");
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(code, verification_code(&host, &joiner, " ab12 "));
        assert_ne!(code, verification_code(&host, &intruder, "ab12"));
        assert_ne!(code, verification_code(&joiner, &host, "ab12"));
        assert_ne!(code, verification_code(&host, &joiner, "ab13"));
        assert_ne!(random_id(), random_id());
    }

    #[test]
    fn the_gate_opens_only_pairing_to_strangers() {
        let (friend, stranger) = (key(1), key(2));
        let mut devices = HashMap::new();
        devices.insert("f".to_string(), device("f", &friend));
        let gate = PeerGate::new(Arc::new(PeerAllowlist::from_devices(&devices)), b"pair/1");
        assert!(gate.admits(b"pair/1", &stranger));
        assert!(!gate.admits(b"/iroh-sync/1", &stranger));
        assert!(!gate.admits(b"theorem-file/v1", &stranger));
        assert!(!gate.admits(b"pair/10", &stranger));
        assert!(gate.admits(b"/iroh-sync/1", &friend));
        assert!(gate.admits(b"theorem-file/v1", &friend));
    }

    #[test]
    fn unpairing_also_ends_a_pending_permission() {
        let host = key(9);
        let list = PeerAllowlist::default();
        let mut devices = HashMap::new();
        devices.insert("h".to_string(), device("h", &host));
        list.allow_pending(host, Duration::from_secs(120));
        list.set_paired(&devices);
        devices.clear();
        list.set_paired(&devices);
        // Still within the pending window: allowed until it is forgotten.
        assert!(list.is_allowed(&host));
        list.forget_pending(&host);
        assert!(!list.is_allowed(&host));
    }

    #[test]
    fn a_pending_host_is_allowed_only_briefly() {
        let host = key(9);
        let list = PeerAllowlist::default();
        list.allow_pending(host, Duration::from_secs(60));
        assert!(list.is_allowed(&host));
        list.allow_pending(host, Duration::ZERO);
        assert!(!list.is_allowed(&host));
    }

    /// Real endpoints over loopback: the gate holds on the wire, for incoming
    /// and outgoing connections, and opening it takes effect at once.
    mod over_the_wire {
        use super::*;
        use iroh::endpoint::presets;
        use iroh::protocol::{AcceptError, ProtocolHandler, Router};
        use iroh::Endpoint;

        const BOOKS: &[u8] = b"test-books/1";
        const PAIR: &[u8] = b"test-pair/1";

        #[derive(Debug, Clone)]
        struct Echo;

        impl ProtocolHandler for Echo {
            async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
                let (mut send, mut recv) = conn.accept_bi().await?;
                tokio::io::copy(&mut recv, &mut send).await?;
                send.finish()?;
                conn.closed().await;
                Ok(())
            }
        }

        async fn gated(allowlist: Arc<PeerAllowlist>) -> Router {
            let ep = Endpoint::builder(presets::Minimal)
                .hooks(PeerGate::new(allowlist, PAIR))
                .bind()
                .await
                .unwrap();
            Router::builder(ep)
                .accept(BOOKS, Echo)
                .accept(PAIR, Echo)
                .spawn()
        }

        async fn echo(from: &Endpoint, to: &Router, alpn: &[u8]) -> Result<Vec<u8>, String> {
            let conn = from
                .connect(to.endpoint().addr(), alpn)
                .await
                .map_err(|e| e.to_string())?;
            let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
            send.write_all(b"hello").await.map_err(|e| e.to_string())?;
            send.finish().map_err(|e| e.to_string())?;
            let out = recv.read_to_end(64).await.map_err(|e| e.to_string());
            conn.close(0u32.into(), b"done");
            out
        }

        #[tokio::test]
        async fn strangers_reach_only_pairing_until_paired() {
            let allowlist = Arc::new(PeerAllowlist::default());
            let host = gated(allowlist.clone()).await;
            let stranger = Endpoint::bind(presets::Minimal).await.unwrap();

            assert!(echo(&stranger, &host, BOOKS).await.is_err());
            assert_eq!(echo(&stranger, &host, PAIR).await.unwrap(), b"hello");

            allowlist.allow_pending(stranger.id(), Duration::from_secs(60));
            assert_eq!(echo(&stranger, &host, BOOKS).await.unwrap(), b"hello");

            // Revoked: refused again.
            allowlist.allow_pending(stranger.id(), Duration::ZERO);
            assert!(echo(&stranger, &host, BOOKS).await.is_err());

            host.shutdown().await.unwrap();
            stranger.close().await;
        }

        #[tokio::test]
        async fn a_refusal_reaches_the_other_side_as_close_code_403() {
            // file_transfer::probe_peer tells "unpaired" from "offline" by it.
            let host = gated(Arc::new(PeerAllowlist::default())).await;
            let stranger = Endpoint::bind(presets::Minimal).await.unwrap();
            let conn = stranger
                .connect(host.endpoint().addr(), BOOKS)
                .await
                .unwrap();
            let read = async {
                let (mut send, recv) = conn.open_bi().await.ok()?;
                send.write_all(b"x\n").await.ok()?;
                let mut recv = recv;
                recv.read_to_end(64).await.ok()
            };
            assert!(read.await.is_none());
            match conn.close_reason() {
                Some(iroh::endpoint::ConnectionError::ApplicationClosed(close)) => {
                    assert_eq!(close.error_code, NOT_PAIRED.into());
                }
                other => panic!("unexpected close reason: {other:?}"),
            }
            host.shutdown().await.unwrap();
            stranger.close().await;
        }

        #[tokio::test]
        async fn a_gated_device_does_not_send_to_strangers_either() {
            let allowlist = Arc::new(PeerAllowlist::default());
            let ours = Endpoint::builder(presets::Minimal)
                .hooks(PeerGate::new(allowlist.clone(), PAIR))
                .bind()
                .await
                .unwrap();
            let theirs_ep = Endpoint::bind(presets::Minimal).await.unwrap();
            let theirs = Router::builder(theirs_ep).accept(BOOKS, Echo).spawn();

            assert!(echo(&ours, &theirs, BOOKS).await.is_err());
            allowlist.allow_pending(theirs.endpoint().id(), Duration::from_secs(60));
            assert_eq!(echo(&ours, &theirs, BOOKS).await.unwrap(), b"hello");

            theirs.shutdown().await.unwrap();
            ours.close().await;
        }
    }
}
