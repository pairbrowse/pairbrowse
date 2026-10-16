# 5. The browser's sandbox is on, off only on Linux, and never dropped quietly

- Status: Accepted
- Date: v0.15.20 (2026-10-07), on by default; v0.15.46 (2026-10-14), no quiet fallback on macOS and Windows; v0.16.0 (2026-10-16), no opt-out on macOS and Windows ([CHANGELOG](../../CHANGELOG.md) 0.15.20, 0.15.22, 0.15.46, 0.16.0)

## Context

The browser's sandbox walls renderer and GPU processes off from the computer, so a page that exploits
a browser bug is contained. Automation setups often pass `--no-sandbox` for convenience. On Linux,
the browser refuses the sandbox as root and can't start it without user namespaces (containers,
Ubuntu's AppArmor rule), where it needs a root-owned setuid helper a per-user install can't have.

## Decision

- The sandbox is on by default (`browserSandbox: true` in the config defaults; the older name
  `chromeSandbox` still works), for the open build and the native build alike.
- On macOS and Windows it is always on. The sandbox always works there, so nothing needs it off:
  `"browserSandbox": false` and `--no-sandbox` in `browserArgs` (any spelling: `-x`, `/x` on Windows,
  any case, with a value) are refused, named in the helper log and in `pairbrowse_status`. Every
  launch passes the driver `chromiumSandbox: true` and strips any `--no-sandbox` from its switches
  (the native build's persona options and engine pack included). A sandbox failure is the launch's
  error; the helper never retries without it there (0.15.46: the retry had applied on every
  system).
- On Linux it is off only when the user says so (`"browserSandbox": false`, or `--no-sandbox` in
  `browserArgs`), when the helper runs as root, or when a launch fails with a sandbox error. Each
  case is written to the helper log once, and while it's off `pairbrowse_status` and the bar at the
  bottom of the browser's pages warn: "The browser's sandbox is off: websites are less isolated
  from this computer".

## Consequences

- A page exploit is contained as in the user's everyday browser
  ([security.md](../security.md), the notes under the table: "The browser's own sandbox is on by
  default").
- Linux containers and AppArmor-restricted systems still work, with a logged, visible downgrade.
- A macOS or Windows user can't turn the sandbox off, even on purpose; a config that asks is
  refused with a warning rather than failing the launch.
- The "unsupported command-line flag" bar is hidden with `--test-type` so a user-chosen
  `--no-sandbox` doesn't show a warning bar on every start.

## In code

- `scripts/engine.mjs`: `sandboxDecision`, `SANDBOX`, `SANDBOX_FAILED`, `launchEngine` (the Linux-only opt-out and retry)
- `scripts/browser-args.mjs`: `sandboxOffAsked`, `sandboxRefusal`, `withoutNoSandbox`, `ALLOWED["no-sandbox"]` (Linux only)
- `scripts/paths.mjs`: `loadConfig` (the refusal warning)
- `scripts/daemon/serve/tools/status.mjs` `statusLine`, `scripts/daemon/hud.mjs` `setSandboxOff`, `scripts/hud/bar.js` (the warning)
- `scripts/paths.mjs`: config default `browserSandbox: true`
- `scripts/native-engine.mjs`: `captureMacHost` (launches with `chromiumSandbox: true`), `launchNative` (the sandbox option and switches)
- `scripts/browser.mjs`: `launchArgs`
