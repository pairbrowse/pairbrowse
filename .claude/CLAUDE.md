# PairBrowse

A Claude Code and Codex plugin: Claude (or Codex) fills web forms in the PairBrowse browser (Playwright's Chromium, a
persistent, visible window the user can watch and step into; inside the Claude desktop workspace
through the live view, docked or in the Browser pane).

## Layout

- `.claude-plugin/`: Claude Code plugin and marketplace manifests. `.mcp.json`: the `browser` and `runs` MCP servers. `.codex-plugin/plugin.json` + `mcp.json`: the Codex plugin (servers `pairbrowse_browser`, `pairbrowse_runs`); Codex also reads `hooks/hooks.json`. Keep both manifests' versions equal.
- `scripts/launch.mjs`: stdio bridge Claude Code runs; installs the pinned runtime and starts or reconnects to the daemon.
- `scripts/daemon.mjs`: the helper's entry point and composition root. It owns the browser (Playwright persistent context over a pipe), serves one session over a private socket, enforces `scripts/rules/policy.mjs` and secret domains (`scripts/rules/secrets.mjs`). Its parts live in `scripts/daemon/`, each a `createX(deps)` factory: `serve.mjs` (tool calls, one connection per agent; its parts in `serve/`: `connection.mjs` its state, `wire.mjs` tool sets and message checks, `turns.mjs` its tab and turns, `refuse.mjs` refusal checks, `rewrite.mjs` a call's way to the browser server, `tools/` its own tools by family, `collaboration.mjs`, `result.mjs` each result, `pageread.mjs`), `context.mjs` (the browser facade over `browser/` (state, launch, tabs, downloads) and `sessions/` (picker, switch)), `follow.mjs` (joining someone else's session; its parts in `join/`: state, hosts (the join-host allowlist), agents (remote agent calls), screens (shared browser picture pages), mirror (follow mode)), `board.mjs` (who does what across a shared session, messages), `toolstab.mjs` (the Tools tab), `presence.mjs` (people using the browser), `hud.mjs` (badge, bar, spark, cursor), `screenshot.mjs`, `drag.mjs` (browser_drag as a hand does it), `output.mjs` (masking what Claude reads, main-frame refs plain), `panel.mjs` (side panel), `sharing.mjs` (invites, join codes; `tunnel-pool.mjs` the sharing tunnels), `page.mjs` (in-page helpers).
- `scripts/liveview.mjs` + `scripts/liveview/` (request checks and the one body reader in `http.mjs`, invites, input replay, joiners' masked frames and server): key-protected local live view with input passthrough. `liveview.mjs` keeps the streams, the shown tab and joiners and dispatches; its routes live in `scripts/liveview/routes/` (`viewer`, `owner`, `sessions`, `pages`, `timeline`, `tools`), each a `{ method, path, right, needs?, handler }` table. Every event it sends is listed in `ui/events.js` with who gets it. The page is `liveview.html` + `.css` + `.js`, served from a fixed allowlist under a strict CSP; code it shares with the side panel is in `ui/common.js`.
- `scripts/sharing/`: the joiner's and the host's sharing code: `join.mjs` (join codes, the join-host allowlist, approvals, name and text cleaning), `join-client.mjs` (the joiner's connection to a host, moving to a standby tunnel when one goes down), `sharing/tabsync.mjs` (what crosses to joiners: tabs, forms, order, pointers), `sharing/devshare.mjs`.
- `scripts/sharing/devshare.mjs`: sharing a localhost dev server with joiners (`pairbrowse_invite` `share_port`): its own Quick Tunnel (`scripts/tunnel.mjs`) to a proxy that checks each joiner's key and rewrites Host/Origin to localhost; tabs on it cross as that address (`sharing/tabsync.mjs` `mapUrl`).
- `scripts/browser.mjs` + `scripts/browser/` (icon files; the extension's pages are in `ui/`, its root during the bridge period; colors are Chromium's own color theme set in the profile): the PairBrowse browser: on macOS a pinned ungoogled-chromium build (version + SHA-256 in `browser.mjs`, branded into `~/.pairbrowse/browser/PairBrowse.app`, profile button hidden; `PairBrowse Chromium.app` when a native build is installed), elsewhere Playwright's Chromium. `scripts/hud.js`: in-page badge, bottom bar and the spark on Claude's tab icon. Always headed; there is no headless mode.
- `ui/`: the browser's own pages, loaded as the side panel extension during the bridge period: `tokens.css` (the one sheet), `common.js` (shared with the live view), `manifest.json`, `background.js` (the worker), `logo.svg`, icons, and one directory per page (`newtab/`, `picker/`, `screen/`, `capture/`, `right/`), each an `index.html` with its own css/js.
- Native builds (the private PairBrowse Pro repo, `../pairbrowse-native`, builds them; `BINARY-LICENSE.md` is their license). `scripts/native-pack.mjs`: `NATIVE` pins each platform's build (sha256 null = none yet) and the engine pack, all downloaded from the public GitHub release `browser-<version>`; the engine pack (launch switches, humanized input, host collector) is checked by archive and per-file SHA-256 before every load. `scripts/native-install.mjs`: install step, `nativeLayout()` picks the build for this platform and chip; SHA-256, manifest platform/arch, on macOS signature + branding (`scripts/macos-app.mjs`), swap with rollback, profile prep, then `scripts/native-check.mjs` (launch self-check). `scripts/native-engine.mjs`: launch adapter (settings under `"pairbrowse"` in config). Never name the third-party project the engine pack and patches come from in this repo.
- `scripts/guard.mjs` (PreToolUse), `scripts/log.mjs` (PostToolUse), `scripts/session-start.mjs`: hooks (Claude Code and Codex). Codex accepts only `deny` from PreToolUse, so the daemon applies `decide()` itself for every client other than `claude-code`.
- `scripts/rules/`: the rules every client is held to, pure and stdlib-only: `decide.mjs` (the guard's verdicts; `guard.mjs` is the hook around it), `clicks.mjs` (click classes, clickRule, dialogRule), `policy.mjs` (blocked tools, navigation, masking), `secrets.mjs` (secret domains), `upload.mjs` (which files upload), `network.mjs` (local-network addresses).
- `scripts/core.md`: the always-on PairBrowse core that `session-start.mjs` adds to every session (worded for Claude Code or Codex by `scripts/surface.mjs`). Keep it compact (size and tool names are tested).
- `scripts/runs.mjs`: dependency-free MCP server for saved runs and pre-submit reviews.
- `scripts/runner.mjs`: fast mode (`pairbrowse_run`) and playbooks. `scripts/sessions.mjs`: browser sessions. `scripts/tabs.mjs`: tab memory and the "Opening tabs" restore.
- `scripts/display.mjs`: private virtual screen (Xvfb) for a Linux machine without a screen.
- `scripts/util.mjs`: shared helpers (JSON files, SHA-256, pinned downloads, timeouts); use them rather than local copies. `within(ms, promise)` resolves `null` when the time is up (callers handle null); every await on a page (evaluates on element handles, key presses, locator reads) must be bounded: a page whose scripts never pause answers nothing.
- `runtime/`: pinned `@playwright/mcp` with lockfile, installed with `npm ci --ignore-scripts`.
- `skills/pairbrowse/SKILL.md`: the reference behind the core (tool details, edge cases). The step-by-step task skills (`pairbrowse-signup`, `-listing`, `-test-site`, `-together`) sit next to it in `skills/`; `scripts/validate-skills.mjs` (run by `test/skills.test.mjs`) checks every skill names only real tools.

## Checks

```bash
npm test                      # live tests: PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime
                              # native launch tests: PAIRBROWSE_TEST_ENGINE=~/.pairbrowse/engine
                              # shared browser mode, opt-in: PAIRBROWSE_TEST_REAL_TUNNEL=1, PAIRBROWSE_TEST_YOUTUBE=1, PAIRBROWSE_TEST_EXCALIDRAW=1,
                              # PAIRBROWSE_TEST_EXECUTABLE=<PairBrowse browser>, PAIRBROWSE_TEST_DOCKER=1 (two machines)
npm ci && npm run lint        # ESLint (eslint.config.js), no warnings; CI runs it
npm run test:fuzz             # fast-check fuzzing of the security checks (test/fuzz/*.test.js: .js so Scorecard sees it)
claude plugin validate .
# Codex: install into a throwaway CODEX_HOME (codex plugin marketplace add . && codex plugin add pairbrowse@pairbrowse)
```

## Rules

- Security is the product. Don't add a TCP debugging port, unrestricted file access, the
  run-code or WebMCP tools, or a CAPTCHA solver. Keep the Security table in `docs/security.md` true: update
  it in the same change as any behaviour it describes.
- Hooks and the daemon use only Node's standard library; new runtime dependencies go in
  `runtime/` with a regenerated lockfile.
- A version bump (package.json and both plugin manifests) also adds its entry to `CHANGELOG.md` and an
  annotated tag `vX.Y.Z` on that commit, pushed with it.
- Never commit anything from `~/.pairbrowse` (profile, secrets, facts, runs, logs).
