# 5. Chromium's sandbox is on, and never dropped quietly

- Status: Accepted
- Date: v0.15.20 (2026-10-07), on by default; v0.15.46 (2026-10-14), no quiet fallback on macOS and Windows ([CHANGELOG](../../CHANGELOG.md) 0.15.20, 0.15.22, 0.15.46)

## Context

Chromium's sandbox walls renderer and GPU processes off from the computer, so a page that exploits
a browser bug is contained. Automation setups often pass `--no-sandbox` for convenience. On Linux,
Chromium refuses the sandbox as root and can't start it without user namespaces (containers,
Ubuntu's AppArmor rule), where it needs a root-owned setuid helper a per-user install can't have.

## Decision

- The sandbox is on by default (`chromeSandbox: true` in the config defaults), for the Chromium
  build and the native build alike.
- It is off only when the user says so (`"chromeSandbox": false`, or `--no-sandbox` in
  `chromeArgs`), when the helper runs as root on Linux, or when a Linux launch fails with a
  sandbox error. Each case is written to the helper log once.
- On macOS and Windows a sandbox failure is the launch's error; the helper never retries without
  it there (0.15.46: the retry had applied on every system).

## Consequences

- A page exploit is contained as in the user's everyday Chrome
  ([security.md](../security.md), the notes under the table: "Chrome's own sandbox is on by
  default").
- Linux containers and AppArmor-restricted systems still work, with a logged, visible downgrade.
- The "unsupported command-line flag" bar is hidden with `--test-type` so a user-chosen
  `--no-sandbox` doesn't show a warning bar on every start.

## In code

- `scripts/engine.mjs`: `sandboxDecision`, `SANDBOX_FAILED`, `launchEngine` (the Linux-only retry)
- `scripts/paths.mjs`: config default `chromeSandbox: true`
- `scripts/native-engine.mjs`: `captureMacHost` (launches with `chromiumSandbox: true`)
- `scripts/browser.mjs`: `launchArgs`
