#!/usr/bin/env bash
# Run from the repository root after bundling. Patterns stay literal until compgen.
set -euo pipefail
read -r -a patterns <<< "${1:?expected release asset patterns are required}"
base=
for candidate in src-tauri/target/release/bundle src-tauri/target/*/release/bundle; do
  if [[ -d "$candidate" ]]; then
    base="$candidate"
    break
  fi
done
if [[ -z "$base" ]]; then
  echo "::error::No bundle directory was produced"
  exit 1
fi
missing=0
for pattern in "${patterns[@]}"; do
  found=0
  # macOS still ships Bash 3.2, which has no mapfile builtin.
  while IFS= read -r file; do
    ls -l "$file"
    found=1
  done < <(compgen -G "$base/$pattern" || true)
  if [[ "$found" == 0 ]]; then
    echo "::error::missing $pattern"
    missing=1
  fi
done
exit "$missing"
