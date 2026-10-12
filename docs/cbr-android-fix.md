# Android CBR import and reading

Tauri raw binary responses are ArrayBuffers. Treating the CBR-to-CBZ response as a Uint8Array and reading `.buffer` discarded those bytes. Imports could retain a library entry while saving an empty payload; the reader also constructed an invalid File from the same response assumption.

The shared CBR bridge now preserves ArrayBuffers, supports byte arrays and bounded typed views, and rejects missing or entryless ZIP output. Android path imports and native File-picker imports save the converted archive before creating a CBZ entry. Legacy CBR reader conversion uses the same bridge and reports conversion errors.

Regression tests unzip the returned bytes and verify page contents, import persistence, native File-picker conversion, and rejection of invalid output. The real local RAR4 sample was independently decoded in full with the shipped rars version. Private comics and probe output are not repository fixtures.

Previously failed imports may contain damaged cached data. Remove only the failed library entry and re-import its original CBR; do not delete the source comic.

Device acceptance: import, cover, open, page rendering, navigation, close and reopen. Record the final device result in the issue before pushing.


## Android import memory repair (2026-10-09)

Device ApplicationExitInfo recorded repeated LOW_MEMORY terminations, with WebView memory samples around 1.8–1.9 GB. Native file-picker imports previously read each whole File, hashed it in JavaScript and sent all bytes as a JSON command argument. CBR conversion additionally accumulated every extracted entry before constructing an in-memory ZIP.

Native File imports now upload one-megabyte slices through the filesystem binary API. Rust checks the upload size, hashes the source on disk, converts CBR directly to a temporary CBZ file and registers the completed cache file. Android folder imports copy and finalize files in Rust. Failed uploads and conversions are not published as library entries. Native imports bypass the legacy whole-buffer storage command.

The CBR converter streams entries into ZIP in archive order and propagates extraction/CRC failures instead of falling back to silently omitting failed members. This reduces import memory; reader and background metadata loading still have their own allocations. Physical-device verification is recorded below.

The reported failing CBR is approximately 1 GB. The follow-up repair also extracts comic metadata and cover directly from the disk-backed ZIP before publishing the book, with bounded XML/image inputs and a 64 MB image decode allocation limit. Missing/unsupported covers receive a small fallback without triggering whole-archive background extraction. Native range files are excluded from the full-file worker fallback, and the reader does not re-extract an already processed native comic fallback cover.

The first 128 MB controlled device upload completed its temporary-file cleanup; its debug reporting connection timed out before completion. The real 1 GB CBR served as the acceptance test recorded below.


### Final verification

The real 1,037,810,176-byte CBR completed conversion/finalization in 83.642 seconds after its source upload. Its resulting comic contains 434 pages. On the connected Android device, cover persistence, image decoding, continuous strip geometry, page navigation, reader reopening and a cold application restart passed without a low-memory termination. Native debug builds optimize the RAR decoder, and ZIP output uses a bounded 64 KB buffer. The source upload itself is separate from this conversion timing.

Final checks: 89 frontend test files / 841 tests, production frontend build, Rust fmt/clippy/check, runtime patch consistency, and all 49 CRCs of the smaller real sample passed. Private samples, APKs and device logs are excluded from Git.
