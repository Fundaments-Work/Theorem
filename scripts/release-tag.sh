#!/usr/bin/env bash
# Resolve and classify an existing release tag, then check out its exact commit.
set -euo pipefail
TAG="$REQUESTED_TAG"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::Expected an existing vX.Y.Z release tag."
  exit 1
fi
SHA=$(git rev-parse --verify "refs/tags/$TAG^{commit}")
echo "tag=$TAG" >> "$GITHUB_OUTPUT"
echo "sha=$SHA" >> "$GITHUB_OUTPUT"
echo "VERSION=${TAG#v}" >> "$GITHUB_OUTPUT"
patch="${TAG##*.}"
if [[ "$TAG" == *-* || "$patch" != 0 ]]; then
  echo "prerelease=true" >> "$GITHUB_OUTPUT"
else
  echo "prerelease=false" >> "$GITHUB_OUTPUT"
fi
git checkout --detach "$SHA"
