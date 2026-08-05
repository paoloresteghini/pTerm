#!/usr/bin/env bash
# Cut a release: bump, build, tag, upload.
#
# Local rather than a GitHub Action. A macOS runner is free for a public repo,
# but it would add a workflow, a native-module build of node-pty on CI, and a
# slower loop, to replace a machine that is already here and already builds
# this app every day.
#
# The app is UNSIGNED. Whoever downloads the zip has to clear Gatekeeper by
# hand once, in System Settings, Privacy and Security, "Open Anyway"; on macOS
# 15 and later right-click-Open no longer does it. That is the cost of not
# holding an Apple Developer Program membership, and it is the reason there is
# no auto-apply here, only a notification.
set -euo pipefail

BUMP="${1:-patch}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

# Releases are cut from one branch. This checkout is shared by several agent
# sessions at once, and HEAD has moved under a running session before; a
# release built from the wrong branch is public the moment it pushes.
RELEASE_BRANCH="${RELEASE_BRANCH:-master}"
CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$RELEASE_BRANCH" ]]; then
  echo "On branch '$CURRENT_BRANCH', but releases are cut from '$RELEASE_BRANCH'." >&2
  echo "Switch branches, or set RELEASE_BRANCH to override." >&2
  exit 1
fi

# gh release create needs the repo to already exist on GitHub, and
# git push --follow-tags needs somewhere to push to. Failing here is cheap;
# failing after the version bump, the tag and a multi-minute build is not.
if [[ -z "$(git remote)" ]]; then
  echo "No git remote configured. Create the GitHub repo first, then re-run." >&2
  exit 1
fi

npm run typecheck
npm test

npm version "$BUMP"
VERSION="$(node -p "require('./package.json').version")"

npm run make

ZIP="out/make/zip/darwin/arm64/PRCLI-darwin-arm64-${VERSION}.zip"
if [[ ! -f "$ZIP" ]]; then
  echo "Expected build output at $ZIP but it is not there." >&2
  echo "Contents of out/make:" >&2
  find out/make -name '*.zip' >&2 || true
  exit 1
fi

git push --follow-tags
gh release create "v${VERSION}" "$ZIP" --title "v${VERSION}" --generate-notes

echo "Released v${VERSION}."
