# Theorem Neural Voice — Companion App Slim-Down & Branding Plan

**Date**: 2026-09-05 · **Status**: Proposed · **Repo**: `sapienskid/supertonic-android`
(GPL-3.0 fork of `DevGitPit/supertonic-android`; rebrand + model-mirror changes
already published as release `v3.2.7-theorem.1`)

---

## 1. Goal

The companion app today is a *full* TTS application (ebook reader, queues,
history, audio export, lexicon…). Theorem only needs an **engine**: install →
download models → narrate through Android's TTS API, with Theorem's identity.
This plan strips everything else and applies Theorem's icon/branding — **UI
layout and design stay as-is** (no redesign), per scope decision.

## 2. Feature inventory → keep / remove

| Component | Lines | Decision | Why |
| :--- | :--- | :--- | :--- |
| `SupertonicTextToSpeechService` (the engine) | — | **Keep** | This is the entire point of the app |
| `AssetManager.kt` (model downloads, mirror URLs) | 307 | **Keep** | Model bundle management |
| `TextNormalizer.kt` / `NumberUtils.kt` / `CurrencyNormalizer.kt` | 1175 | **Keep** | Engine-quality text normalization used by the service |
| `MainActivity` (model download/status UI) | — | **Keep, simplify** | Trim to: status, download v3, voice/speed defaults, About |
| `EbookLibraryActivity` / `EbookOutlineActivity` / `EbookParser.kt` / `EbookManager.kt` | ~1000 | **Remove** | Theorem does the reading |
| `QueueActivity` / `QueueManager.kt` | ~137+ | **Remove** | Queue building is a standalone-app feature |
| `PlaybackActivity` + `PlaybackService` | — | **Remove** | In-app playback of saved/exported audio |
| `SavedAudioActivity` | — | **Remove** | Audio export is a standalone-app feature |
| `HistoryActivity` | — | **Remove** | No history without the above |
| `LexiconActivity` / `LexiconManager.kt` | ~159+ | **Remove** | Pronunciation overrides are a power-user feature; revisit later if asked |
| `CheckDataActivity` | — | **Fold into MainActivity** | Redundant once MainActivity is the single screen |

**Estimated removal: ~60–70% of the Kotlin surface.** APK shrinks
correspondingly; the Rust ONNX libs dominate the remaining size (see §5).

## 3. Removal risks & sequencing

1. **Service dependencies first**: grep the service for references to
   queue/lexicon/history managers before deleting — normalize-only paths
   (`TextNormalizer`, `NumberUtils`, `CurrencyNormalizer`) must stay wired.
2. **One activity at a time**, compile after each removal, so reference
   fallout is caught incrementally (Gradle deletes are cheap to revert).
3. **AndroidManifest** cleanup: drop removed activities, keep the TTS
   service intent-filter (`android.intent.action.TTS_SERVICE`) and
   `android.permission.BIND_TEXT_SERVICE` untouched.
4. Jetpack navigation/menu wiring: remove nav entries pointing at deleted
   activities (likely in `MainActivity`'s menu/nav drawer).

## 4. Branding (icons + identity only — no UI redesign)

- [ ] **Launcher icon**: adaptive icon generated from Theorem's `theorem.svg`
  (foreground glyph + Theorem-colored background, all `mipmap-*dpi` +
  adaptive XML). Tools: `resvg`/ImageMagick locally — no Android Studio
  needed. Keep the upstream icon out of git history going forward.
- [ ] **In-app header icon + About text**: name "Theorem Neural Voice",
  version, one line of GPL-3.0 attribution ("based on Supertonic TTS by
  DevGitPit; Supertonic 3 models by Supertone, OpenRAIL-M") — required
  hygiene for a GPL fork.
- [ ] **Accent color**: recolor the existing theme's primary/accent tokens
  to Theorem's accent only — no layout changes.
- [ ] **fastlane metadata** (title/description already rebranded): add the
  Theorem icon to `fastlane/metadata/android/en-US/images/icon.png`.

## 5. Build & release

- [ ] **Trim ABIs to `arm64-v8a` only** for the companion APK (upstream
  F-Droid build ships arm64-only; cuts the ~110MB debug APK roughly 4×).
  Keep `universal` as a manual job if ever needed.
- [ ] Bump `versionCode`/`versionName` (e.g. `25` / `3.2.7-theorem.2`).
- [ ] Still **debug-signed** until the release-keystore decision (roadmap
  plan A item 3); publish the APK as a new GitHub release on the fork.
- [ ] Rebuild after the removals requires `cargo vendor` in `rust/`
  (gitignored) — documented in the previous commit message; note it in the
  README build section.

## 6. Verification checklist

- [ ] `./gradlew assembleDebug` clean after each removal step.
- [ ] Engine still lists in Android's TTS settings and Theorem's engine
      picker; narration works after a fresh model download.
- [ ] Word boundaries (`onRangeStart`) and `synthesizeToFile` unaffected.
- [ ] App cold-start lands on the simplified MainActivity with no
      dead navigation entries.

## 7. Out of scope (explicitly)

- UI/UX redesign of the app's screens.
- Play Store / F-Droid *publication* (blocked on release-signing decision —
  roadmap plan A item 3).
- Audiobook generation inside the companion app (Theorem drives that via
  `synthesizeToFile`).
