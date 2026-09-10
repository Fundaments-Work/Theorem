# Distribution

How Theorem is packaged, distributed, and updated across platforms.

For the maintainer-facing submission templates (Homebrew, WinGet), see
[`packaging/README.md`](../packaging/README.md).

---

## Channel matrix

| Channel | Platform | How users get it | Status |
|---------|----------|------------------|--------|
| [GitHub Releases](https://github.com/fundaments-work/Theorem/releases/latest) | all | direct download | ✅ live |
| In-app updater | desktop | Settings → About → Check for Updates | ✅ live |
| Linux install script | Linux | `curl … \| bash` | ✅ live |
| [AUR](https://wiki.archlinux.org/title/AUR_submission_guidelines) | Arch | `yay -S theorem-bin` | 🟡 template (`docs/PKGBUILD`) |
| Homebrew cask | macOS | `brew install --cask theorem` | 🟡 template (`packaging/homebrew`) |
| WinGet | Windows | `winget install Fundaments-Work.Theorem` | 🟡 template (`packaging/winget`) |
| Flathub | Linux | `flatpak install flathub …` | ⬜ not started |
| F-Droid | Android | F-Droid client auto-updates | ⬜ not started |

---

## GitHub Releases (all platforms)

Every tagged release publishes:

- **Linux**: `.deb`, `.AppImage` (+ `.sig` updater signatures)
- **macOS**: `.dmg` for Apple Silicon (`aarch64`) and Intel (`x64`)
- **Windows**: `.exe` (NSIS installer)
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

Users update via **Settings → About → Check for Updates**. Works on Linux,
macOS, and Windows. Android has no in-app updater — install a new APK (or use
F-Droid once available).

---

## Linux

### One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash
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

Not currently built — `tauri.conf.json` targets `deb`, `appimage`, `nsis`, and
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

---

## macOS

Distributed as a signed `.dmg` (Intel + Apple Silicon) via GitHub Releases.
A Homebrew cask template lives in `packaging/homebrew/theorem.rb`; submit it to
[Homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask) (or host it
in a tap) so users can `brew install --cask theorem`.

---

## Windows

Distributed as an NSIS `.exe` via GitHub Releases. A WinGet manifest set lives
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
