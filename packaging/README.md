# Packaging & distribution

Templates and instructions for getting Theorem into the package managers users
already use. Nothing here ships in the app — it's for maintainers.

> These are **templates** pinned to the latest published release. Update the
> version, URLs, and checksums (or use the tools noted below) before submitting.

## Channels

| Channel | Platform | Status | File / recipe |
|---------|----------|--------|---------------|
| GitHub Releases | all | ✅ live | `.github/workflows/release.yml` |
| Linux install script | Linux | ✅ live | `scripts/install-linux.sh` |
| In-app updater | desktop | ✅ live | `src-tauri/tauri.conf.json` → `plugins.updater` |
| AUR | Arch | 🟡 template | `docs/PKGBUILD` |
| Homebrew cask | macOS | 🟡 template | `packaging/homebrew/theorem.rb` |
| WinGet | Windows | 🟡 template | `packaging/winget/` |
| Flathub | Linux | ⬜ not started | — |
| F-Droid | Android | ⬜ not started | — |

## macOS — Homebrew cask

1. Compute the SHA-256 of both DMGs from the release and update
   `packaging/homebrew/theorem.rb` (`version`, `sha256`, URLs).
2. Submit a PR to [Homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask)
   adding `Casks/t/theorem.rb` (copy from `packaging/homebrew/theorem.rb`).
   Or keep it in your own tap and run `brew install --cask fundaments-work/theorem/theorem`.

After the first cask lands, future versions can be automated with
[`brew bump-cask-pr`](https://docs.brew.sh/Brew-Livecheck) or a release job that
opens the bump PR.

## Windows — WinGet

1. Update `packaging/winget/` for the new version (or use
   [`wingetcreate update Fundaments-Work.Theorem`](https://github.com/microsoft/winget-create)).
2. Submit a PR to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
   with the manifests under
   `manifests/f/Fundaments-Work/Theorem/<version>/`.
3. Users then run: `winget install Fundaments-Work.Theorem`.

`wingetcreate` can validate and submit in one command:

```bash
wingetcreate update Fundaments-Work.Theorem \
  --version <version> \
  --urls https://github.com/Fundaments-Work/Theorem/releases/download/v<version>/Theorem_<version>_x64-setup.exe \
  --submit
```

## Linux — AUR

Use `docs/PKGBUILD` (bump `pkgver`, refresh `sha256sums` with `makepkg -g`,
then `makepkg --printsrcinfo > .SRCINFO`). See `docs/DISTRIBUTION.md`.

## Android — F-Droid

F-Droid builds from source and needs a metadata recipe in
[fdroiddata](https://gitlab.com/fdroid/fdroiddata). Requirements: a reproducible
build, no proprietary dependencies, and an `AntiFeatures`/`Builds` entry. The
release APKs are already signed; F-Droid will re-sign with its own key, so list
`work.fundamentals.theorem` and keep the `applicationId` stable.

Until F-Droid lands, Android users install the APK from GitHub Releases and
update manually.

## Keeping this current

Ideally, a `release.yml` job (or a small scheduled workflow) bumps these files
after a tag is published. That needs write access to the external tap/winget
repos, so it is left as a manual follow-up until those submissions exist.
