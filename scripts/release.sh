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

REMOTE="${RELEASE_REMOTE:-origin}"

# The app polls a hardcoded owner/repo, RELEASES_URL in
# src/main/update/service.ts, not whatever this remote happens to point at.
# If the two disagree, a release goes somewhere the app never looks: a wrong
# owner gives a 404, a 404 is a failed check, and a failed check shows
# nothing, forever, by design (see service.ts). The expected owner/repo is
# read out of that file rather than duplicated here, so there is one source
# of truth and no way for the two to drift apart silently.
EXPECTED_REPO="$(grep -oE "repos/[^/']+/[^/']+/releases" src/main/update/service.ts | sed -E 's#repos/([^/]+)/([^/]+)/releases#\1/\2#')"
if [[ -z "$EXPECTED_REPO" ]]; then
  echo "Could not read the expected owner/repo out of src/main/update/service.ts." >&2
  exit 1
fi
REMOTE_URL="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
if [[ -z "$REMOTE_URL" ]]; then
  echo "Remote '$REMOTE' is not configured. Create the GitHub repo and add it as '$REMOTE', or set RELEASE_REMOTE." >&2
  exit 1
fi
# Read straight off the remote URL rather than asking `gh` to resolve it:
# `gh repo view` takes an OWNER/REPO argument, not a remote name, so handing
# it "$REMOTE" would ask for a repo literally called that. Covers both the
# SSH and HTTPS forms GitHub hands out.
ACTUAL_REPO="$(echo "$REMOTE_URL" | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')"
if [[ "$ACTUAL_REPO" != "$EXPECTED_REPO" ]]; then
  echo "Remote '$REMOTE' is '$ACTUAL_REPO', but the app polls '$EXPECTED_REPO'." >&2
  echo "A release pushed here would go somewhere the app never looks. Fix the remote, or RELEASES_URL, first." >&2
  exit 1
fi

# A rejected push is a non-fast-forward: something landed on the remote
# branch that this checkout does not have. Checking before npm version means
# that failure is cheap; the same rejection at the push near the bottom of
# this script would happen after the version bump, the tag and a
# multi-minute build, and a re-run would then fail on the existing tag.
git fetch "$REMOTE" --quiet
if git rev-parse --verify --quiet "refs/remotes/$REMOTE/$RELEASE_BRANCH" > /dev/null; then
  if ! git merge-base --is-ancestor "$REMOTE/$RELEASE_BRANCH" HEAD; then
    echo "Local '$RELEASE_BRANCH' is behind '$REMOTE/$RELEASE_BRANCH'. Pull first: a push here would be rejected after the build." >&2
    exit 1
  fi
fi

# E2E is deliberately not part of this gate. It takes minutes, needs a real
# tmux server, and this checkout has a documented flake
# (tests/e2e/notes.spec.ts, a pre-existing race unrelated to any one change).
# A release can therefore be cut on a green unit suite with a broken app;
# that is a real gap, and RELEASE_E2E=1 exists so it is a choice made on
# purpose per run rather than a silent default.
npm run typecheck
npm test
if [[ "${RELEASE_E2E:-0}" == "1" ]]; then
  npm run e2e
else
  echo "Skipping E2E (set RELEASE_E2E=1 to run it; it takes minutes and needs tmux)." >&2
fi

# The push near the bottom of this script is the first irreversible,
# publicly visible action; everything above it is local. Anyone running this
# by hand gets asked before it happens. A non-interactive run (no tty on
# stdin) is refused unless it opted in explicitly, so nothing here can hang
# waiting on input that will never come.
CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [[ -t 0 ]]; then
  read -r -p "About to bump $CURRENT_VERSION ($BUMP), build, push and publish a release on $EXPECTED_REPO. Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted." >&2
    exit 1
  fi
elif [[ "${RELEASE_YES:-0}" != "1" ]]; then
  echo "Not running in a terminal. Set RELEASE_YES=1 to confirm a non-interactive release." >&2
  exit 1
fi

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

git push "$REMOTE" "$RELEASE_BRANCH" --follow-tags
gh release create "v${VERSION}" "$ZIP" --title "v${VERSION}" --generate-notes

echo "Released v${VERSION}."
