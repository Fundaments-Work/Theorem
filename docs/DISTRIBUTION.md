# Distribution

How Theorem is packaged, distributed, and updated across platforms.

For the maintainer-facing submission templates (Homebrew, WinGet), see
[`packaging/README.md`](../packaging/README.md).

---

## Channel matrix

| Channel | Platform | How users get it | Status |
|---------|----------|------------------|--------|
| [GitHub Releases](https://github.com/fundaments-work/Theorem/releases/latest) | all | direct download | ✅ live |
| In-app updater | desktop | Settings → Help → Check for Updates | ✅ live |
| Linux install script | Linux | `curl … \| bash` | ✅ live |
| [AUR](https://wiki.archlinux.org/title/AUR_submission_guidelines) | Arch | `yay -S theorem-bin` | 🟡 template (`docs/PKGBUILD`) |
| Homebrew cask | macOS | `brew install --cask theorem` | 🟡 template (`packaging/homebrew`) |
| WinGet | Windows | `winget install Fundaments-Work.Theorem` | 🟡 template (`packaging/winget`) |
| Flathub | Linux | `flatpak install flathub …` | 🟡 app ready, not submitted (`packaging/linux`) |
| F-Droid | Android | F-Droid client auto-updates | ⬜ not started |

---

## GitHub Releases (all platforms)

Every tagged release publishes:

- **Linux**: `.deb`, `.AppImage` (+ `.sig` updater signatures)
- **macOS**: `.dmg` for Apple Silicon (`aarch64`) and Intel (`x64`)
- **Windows**: `.exe` (NSIS installer) and `.msi` (WiX installer, for managed/enterprise deployment)
- **Android**: `.apk` per ABI (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`) + `.aab`
- **Updater**: `latest.json` consumed by the in-app updater

The release page body is generated from `CHANGELOG.md` and appended with a
download table by the `Append download & install instructions` step in
`.github/workflows/release.yml`.

Download the latest at
<https://github.com/fundaments-work/Theorem/releases/latest>.

---

## In-App Updater (desktop)

Configured in `src-tauri/tauri.conf.json` → `plugins.updater`:

- Endpoint: `https://github.com/fundaments-work/Theorem/releases/latest/download/latest.json`
- Artifacts are signed at build time (`createUpdaterArtifacts: true`); the
  matching public key is in `tauri.conf.json`.

Users update via **Settings → Help → Check for Updates**. Works on Linux,
macOS, and Windows. Android has no in-app updater — install a new APK (or use
F-Droid once available).

---

## Linux

### One-line installer

```bash
# Latest stable release
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash

# Latest beta / pre-release
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash -s -- --beta

# Or install a specific version
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash -s -- --version 1.5.4
```

The script detects the distro, downloads the latest release, and installs a
`.deb` or the AppImage into `~/.local`. rpm-based distros use the AppImage
because no `.rpm` is currently published.

### APT (Debian / Ubuntu)

Install the `.deb` directly from GitHub Releases:

```bash
curl -LO https://github.com/fundaments-work/Theorem/releases/latest/download/Theorem_<version>_amd64.deb
sudo dpkg -i Theorem_<version>_amd64.deb
```

For an auto-updating apt repository: OpenSUSE Build Service
(<https://build.opensuse.org/>), a GitHub Pages-hosted apt repo, or a paid
host like Cloudsmith/Packagecloud.

### AppImage (universal)

Runs on any distribution without installation:

```bash
chmod +x Theorem_<version>_amd64.AppImage
./Theorem_<version>_amd64.AppImage
```

### RPM (Fedora / RHEL / SUSE)

Not currently built — `tauri.conf.json` targets `deb`, `appimage`, `nsis`, `msi`, `app` and
`dmg` only. To enable, add `"rpm"` to `bundle.targets` and a CI step, then
publish to COPR (<https://copr.fedorainfracloud.org/>). Until then, use the
AppImage.

### AUR (Arch Linux)

No official AUR package yet. [`docs/PKGBUILD`](./PKGBUILD) is a template:

```bash
cd docs
makepkg -si
```

To publish: bump `pkgver`, regenerate hashes with `makepkg -g`, run
`makepkg --printsrcinfo > .SRCINFO`, and push to the AUR.

### Flatpak (Flathub)

Not submitted yet ([#189](https://github.com/Fundaments-Work/Theorem/issues/189)).
What is in this repository is the app's side of it:

- **ID.** The Flatpak ID is `work.fundaments.theorem`, because Flathub requires
  control of the ID's domain and the project's domain is `fundaments.work`. The
  Tauri identifier stays `work.fundamentals.theorem`: it names the data folder,
  the Android package and the sync identity, and must not change.
- **Metadata.** `packaging/linux/` holds the desktop entry and the AppStream
  metainfo, named after the Flatpak ID. Flathub wants them in a tagged stable
  release. At each stable tag add a `<release>` entry and point the screenshot
  URLs at that tag, then run `appstreamcli validate` and `desktop-file-validate`.
- **No manifest here.** Flathub's
  [generative AI policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy)
  bars AI-generated or AI-assisted content in manifests, and AI tools from opening
  the submission or writing its commits, description or replies. The manifest is
  written by hand, outside this repository. AI-assisted application code and
  metadata must be disclosed in the submission.

Inside Flatpak (`src-tauri/src/linux_sandbox.rs`: `/.flatpak-info` exists and
`FLATPAK_ID` is well formed) the app behaves differently in these places:

| Area | Behaviour |
|------|-----------|
| Single instance | D-Bus name `<Flatpak ID>.SingleInstance`. A Flatpak may own names under its own ID only. `tauri-plugin-single-instance` 2.5.5 (`platform_impl/linux.rs`) logs any failure other than `NameTaken` and launches normally, so the default name would allow two instances on one library |
| Tray icon | Image written under `$XDG_RUNTIME_DIR/app/<Flatpak ID>/tray-icon`, which the host sees at the same path |
| Updates | The updater plugin is not registered and Settings → Help points to the software centre |
| `theorem` command | The symlink is refused and Settings hides Terminal CLI; use `flatpak run <Flatpak ID> …` |
| System voice | The runtime has no `spd-say`; the error says so and offers the neural voice |

On every Linux build, the tray is skipped when no appindicator library loads:
`libappindicator-sys` 0.9 panics in that case, which ends a release build.
Without a tray, closing the main window is left to the page's close handler
instead of hiding a window nothing could bring back.

---

## macOS

Distributed as a signed `.dmg` (Intel + Apple Silicon) via GitHub Releases.
A Homebrew cask template lives in `packaging/homebrew/theorem.rb`; submit it to
[Homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask) (or host it
in a tap) so users can `brew install --cask theorem`.

---

## Windows

Distributed as an NSIS `.exe` (recommended; also used by the in-app updater) and a WiX `.msi` via GitHub Releases. Use the `.msi` for Group Policy, Intune or `msiexec /i` deployments. A WinGet manifest set lives
in `packaging/winget/`; submit it to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) so users can
`winget install Fundaments-Work.Theorem`. `wingetcreate` can update and submit
in one command (see `packaging/README.md`).

---

## Android

Install the per-ABI `.apk` from GitHub Releases (most phones: `arm64-v8a`).
There is no Play Store listing; F-Droid is the recommended open-source channel
and would provide automatic updates. F-Droid builds from source and needs a
recipe in [fdroiddata](https://gitlab.com/fdroid/fdroiddata) — not yet started.

---

## Release process

1. Bump the version in the four manifests and update `CHANGELOG.md`
   (see [AGENTS.md](../AGENTS.md#release)).
2. Tag and push:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

3. `.github/workflows/release.yml` builds every target, signs the artifacts,
   creates a draft release, and publishes it once all builds succeed.
