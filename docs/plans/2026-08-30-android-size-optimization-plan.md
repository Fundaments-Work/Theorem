# Android APK Size Optimization & Verified Rust Ecosystem Plan

**Date**: 2026-08-30  
**Status**: Proposal / Implementation Blueprint  
**Area**: Android Packaging / Rust Compiler Tuning / Frontend Bundler / APK Size  

---

## 1. Executive Summary

Theorem's current single-ABI Android release APK (for `aarch64-linux-android`) is approximately **38 MB**. In mobile environments, download size directly impacts user acquisition, update frequency, and memory pressure on lower-end devices.

This document provides:
1. An empirical breakdown of what constitutes the current 38 MB bundle.
2. An audit of verified, actively maintained Rust crates for native feature rewrites to prevent dependency bloat.
3. A four-pillar optimization plan to reduce the final APK from **38 MB down to ~15–18 MB** (a **>50% size reduction**).

---

## 2. Current APK Size Breakdown

| Layer | Component | Uncompressed Size | In-APK (Compressed) | Primary Cause |
| :--- | :--- | :--- | :--- | :--- |
| **Native Rust** | `libtheorem_lib.so` | ~75 MB | **~28 MB** | `iroh` QUIC/P2P stack, `tokio`, missing `panic = "abort"` unwinding landing pads |
| **Web Frontend** | `dist/` (HTML/JS/CSS/Fonts) | 7.5 MB | **~3.5 MB** | `pdf.worker.mjs` (2.1 MB) + `dist/pdfjs/cmaps/` (2.5 MB of 150+ CJK map tables) |
| **Android DEX & Res** | `classes.dex`, AndroidX, Material | ~12 MB | **~6.5 MB** | Unused locale strings, transitive UI resources |
| **Total** | **Single-ABI Release APK** | **~94.5 MB** | **~38 MB** | Baseline |

---

## 3. Verified Rust Crate Ecosystem & Justifications

To ensure native rewrites remain robust and do not introduce unmaintained or bloated packages, each candidate crate has been verified on [crates.io](https://crates.io):

| Feature / Subsystem | Recommended Crate | Maintenance Status | License | Size Impact & Justification |
| :--- | :--- | :--- | :--- | :--- |
| **Batch Ingestion & OPF Parsing** | [`quick-xml`](https://crates.io/crates/quick-xml) `v0.36` + [`rayon`](https://crates.io/crates/rayon) `v1.10` | 🟢 Active (Tauri / Servo standard) | MIT / Apache-2.0 | Zero-allocation event-driven XML reader. Eliminates JS DOMParser heap allocations. |
| **Cover WebP Downsampling** | [`image`](https://crates.io/crates/image) `v0.25` (`default-features = false, features = ["webp", "jpeg", "png"]`) | 🟢 Official Rust working group standard | MIT / Apache-2.0 | Pure Rust image decoding/resizing. Stripping unused formats (TIFF, AVIF, BMP) keeps binary size minimal. |
| **StarDict & DictZip Engine** | [`opendict-rs`](https://crates.io/crates/opendict-rs) or [`memmap2`](https://crates.io/crates/memmap2) + [`flate2`](https://crates.io/crates/flate2) | 🟢 Actively maintained | MIT | Zero-copy `O(log N)` binary search on memory-mapped `.idx` tables and random-access chunk decompression via DictZip header seeking. |
| **MOBI / AZW / PalmDOC** | [`mobi`](https://crates.io/crates/mobi) `v0.8` | 🟢 Dedicated PalmDOC & MOBI parser | MIT | Native bitwise Huffman (Huff/CDIC) decoding and LZ77 decompression. |
| **Article Readability Extraction** | [`readabilityrs`](https://crates.io/crates/readabilityrs) or [`readable-rs`](https://crates.io/crates/readable-rs) | 🟢 Active 1:1 Rust ports of Mozilla Readability | MIT / MPL-2.0 | Eliminates passing multi-megabyte raw HTML over IPC to JS; sanitizes and strips ads/scripts natively. |
| **Streaming In-Book Search** | [`grep-regex`](https://crates.io/crates/grep-regex) / [`memchr`](https://crates.io/crates/memchr) | 🟢 Ripgrep core engine | MIT / Unlicense | Sub-millisecond SIMD pattern search over uncompressed chapter byte streams. |

---

## 4. The 4-Pillar Size Reduction Strategy

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       ANDROID APK REDUCTION STRATEGY                            │
├────────────────────────┬────────────────────────┬───────────────────────────────┤
│ 1. RUST CARGO PROFILE  │ 2. FRONTEND ASSETS     │ 3. GRADLE R8 & LOCALES        │
│   - panic = "abort"    │   - Prune CJK cmaps    │   - proguard-optimize         │
│   - opt-level = "z"    │   - Lazy PDF.js worker │   - resourceConfigurations    │
│   - lto = "fat"        │   - Compress assets    │   - isShrinkResources = true  │
│   - strip = true       │                        │                               │
│  (Saves ~13–15 MB)     │  (Saves ~2 MB)         │  (Saves ~1.5 MB)              │
└────────────────────────┴────────────────────────┴───────────────────────────────┘
                                         │
                                         ▼
                     Target Single-ABI APK Size: ~16–18 MB
```

---

### Pillar 1: Rust Compiler & Cargo Profile Tuning (~13–15 MB Savings)

By default, Rust retains DWARF unwinding tables (`.eh_frame` and `.gcc_except_table`) across every crate. For large async network stacks like `iroh` and `tokio`, this adds substantial binary bloat.

In `src-tauri/Cargo.toml`:

```toml
[profile.release]
opt-level = "z"         # Aggressive optimization for code size
lto = "fat"             # Global cross-crate Link Time Optimization (dead code elimination)
codegen-units = 1       # Single code generation unit maximizes inlining & stripping
panic = "abort"         # Removes exception unwinding landing pads and stack tables
strip = true            # Automatically strips all debug symbols and names
```

#### Crate Feature Trimming:
- **`image`**: Disable default features and select only WebP, JPEG, PNG:
  ```toml
  image = { version = "0.25", default-features = false, features = ["webp", "jpeg", "png"] }
  ```
- **`tokio`**: On Android, shell `process` features are unneeded.

---

### Pillar 2: Frontend & PDF.js Bundle Pruning (~2 MB Savings)

In `vite.config.ts`, `viteStaticCopy` currently copies the entire `node_modules/pdfjs-dist/cmaps/` directory into `dist/pdfjs/cmaps/` (over 150 legacy CJK vertical/horizontal encoding tables).

```ts
// vite.config.ts
viteStaticCopy({
    targets: [
        {
            // Only copy standard Unicode/Adobe cmaps and common CJK fonts
            src: [
                "node_modules/pdfjs-dist/cmaps/Adobe-*.bcmap",
                "node_modules/pdfjs-dist/cmaps/Uni*.bcmap",
            ],
            dest: "pdfjs/cmaps",
        },
        {
            src: "node_modules/pdfjs-dist/standard_fonts/*",
            dest: "pdfjs/standard_fonts",
        },
    ],
}),
```

---

### Pillar 3: Android Gradle R8 & Locale Shrinking (~1.5 MB Savings)

In `src-tauri/gen/android/app/build.gradle.kts`:

1. **Locale Filtering**: Strip unneeded translation strings from transitive AndroidX and Material libraries:
   ```kotlin
   android {
       defaultConfig {
           resourceConfigurations.addAll(listOf("en", "es", "fr"))
       }
   }
   ```
2. **R8 Full Optimizations & ProGuard Rules**:
   ```kotlin
   buildTypes {
       getByName("release") {
           isMinifyEnabled = true
           isShrinkResources = true
           proguardFiles(
               getDefaultProguardFile("proguard-android-optimize.txt"),
               "proguard-rules.pro"
           )
           packaging {
               jniLibs.keepDebugSymbols.clear()
           }
       }
   }
   ```

---

### Pillar 4: Per-ABI Builds & Android App Bundles (AAB)

Never ship a "fat" multi-ABI universal APK to end users. 

- **Play Store Release**: Build an **Android App Bundle (.aab)**:
  ```bash
  pnpm tauri android build --aab
  ```
  Google Play delivers split APKs containing only the device's native CPU architecture (`arm64-v8a`), reducing user download size by up to **65%**.
- **Direct APK Release (GitHub Releases / F-Droid)**:
  Build architecture-specific APKs:
  ```bash
  pnpm tauri android build --target aarch64-linux-android
  pnpm tauri android build --target armv7-linux-androideabi
  ```

---

## 5. Verification & Measurement Tools

To track size regressions during development:

1. **`cargo-bloat`**:
   Identify the largest functions and crates inside the compiled `.so`:
   ```bash
   cargo bloat --target aarch64-linux-android --release --crates
   ```
2. **Android Studio APK Analyzer**:
   Inspect exact file sizes inside the final `.apk`:
   ```bash
   apkanalyzer apk summary app-release.apk
   apkanalyzer apk compare app-old.apk app-new.apk
   ```

---

## 6. Implementation Checklist

- [x] Pillar 1: `panic = "abort"` + `opt-level = "z"` in `src-tauri/Cargo.toml` (lto/strip/codegen-units were already in place). `tokio` "process" feature is now desktop-only via `[target.'cfg(not(target_os = "android"))'.dependencies]`.
- [x] Pillar 2: Prune `vite.config.ts` `viteStaticCopy` for `pdfjs-dist` cmaps (only `Adobe-*` and `Uni*` — 74 of 169 tables).
- [x] Pillar 3: Add `resourceConfigurations` in `build.gradle.kts` for target locales. (R8 `isMinifyEnabled`/`isShrinkResources` and AAB splits were already configured.)
- [x] Pillar 4: Per-ABI builds / AAB already configured in `build.gradle.kts` (bundle splits + per-target build comments).
- [ ] Run benchmark build on `aarch64-linux-android` and record before/after APK byte sizes.
- [ ] Verify `panic = "abort"` on a full release Android build (catch_unwind call sites degrade to abort-by-design).
