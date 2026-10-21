# Install Theorem

Download Theorem for Linux, macOS, Windows or Android from the GitHub releases page, use the one-line Linux installer, and update the app from Settings.

Every build is listed on the [releases page](https://github.com/fundaments-work/theorem/releases). Pick the file for your system from the table below.

| System | File to download |
| :--- | :--- |
| Windows (64-bit) | `Theorem_<version>_x64-setup.exe` |
| macOS, Apple Silicon | `Theorem_<version>_aarch64.dmg` |
| macOS, Intel | `Theorem_<version>_x64.dmg` |
| Linux, Debian and Ubuntu | `Theorem_<version>_amd64.deb` |
| Linux, any distribution | `Theorem_<version>_amd64.AppImage` |
| Android, most phones (64-bit) | `app-arm64-release.apk` |
| Android, older 32-bit phones | `app-arm-release.apk` |

The release page also lists x86 and x86_64 Android builds. Those are meant for emulators.

## Install on Windows

1. Download the `.exe` setup file from the release page. The v1.5.9 release has no `.msi` package.
2. Run it and follow the installer.
3. Start Theorem from the Start menu.

## Install on macOS

1. Download the `.dmg` that matches your Mac. Choose `aarch64` for Apple Silicon (M1 and later) or `x64` for Intel.
2. Open the `.dmg` and drag Theorem to the Applications folder.
3. Start Theorem from Applications.

Release builds are not always signed with an Apple developer certificate. The release workflow falls back to ad-hoc signing when signing credentials are not configured, so macOS may warn about an unidentified developer the first time you open the app. If that happens, open System Settings, go to Privacy and Security, and allow the app to open.

## Install on Linux

### With the install script

Run this command in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash
```

The script downloads the latest stable release and installs it (see [Stable and beta releases](#stable-and-beta-releases): right now that is not the newest version). It uses the `.deb` package when `apt` or `dpkg` is available, and asks for root access through `sudo`. On other distributions it installs the AppImage under `~/.local/lib/theorem` and puts a `theorem` launcher in `~/.local/bin`. Make sure `~/.local/bin` is on your `PATH`.

These options go after `bash -s --`:

| Option | What it does |
| :--- | :--- |
| `--version 1.5.9` | Install one specific version |
| `--beta` | Install the newest beta (pre-release) instead of the newest stable release |
| `--bundle deb` or `--bundle appimage` | Force a package format |
| `--print-latest` | Print the latest version number and stop |

For example, to install the newest beta:

```bash
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash -s -- --beta
```

Only `.deb` and `.AppImage` files are published. There is no `.rpm`, so Fedora, RHEL and openSUSE users get the AppImage.

### Manually

- For a `.deb`, run `sudo apt install ./Theorem_<version>_amd64.deb`.
- For an AppImage, make the file executable with `chmod +x Theorem_<version>_amd64.AppImage` and run it.

The published Linux builds are for 64-bit x86 (amd64).

## Install on Android

Theorem for Android is distributed as an APK file on the release page. It is not in an app store.

1. On your phone, open the release page and download `app-arm64-release.apk`. Use `app-arm-release.apk` only if your phone is a 32-bit device.
2. Open the downloaded file. Android may ask you to allow installs from your browser or file manager. Allow it for this install.
3. Tap Install, then open Theorem.

Theorem for Android needs Android 7.0 (API level 24) or newer. Android updates are manual: download and install the newer APK over the old one.

## Stable and beta releases

Versions that end in `.0`, such as 1.5.0, are stable releases. Other versions, such as 1.5.9, are published as betas (pre-releases). The Linux install script installs the latest stable release unless you pass `--beta`.

As of October 2026 every release after 1.5.0 has been published as a beta, so the latest stable release is 1.5.0 and the plain install command installs 1.5.0. To get the newest version, pass `--beta` (currently 1.5.9) or `--version 1.5.9`. Once a stable release is published, the plain command installs that one.

## Update Theorem

On Windows, macOS and Linux desktop builds, check for updates inside the app.

1. Open Settings and select the About tab.
2. Under Links, click Check for Updates.
3. If a stable update is found, click Install Update & Restart. Theorem downloads it and asks you to restart.
4. If you are running a beta and a newer beta exists, the app shows a View Beta Release link instead. Open it and install the new version from the release page.
5. If nothing newer exists, a message says Up to Date.

The same Links section has a Download Latest Release link that opens the releases page. Android has no in-app updater. Install a newer APK over the old one.

## Next step

Continue with [Getting started](getting-started.md).
