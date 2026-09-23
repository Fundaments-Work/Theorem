#!/usr/bin/env bash
# Sync the foliate-js submodule into our runtime directory.
#
#   scripts/sync-foliate-js.sh                   rebuild the runtime: upstream files
#                                                + pdfjs import rewrites + our patches
#   scripts/sync-foliate-js.sh --check           rebuild into a temp dir and fail if it
#                                                differs from the committed runtime
#   scripts/sync-foliate-js.sh --refresh-patches rewrite scripts/patches/*-runtime.patch
#                                                from the current runtime (run after
#                                                editing files in foliate-js-runtime/)
#
# The runtime (src/features/reader/foliate-js-runtime/) is ours; every change
# to it must be captured by --refresh-patches or the next sync loses it.
# NOTE: vendor/pdfjs/ was intentionally removed (13MB dead code); the app uses
# pdfjs-dist from npm — see pdfjs-runtime.ts.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SUBMODULE_DIR="$REPO_ROOT/src/features/reader/foliate-js"
RUNTIME_DIR="$REPO_ROOT/src/features/reader/foliate-js-runtime"
PATCH_DIR="$REPO_ROOT/scripts/patches"
MODE="${1:-sync}"

CORE_FILES=(
    view.js dict.js epub.js comic-book.js fb2.js mobi.js paginator.js
    fixed-layout.js epubcfi.js progress.js overlayer.js text-walker.js
    search.js tts.js pdf.js types.d.ts LICENSE
)
VENDOR_FILES=(zip.js fflate.js)

# Upstream files plus the mechanical pdfjs-dist rewrites, no patches.
build_pristine() {
    local out="$1"
    mkdir -p "$out/vendor"
    for file in "${CORE_FILES[@]}"; do
        [[ -f "$SUBMODULE_DIR/$file" ]] && cp "$SUBMODULE_DIR/$file" "$out/"
    done
    for file in "${VENDOR_FILES[@]}"; do
        cp "$SUBMODULE_DIR/vendor/$file" "$out/vendor/"
    done
    sed -i "s|await import('./vendor/pdfjs/pdf.mjs')|import('pdfjs-dist')|g" "$out/view.js" "$out/fixed-layout.js"
    sed -i "s|import './vendor/pdfjs/pdf.mjs'|import 'pdfjs-dist'|g" "$out/pdf.js"
    # String concat (not a template literal) so Vite's import-glob does not
    # misread the path as a glob pattern.
    sed -i 's|const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()|const pdfjsPath = path => new URL("pdfjs-dist/build/" + path, import.meta.url).toString()|' "$out/pdf.js"
}

# Patch files are named after their target: view-js-runtime.patch -> view.js,
# vendor__zip-js-runtime.patch -> vendor/zip.js.
patch_target() {
    local name="${1%-runtime.patch}"
    name="${name//__//}"
    echo "${name%-js}.js"
}

apply_patches() {
    local out="$1"
    shopt -s nullglob
    for patch_file in "$PATCH_DIR"/*-runtime.patch; do
        local target
        target="$(patch_target "$(basename "$patch_file")")"
        patch -s "$out/$target" < "$patch_file" || {
            echo "ERROR: $(basename "$patch_file") failed on $target" >&2
            exit 1
        }
    done
    if grep -rq "vendor/pdfjs" "$out" --include="*.js"; then
        echo "ERROR: vendor/pdfjs references remain:" >&2
        grep -r "vendor/pdfjs" "$out" --include="*.js" >&2
        exit 1
    fi
}

case "$MODE" in
    sync)
        rm -rf "$RUNTIME_DIR"
        build_pristine "$RUNTIME_DIR"
        apply_patches "$RUNTIME_DIR"
        echo "Sync complete. Runtime at: $RUNTIME_DIR ($(du -sh "$RUNTIME_DIR" | cut -f1))"
        ;;
    --check)
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' EXIT
        build_pristine "$tmp"
        apply_patches "$tmp"
        if diff -r "$tmp" "$RUNTIME_DIR"; then
            echo "foliate-js runtime matches submodule + patches"
        else
            echo "ERROR: runtime differs from submodule + patches; run --refresh-patches" >&2
            exit 1
        fi
        ;;
    --refresh-patches)
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' EXIT
        build_pristine "$tmp"
        rm -f "$PATCH_DIR"/*-runtime.patch
        (cd "$tmp" && find . -type f | sed 's|^\./||' | sort) | while read -r rel; do
            if ! cmp -s "$tmp/$rel" "$RUNTIME_DIR/$rel"; then
                name="${rel//\//__}"
                name="${name%.js}-js-runtime.patch"
                diff -u --label "$rel" --label "$rel" "$tmp/$rel" "$RUNTIME_DIR/$rel" > "$PATCH_DIR/$name" || true
                echo "  wrote $name"
            fi
        done
        extra="$(cd "$RUNTIME_DIR" && find . -type f | sed 's|^\./||' | sort | while read -r rel; do [[ -e "$tmp/$rel" ]] || echo "$rel"; done)"
        if [[ -n "$extra" ]]; then
            echo "ERROR: runtime files with no upstream source (add them to CORE_FILES or remove):" >&2
            echo "$extra" >&2
            exit 1
        fi
        ;;
    *)
        echo "usage: $0 [--check|--refresh-patches]" >&2
        exit 2
        ;;
esac
