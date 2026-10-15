# 7. pairbrowse:// names the browser's own pages, and agents never get them

- Status: Accepted
- Date: 2026-10-11 (commit 47a25b9, the new tab page, first use of `pairbrowse://`); one set of rules in `ui/urls.js` on 2026-10-15 (commit 0bc55ba)

## Context

A native build with its own pages (ADR 1) serves them from `chrome://pairbrowse` (tab pages:
picker, screen, sessions, settings, activity, new tab) and `chrome://pairbrowse.top-chrome` (the
window's slot pages: strip, docks, timeline, approval bubble, capture). People should see a
PairBrowse name, not `chrome://`. Those pages also carry the owner's key and powers (settings,
invites, approvals), so an agent that could open, read or click in them could change settings or
answer its own approvals.

## Decision

- The build shows its own pages and Chromium's as `pairbrowse://<name>` (a display rewrite; the
  committed address stays `chrome://`, which is what a tab reports) and opens them when typed so.
  `ownPage(name)` builds such an address for links.
- Every `pairbrowse:` address and every `chrome://pairbrowse` or `chrome://pairbrowse.top-chrome`
  address, under either spelling, is the browser's own (`isChromePage`). Agents can't navigate to
  one, select or close one, or have one as their tab; tab lists, the live view and joiners never
  get them. The one exception is a fresh, unused new tab page, which `browser_navigate` may take
  to a web address.
- A joiner's picture page (`pairbrowse://screen`) is handled like the extension's screen page.
- The rules live once in `ui/urls.js`, shared by the helper and the pages.

## Consequences

- Agents can't reach the owner's controls through the browser's own UI
  ([security.md](../security.md), "An agent opens, reads or drives the browser's own pages").
- Pages and helper can't drift apart on which addresses are protected.
- The build's own page list will take over from address prefixes when it exists.

## In code

- `ui/urls.js`: `ownPage`, `isChromePage`, `isChromeScreenPage`, `hiddenFromLiveView`,
  `isOwnTabPage`, `isSettingsPage`, `CHROME_PAGE_ORIGINS`
- `scripts/rules/policy.mjs` (navigation refusal via `isChromePage`)
- `scripts/daemon/join/screens.mjs` (the picture page under its `pairbrowse://` name)
