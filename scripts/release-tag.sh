#!/usr/bin/env bash
# Resolve and classify an existing release tag, then check out its exact commit.
set -euo pipefail
TAG="$REQUESTED_TAG"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::Expected an existing vX.Y.Z release tag."
  exit 1
fi
SHA=$(git rev-parse --verify "refs/tags/$TAG^{commit}")
{
  echo "tag=$TAG"
  echo "sha=$SHA"
  echo "VERSION=${TAG#v}"
  patch="${TAG##*.}"
  if [[ "$TAG" == *-* || "$patch" != 0 ]]; then
    echo "prerelease=true"
  else
    echo "prerelease=false"
  fi
} >> "$GITHUB_OUTPUT"
git checkout --detach "$SHA"
