#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Resolve this script's directory. Works when run from the repo, or when piped
# via `curl | bash` (in which case BASH_SOURCE[0] is empty and there is no
# local repo to resolve against).
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fi

repo_root=""
if [[ -n "$SCRIPT_DIR" ]]; then
    repo_root="$(cd -- "$SCRIPT_DIR/.." && pwd 2>/dev/null || true)"
fi

output_dir=""
if [[ -n "$repo_root" && -d "$repo_root" ]]; then
    output_dir="$repo_root/dist/packages/linux"
fi
output_dir="${output_dir:-/tmp/theorem-install}"

# ── Logging ──
log_info()  { echo "[$(date +'%H:%M:%S')] INFO: $*" >&2; }
log_warn()  { echo "[$(date +'%H:%M:%S')] WARN: $*" >&2; }
log_error() { echo "[$(date +'%H:%M:%S')] ERROR: $*" >&2; }

# ── Cleanup trap ──
TMPFILES=()
cleanup() {
    for f in "${TMPFILES[@]}"; do rm -rf -- "$f" 2>/dev/null || true; done
}
trap cleanup EXIT

# ── Detect architecture ──
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64)  ARCH="amd64"  ;;
    aarch64) ARCH="arm64"  ;;
    *)       log_error "Unsupported architecture: $ARCH"; exit 1 ;;
esac

GH_REPO="fundaments-work/Theorem"

# ── Paths ──
APP_DIR="$HOME/.local/lib/theorem"
BIN_DIR="$HOME/.local/bin"

# ── Kill running instances ──
kill_theorem() {
    local pids
    pids="$(pgrep -x theorem 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
        log_info "Stopping running Theorem process(es): $(echo "$pids" | tr '\n' ' ')"
        kill -TERM $pids 2>/dev/null || true
        sleep 1
        # Force kill if still running
        pids="$(pgrep -x theorem 2>/dev/null || true)"
        if [[ -n "$pids" ]]; then
            kill -KILL $pids 2>/dev/null || true
        fi
        log_info "Stopped"
    fi
}

# ── Download ──
download_release() {
    local -r bundle_type="$1"
    local pattern=""

    case "$bundle_type" in
        deb)      pattern="Theorem_${VERSION}_${ARCH}.deb" ;;
        rpm)      pattern="Theorem-${VERSION}-1.${ARCH}.rpm" ;;
        appimage) pattern="Theorem_${VERSION}_${ARCH}.AppImage" ;;
    esac

    local -r url="https://github.com/$GH_REPO/releases/download/v${VERSION}/$pattern"
    local -r dest="$output_dir/$pattern"

    mkdir -p "$output_dir"
    log_info "Downloading $pattern ..."
    curl -fsSL "$url" -o "$dest"
    log_info "Downloaded $pattern"
    ARTIFACT="$dest"
}

# ── Distro detection ──
detect_bundle() {
    # deb-based (Debian, Ubuntu, Pop, Mint)
    if command -v apt >/dev/null 2>&1 || command -v dpkg >/dev/null 2>&1; then
        printf "deb\n"
    else
        # AppImage runs on any distribution. Note: no .rpm is currently
        # published, so rpm-based distros fall back to the AppImage.
        printf "appimage\n"
    fi
}

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log_error "Missing required command: $1"
        exit 1
    fi
}

run_as_root() {
    if [[ "${EUID}" -eq 0 ]]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        log_error "Need root privileges: $*"
        exit 1
    fi
}

# ── Local deb install (without root) ──
install_deb_locally() {
    local -r artifact="$1"
    local -r icons_root="$HOME/.local/share/icons/hicolor"
    local temp_dir
    temp_dir="$(mktemp -d)"
    TMPFILES+=("$temp_dir")

    mkdir -p "$APP_DIR" "$BIN_DIR" "$HOME/.local/share/applications" "$icons_root"
    rm -rf "$APP_DIR/usr"

    bsdtar -xf "$artifact" -C "$temp_dir"
    bsdtar -xzf "$temp_dir/data.tar.gz" -C "$APP_DIR"

    ln -sf "$APP_DIR/usr/bin/theorem" "$BIN_DIR/theorem"
    cp -f "$APP_DIR/usr/share/applications/Theorem.desktop" "$HOME/.local/share/applications/theorem.desktop"
    sed -i "s|^Exec=theorem|Exec=$BIN_DIR/theorem|" "$HOME/.local/share/applications/theorem.desktop"

    while IFS= read -r icon; do
        local relative_path="${icon#"$APP_DIR/usr/share/icons/hicolor/"}"
        install -Dm644 "$icon" "$icons_root/$relative_path"
    done < <(find "$APP_DIR/usr/share/icons/hicolor" -type f -name "theorem.png" 2>/dev/null || true)

    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    gtk-update-icon-cache -q "$icons_root" 2>/dev/null || true

    log_info "Installed Theorem into $APP_DIR"
}

# ── AppImage install ──
install_appimage() {
    local -r artifact="$1"
    local -r icons_dir="$HOME/.local/share/icons/hicolor/128x128/apps"

    mkdir -p "$APP_DIR" "$BIN_DIR" "$HOME/.local/share/applications" "$icons_dir"

    install -Dm755 "$artifact" "$APP_DIR/Theorem.AppImage"
    ln -sf "$APP_DIR/Theorem.AppImage" "$BIN_DIR/theorem"

    if [[ -n "$repo_root" && -f "$repo_root/src-tauri/icons/128x128.png" ]]; then
        install -Dm644 "$repo_root/src-tauri/icons/128x128.png" "$icons_dir/theorem.png"
    else
        curl -fsSL -o "$icons_dir/theorem.png" "https://raw.githubusercontent.com/$GH_REPO/main/src-tauri/icons/128x128.png"
    fi

    cat > "$HOME/.local/share/applications/theorem.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Theorem
Comment=Local-first reader for PDFs, EPUBs, and RSS with markdown export.
Exec=$BIN_DIR/theorem %F
Icon=theorem
Terminal=false
Categories=Education;
MimeType=application/epub+zip;application/x-mobipocket-ebook;application/vnd.amazon.ebook;application/vnd.amazon.mobi8-ebook;application/x-fictionbook+xml;application/vnd.comicbook+zip;application/pdf;
StartupWMClass=theorem
DESKTOP

    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

    log_info "Installed AppImage to $APP_DIR/Theorem.AppImage"
}

# ── Usage ──
usage() {
    cat <<EOF
Usage: ./scripts/install-linux.sh [--version VERSION] [--bundle deb|rpm|appimage]

Downloads the latest Theorem release from GitHub and installs it.
If --version is omitted, auto-detects the latest release.

Options:
    --version VERSION   Install a specific version (default: latest)
    --bundle TYPE       Package format: deb, appimage (default: auto-detect)
    --print-latest      Print the latest available version and exit
    -h, --help          Show this help

Note: only .deb and .AppImage are published. rpm-based distros
(Fedora, RHEL, SUSE) install the AppImage.
EOF
    exit "${1:-0}"
}

# ── Main ──
VERSION=""
bundle="auto"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)  VERSION="$2"; shift 2 ;;
        --bundle|-b) bundle="$2"; shift 2 ;;
    --print-latest)
        need_cmd jq
        curl -fsSL "https://api.github.com/repos/$GH_REPO/releases/latest" | jq -r '.tag_name | ltrimstr("v")'
        exit 0
        ;;
    --help|-h)  usage 0 ;;
    *)          log_error "Unknown argument: $1"; usage 1 ;;
    esac
done

need_cmd curl
need_cmd bsdtar

# Auto-detect latest version
if [[ -z "$VERSION" ]]; then
    need_cmd jq
    VERSION="$(curl -fsSL "https://api.github.com/repos/$GH_REPO/releases/latest" | jq -r '.tag_name | ltrimstr("v")')"
    if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
        log_error "Failed to detect latest version from GitHub"
        exit 1
    fi
    log_info "Latest release: v$VERSION"
fi

if [[ "$bundle" == "auto" ]]; then
    bundle="$(detect_bundle)"
fi

log_info "Installing Theorem v$VERSION ($bundle) for $ARCH"

# Kill running instances before replacing files
kill_theorem

# Download
download_release "$bundle"

# Install
case "$bundle" in
    deb)
        if command -v apt >/dev/null 2>&1; then
            run_as_root apt install -y --reinstall "$ARTIFACT"
        elif command -v dpkg >/dev/null 2>&1; then
            run_as_root dpkg -i "$ARTIFACT"
        else
            install_deb_locally "$ARTIFACT"
        fi
        ;;
    rpm)
        if command -v dnf >/dev/null 2>&1; then
            run_as_root dnf install -y "$ARTIFACT"
        elif command -v yum >/dev/null 2>&1; then
            run_as_root yum localinstall -y "$ARTIFACT"
        elif command -v zypper >/dev/null 2>&1; then
            run_as_root zypper --non-interactive install "$ARTIFACT"
        elif command -v rpm >/dev/null 2>&1; then
            run_as_root rpm -Uvh --replacepkgs "$ARTIFACT"
        else
            install_deb_locally "$ARTIFACT"
        fi
        ;;
    appimage)
        install_appimage "$ARTIFACT"
        ;;
esac

log_info "Theorem v$VERSION installed successfully"
log_info "App: $BIN_DIR/theorem"

if command -v pacman >/dev/null 2>&1; then
    log_info "Arch Linux detected — for a native package, use docs/PKGBUILD:"
    log_info "  cd theorem && makepkg -si"
fi

# Clean up the temp download directory if we ran standalone (no repo checkout).
cleanup
exit 0
