#!/usr/bin/env bash
# Sync foliate-js submodule to runtime directory
# Copies only required files and patches PDF.js imports.
# NOTE: vendor/pdfjs/ was intentionally removed from the repo (13MB dead code).
# The app uses pdfjs-dist from npm — see pdfjs-runtime.ts.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SUBMODULE_DIR="$REPO_ROOT/src/features/reader/foliate-js"
RUNTIME_DIR="$REPO_ROOT/src/features/reader/foliate-js-runtime"
VENDOR_DIR="$RUNTIME_DIR/vendor"

echo "Syncing foliate-js from submodule..."

# Clean and create runtime directory
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
mkdir -p "$VENDOR_DIR"

# Files to copy from submodule root
CORE_FILES=(
    "view.js"
    "dict.js"
    "epub.js"
    "comic-book.js"
    "fb2.js"
    "mobi.js"
    "paginator.js"
    "fixed-layout.js"
    "epubcfi.js"
    "progress.js"
    "overlayer.js"
    "text-walker.js"
    "search.js"
    "tts.js"
    "pdf.js"
    "types.d.ts"
    "LICENSE"
)

echo "Copying core files..."
for file in "${CORE_FILES[@]}"; do
    if [[ -f "$SUBMODULE_DIR/$file" ]]; then
        cp "$SUBMODULE_DIR/$file" "$RUNTIME_DIR/"
        echo "  ✓ $file"
    else
        echo "  ✗ $file (not found)"
    fi
done

# Copy vendor dependencies (zip.js, fflate.js) - NOT pdfjs
echo "Copying vendor dependencies..."
cp "$SUBMODULE_DIR/vendor/zip.js" "$VENDOR_DIR/"
cp "$SUBMODULE_DIR/vendor/fflate.js" "$VENDOR_DIR/"
echo "  ✓ vendor/zip.js"
echo "  ✓ vendor/fflate.js"

# Patch imports in view.js to use pdfjs-dist instead of vendored PDF.js
echo "Patching PDF.js imports..."
VIEW_FILE="$RUNTIME_DIR/view.js"

# Replace the PDF.js import in view.js
# Original: await import('./vendor/pdfjs/pdf.mjs')
# New: import * as pdfjsLib from 'pdfjs-dist'
sed -i "s|await import('./vendor/pdfjs/pdf.mjs')|import('pdfjs-dist')|g" "$VIEW_FILE"

# Also need to handle the PDF.js usage in fixed-layout.js if it imports pdfjs
# Check fixed-layout.js for PDF.js usage
if grep -q "vendor/pdfjs" "$RUNTIME_DIR/fixed-layout.js" 2>/dev/null; then
    echo "Patching fixed-layout.js PDF.js imports..."
    sed -i "s|await import('./vendor/pdfjs/pdf.mjs')|import('pdfjs-dist')|g" "$RUNTIME_DIR/fixed-layout.js"
fi

# Patch pdf.js: replace vendored PDF.js with pdfjs-dist
if grep -q "vendor/pdfjs" "$RUNTIME_DIR/pdf.js" 2>/dev/null; then
    echo "Patching pdf.js PDF.js imports..."
    # Replace static import of vendored pdf.mjs
    sed -i "s|import './vendor/pdfjs/pdf.mjs'|import 'pdfjs-dist'|g" "$RUNTIME_DIR/pdf.js"
    # Replace pdfjsPath function. Use string concat (not template literal)
    # to avoid Vite's import-glob misinterpreting the path as a glob pattern.
    sed -i 's|const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()|const pdfjsPath = path => new URL("pdfjs-dist/build/" + path, import.meta.url).toString()|' "$RUNTIME_DIR/pdf.js"
fi

# Verify no remaining references to vendor/pdfjs
if grep -r "vendor/pdfjs" "$RUNTIME_DIR" --include="*.js" 2>/dev/null; then
    echo "WARNING: Found remaining vendor/pdfjs references:"
    grep -r "vendor/pdfjs" "$RUNTIME_DIR" --include="*.js"
else
    echo "  ✓ No vendor/pdfjs references remain"
fi

# Apply runtime patches
echo "Applying runtime patches..."
PATCHES=(
    "view-js-runtime.patch:view.js patched (prefetchPromise, parallel zip loading)"
    "epub-js-runtime.patch:epub.js patched (in-flight loadText dedup)"
    "dict-js-runtime.patch:dict.js patched (StarDict gzip/dictzip loading)"
    "paginator-js-runtime.patch:paginator.js patched (overflow:clip, transform pagination)"
    "overlayer-js-runtime.patch:overlayer.js patched (hitTest guards, text selection layer)"
)
for entry in "${PATCHES[@]}"; do
    file="${entry%%:*}"
    msg="${entry#*:}"
    patch -d "$RUNTIME_DIR" -p0 < "$REPO_ROOT/scripts/patches/$file" || {
        echo "ERROR: $file patch failed" >&2
        exit 1
    }
    echo "  ✓ $msg"
done

echo "Sync complete. Runtime at: $RUNTIME_DIR"
echo "Size: $(du -sh "$RUNTIME_DIR" | cut -f1)"