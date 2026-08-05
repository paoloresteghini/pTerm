# Update notifier design

Date: 2026-08-05

## Goal

PRCLI notices when a newer version has been published to GitHub Releases and
tells the user, who then downloads and installs it by hand.

## What this is not, and why

The obvious ask is a real auto-updater: background download, "restart to
update", no manual step. On macOS that runs on Squirrel.Mac, and Squirrel.Mac
will not apply an update to a bundle that is not code signed. Signing needs an
Apple Developer Program membership. That was declined, so the auto-apply half
of the feature is unavailable and this spec covers the notify half only.

Two consequences worth recording rather than rediscovering:

- An unsigned, unnotarized `.app` delivered in a zip is quarantined by
  Gatekeeper. On macOS 15 and later, right-click-Open no longer clears it: the
  installer has to go to System Settings, Privacy & Security, "Open Anyway",
  once per install. This is the distribution floor for an unsigned app and is
  independent of anything in this spec.
- Squirrel.Mac's actual check appears to be that the new bundle's signature is
  valid and its designated requirement matches the running app, not that the
  certificate is Apple-issued. If that holds, a **self-signed** certificate
  might unlock real auto-update without the $99. This is unverified and
  nothing here depends on it. It is a cheap, decisive spike if wanted later:
  sign 0.1.0 and 0.1.1 with a self-signed Keychain cert, point one at the
  other, see whether ShipIt applies it. The UI built by this spec is reusable
  either way.

## Audience

One user, one machine, arm64. Releases carry a single arm64 zip. The notifier
does not select an asset by architecture because there is only ever one.

## Architecture

### Version, the single source of truth

`package.json`'s `version` field. The packaged app reads it back through
`app.getVersion()`. The release tag is `v<version>`. Nothing else in the
codebase records a version number.

### The check

Main process issues `GET https://api.github.com/repos/<owner>/PRCLI/releases/latest`.

- Unauthenticated. The repo is public and the limit is 60 requests per hour
  per IP, against a demand of roughly five per day.
- A `User-Agent` header is required. GitHub returns 403 without one.
- Only two fields are read: `tag_name` and `html_url`.

Schedule: once about 10 seconds after launch, then every 6 hours. The delay
keeps the check off the critical path of tmux restore, which is what the user
is waiting for at launch.

### Comparison

`tag_name` with a leading `v` stripped, compared to `app.getVersion()` by a
small semver comparison written in this repo (roughly 15 lines: split on `.`,
numeric compare each field). No dependency is added for this.

A tag that is not plain `major.minor.patch` — a prerelease, a suffix, anything
unparseable — is treated as "no update", not as an error.

### Failure is always silent

Offline, DNS failure, rate limited, GitHub 5xx, malformed JSON, missing
fields, non-semver tag: every one of these results in no banner and no
message. They log to the main-process console and nothing more.

This is a deliberate rule, not an oversight. An update check is the least
important thing the app does, and this codebase has already shipped a raw IPC
error painted into a pane once. A failed check must be invisible.

### Skip state

A file of its own: `~/.prcli/update.json`, containing one field, the version
string the user chose to skip. If it names a version greater than or equal to
the latest release, no banner is shown.

Deliberately not part of `PrcliConfig`. That store is at `version: 8`; adding
a field means a migration to 9 and a corresponding entry in
`attachSavedFields`, both of which sit on the path that decides what survives
a relaunch. The cost of a separate 30-line module is lower than the cost of
touching that path for a value nothing else reads.

Read and write failures on this file are non-fatal: an unreadable file means
"nothing skipped".

### UI

A thin, dismissible bar rendered in `App.tsx` **below** `TitleBar`, spanning
the window width:

> PRCLI 0.2.0 available &nbsp;·&nbsp; **Download** &nbsp;·&nbsp; **Skip this version** &nbsp;·&nbsp; **✕**

- **Download** calls `shell.openExternal` on the release's `html_url`, opening
  the GitHub release page in the browser, and hides the bar. The user picks the
  zip from that page themselves; the app does not download anything.
- **Skip this version** persists the version and hides the bar.
- **✕** hides the bar for this launch only.

It is not placed inside `TitleBar`. That component is the window's only
`drag-region`, and its own comment records why nothing in it is clickable: a
drag region swallows pointer events, so every interactive child needs
`no-drag`, and the invariant "there is no such list to keep correct" is worth
more than the compactness.

`SettingsPane` gains an **Updates** section: the running version, the time of
the last successful check, and a **Check now** button that runs the check
immediately and reports its result there (including failures, which is the one
place a failure may be shown, because the user asked).

### IPC

Three additions to `CHANNELS` in `src/shared/ipc.ts`:

| Channel | Direction | Purpose |
| --- | --- | --- |
| `updateAvailable` | main → renderer, push | `{ version, url }` when a newer release is found |
| `checkForUpdate` | renderer → main, invoke | Settings' "Check now"; resolves with the result including failure |
| `skipUpdate` | renderer → main, invoke | Persist a skipped version |

Preload exposes all three on `PrcliApi` following the existing pattern, with
`onUpdateAvailable` returning an unsubscribe function like `onData` and
`onExit` do.

## Files

New:

- `src/main/update/check.ts` — fetch, parse, compare. Pure functions for parse
  and compare, exported for unit test.
- `src/main/update/store.ts` — read/write `~/.prcli/update.json`.
- `src/renderer/UpdateBar.tsx` — the bar.
- `scripts/release.sh` — the release flow below.

Modified: `src/shared/ipc.ts`, `src/preload/index.ts`,
`src/main/ipc/register.ts`, `src/main/index.ts` (schedule the check),
`src/renderer/App.tsx`, `src/renderer/SettingsPane.tsx`.

## Release flow

Local, on the machine that already builds the app. No GitHub Action: a macOS
runner is free for a public repo, but it adds a workflow, a native-module
build risk for `node-pty` on CI, and a slower loop, for no gain at one user.

`scripts/release.sh`:

1. `npm version <patch|minor|major>` — bumps `package.json` and creates the
   `v<version>` tag.
2. `npm run make` — produces `out/make/zip/darwin/arm64/PRCLI-darwin-arm64-<version>.zip`.
3. `git push --follow-tags`.
4. `gh release create v<version> <the zip>`.

The script refuses to run on a dirty working tree.

## Prerequisite

The repo has no git remote. Before any of this:

```
gh repo create <owner>/PRCLI --public --source=. --push
```

`<owner>` is assumed to be `paoloresteghini`, from the author email in
`package.json`; confirm before running. The repo currently contains `docs/`,
tmux integration and Claude Code hook installation code — review for anything
that should not be public before the first push.

## Testing

Unit (`tests/unit/`):

- Semver compare: newer, older, equal, multi-digit fields, `v` prefix,
  unparseable input.
- Release-response parse: a well-formed response, missing `tag_name`, missing
  `html_url`, malformed JSON, a prerelease tag.
- Skip store: round-trip, missing file, unreadable file, a skipped version
  older than the latest (banner shows) and equal or newer (it does not).

E2E (`tests/e2e/`): assert the bar appears with the right version, that
**Download** and **✕** hide it, that **Skip** hides it, and that after
relaunch a skipped version produces no bar.

The push must be driven **from the main process**, not by stubbing the
renderer:

```js
await electronApp.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].webContents.send('prcli:updateAvailable', {
    version: '99.0.0',
    url: 'https://example.invalid/release',
  })
)
```

`window.prcli` cannot be stubbed from the page. `contextBridge` freezes it:
the object and every method on it are `writable: false, configurable: false`,
a plain assignment is a silent no-op, and `defineProperty` throws. Any test
written as "stub the bridge, then assert" would pass against a broken
implementation.

No test performs a network request. The scheduled check reads an env var
(`PRCLI_UPDATE_CHECK=0`) that the E2E harness sets, so the app never reaches
api.github.com during a test run; the tests drive the push themselves.

**Download** is asserted by intercepting `shell.openExternal` in main, not by
watching for a browser to open.

Note for whoever writes the E2E: locators must not use a `data-testid`
beginning with `tab-`. Over 27 existing assertions count tabs with
`[data-testid^="tab-"]`, and anything under that prefix inflates every one of
them.
