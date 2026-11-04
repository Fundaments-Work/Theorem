#!/usr/bin/env bash
# Select gates conservatively; cancelled runs must not lose coverage.
set -euo pipefail
all() { for gate in web rust android e2e workflows; do echo "$gate=true" >> "$GITHUB_OUTPUT"; done; }
# A cancelled run is not a validation baseline. Include all changes
# since the last successful main run, including superseded pushes.
if [ "$EVENT" = push ]; then
  previous=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1" --jq '.workflow_runs[0].head_sha // empty') || { all; exit 0; }
  BASE="$previous"
fi
# Manual runs, new branches and unreachable bases check everything.
if [ "$EVENT" = workflow_dispatch ] || [ -z "$BASE" ] || [ "$BASE" = 0000000000000000000000000000000000000000 ] || ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then all; exit 0; fi
files="$(git diff --name-only "$BASE" "$GITHUB_SHA")"
has() { echo "$files" | grep -E "$1" >/dev/null && echo true || echo false; }
# Docs, issue templates and the like need no build at all.
shared='^(\.github/actions/|\.github/workflows/ci\.yml|package\.json|pnpm-lock\.yaml|scripts/|tsconfig.*\.json)'
{
  echo "web=$(has "$shared|^(src/|tests/|index\.html|ui-gallery\.html|public/|vite\.config|vitest\.config|src-tauri/crates/theorem-core/)")"
  echo "rust=$(has "^(\.github/actions/|\.github/workflows/ci\.yml|src-tauri/|pnpm-lock\.yaml)")"
  echo "android=$(has "^(\.github/workflows/ci\.yml|src-tauri/(src|crates|plugins|gen|Cargo|tauri\.conf|capabilities)|pnpm-lock\.yaml)")"
  echo "e2e=$(has '^(scripts/|src/|src-tauri/|public/|e2e/|package\.json|pnpm-lock\.yaml|vite\.config|index\.html|\.github/workflows/ci\.yml|\.github/actions/)')"
  echo "workflows=$(has '^(\.github/(workflows/|actions/)|scripts/(ci-changes|release-tag|check-release-assets)\.)')"
} >> "$GITHUB_OUTPUT"
