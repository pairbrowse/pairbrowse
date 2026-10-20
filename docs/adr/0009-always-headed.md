# 9. The browser is always headed; there is no headless mode

- Status: Accepted
- Date: by v0.13.1 (2026-10-04), the first release in this repository's history ([CHANGELOG](../../CHANGELOG.md) 0.13.1)

## Context

PairBrowse is a pair: the agent fills forms while the person watches and steps in for CAPTCHAs,
2FA and final submits. That needs a window the person can see and use. Headless browsers also
differ from everyday ones in ways sites notice, which brings more CAPTCHAs and refusals.

## Decision

- The user's browser always launches headed (`headless: false` in the one set of launch options);
  there is no setting that makes it headless ([browser.md](../browser.md#the-pairbrowse-browser):
  "There's no headless mode.").
- Inside the Claude desktop app the same headed browser is shown through the live view, docked or
  in the Browser pane, not replaced by a hidden one.
- On a Linux machine without a screen the browser still runs headed, on a private virtual screen
  (Xvfb without TCP, behind an X cookie in `~/.pairbrowse/run`).

## Consequences

- The person can always see and take over what the agent does; hand-offs work everywhere.
- Sites see a normal, rendered browser ([browser.md](../browser.md#the-native-pairbrowse-browser),
  "Browser compatibility hardening").
- Headless remains only where no person browses: test runs (passed as `--headless` in the test
  config's `browserArgs`, which also turns notifications off; `scripts/browser-args.mjs` passes it
  only in a helper the test harness started and drops it from anyone else's config) and the
  one-time hidden capture of the Mac's fingerprint on the real GPU (CHANGELOG 0.14.3).
- A headless server needs Xvfb and xauth installed.

## In code

- `scripts/browser.mjs`: `launchOptions` (`headless: false`), `launchArgs`
- `scripts/display.mjs`: `needsVirtualDisplay`, `startVirtualDisplay`
- `scripts/native-engine.mjs`: `captureMacHost` (the hidden one-time capture)
