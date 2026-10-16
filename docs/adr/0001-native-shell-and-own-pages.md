# 1. The native build draws PairBrowse's own UI from ui/

- Status: Accepted
- Date: 2026-10-11 (commit 7c3dcb6, "the launch switch for a build with its own pages"); in the 0.16.0 notes of [CHANGELOG](../../CHANGELOG.md)

## Context

PairBrowse first ran as the open build plus a side panel extension. The side panel is a guest in
someone else's window: it can't own the tab strip, the docks, the new tab page or an approval card
that sits outside a tab's picture. The private PairBrowse Pro repo builds a native browser (see
[The native PairBrowse browser](../browser.md#the-native-pairbrowse-browser)), and that build can
host pages of its own on `chrome://pairbrowse` and `chrome://pairbrowse.top-chrome`.

## Decision

- Which browser runs and what draws PairBrowse's UI are two separate choices: the binary
  (the open build, a custom path, or the native build) and the shell ("extension" or "pages").
- A native build whose manifest (`PairBrowse-build.json`) declares its own pages loads no
  extension. Its pages take the side panel's place: tab strip,
  docks, new tab page, Settings, sessions, Activity, timeline, approval card, capture page.
- Every page lives in one tree, `ui/`, one folder per page with an `index.html`, shared modules flat
  at the root. During the bridge period the same tree is the side panel extension for every other
  binary.
- The pages reach the helper only through the live view on 127.0.0.1 with a second owner key, passed
  in an owner-only file, never on the command line.
- The native build and the engine pack are pinned by SHA-256 in `scripts/native-pack.mjs` and checked
  before install and before every load.

## Consequences

- One codebase for both shells; a page change ships to the extension and the native build at once.
- The native build rejects a `ui/<dir>` without `index.html`, so shared code must stay at the root.
- Agents can never open, read or drive these pages (see ADR 7).
- The security table carries rows for the pages' key and their routes
  ([security.md](../security.md), "The browser's own pages reach the helper, or something else
  reaches them").

## In code

- `scripts/browser/choice.mjs`: `browserChoice`, `chooseBrowser` (binary apart from shell)
- `scripts/native-engine.mjs`: `nativeManifest`, `declaresOwnPages`, `capturePages`, `captureKeyed`
- `scripts/browser.mjs`: `launchOptions`, `launchArgs`, `writeHelperKeyFile`, `dropHelperKeyFile`
- `scripts/native-pack.mjs`: `NATIVE`; `scripts/native/pack.mjs`: `ensureEngine`, `loadEngine`
- `scripts/native/install.mjs`: `nativeLayout`, `installNative`, `buildFits`
- `ui/` (pages), `ui/urls.js` (their addresses), `ui/pairbrowse-adapter.js` (`window.pairbrowse`)
