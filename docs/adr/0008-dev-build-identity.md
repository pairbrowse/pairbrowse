# 8. A development build has an identity of its own

- Status: Accepted
- Date: 2026-10-16 (commits 9efd20a, opener registry, and f7c104e, focus by process)

Interpretation: no source in this repository uses the phrase "dev identity". This record reads it
as what the code does about development builds' identity: the macOS bundle identifier a native
build carries and what the helper keys on it.

## Context

On macOS several things are tied to an app's bundle identifier: which app is in front, which
privacy grants apply, and, for PairBrowse, which helper a hand-opened browser hands its start to.
A development build of the native browser next to the release, both called PairBrowse, would
otherwise be indistinguishable: one could reach the other's helper, or focus could bring the wrong
window forward.

## Decision

- A release build is `app.pairbrowse.browser`; a build from the dev channel is
  `app.pairbrowse.browser.dev`. The id comes from the build manifest
  (`PairBrowse-build.json`): its `bundleId`, else `channel: "dev"`, else the release id for older
  builds.
- Each helper writes its opener record per bundle id under `~/.pairbrowse/run/openers/`; a
  hand-opened build reads its own app's record first. Record names are bundle ids only, never paths.
- Focus follows this helper's own browser by its process; the bundle ids are only a fallback, so
  another helper's PairBrowse window (a dev build, another instance) counts as any other app.
- Ad hoc signatures on installed builds show integrity, not who built them
  ([security.md](../security.md), "Supply chain").

## Consequences

- A dev build and the release coexist with separate helpers (usually separate instances, ADR 3)
  ([security.md](../security.md), "With several PairBrowse helpers on one computer ...").
- The helper itself runs as PairBrowse Agent (`app.pairbrowse.agent`) when the build carries it,
  a further identity of its own for privacy prompts (CHANGELOG Unreleased, "Prompts name
  PairBrowse, never Node").

## In code

- `scripts/openers.mjs`: `RELEASE_BUNDLE_ID`, `DEV_BUNDLE_ID`, `bundleIdOf`, `bundleIdOfApp`,
  `isRecordName`, `recordFile`, `parseRecord`
- `scripts/focus.mjs`: `BROWSER_IDS`, `isBrowser`, `childPids`
- `scripts/native/macos-app.mjs`: `verifySignature` (signature check on install)
- `scripts/launcher/daemon-connect.mjs`: `agentProgram`, `startDaemon` (the helper on PairBrowse Agent)
