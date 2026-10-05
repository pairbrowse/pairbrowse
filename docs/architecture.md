# Architecture

How PairBrowse is put together: its parts, how they talk, and where the trust boundaries are. For
what each boundary protects against, see [security.md](security.md) and the
[assurance case](assurance-case.md).

## The parts

```
 Claude Code / Codex                          your computer, your user account
 ┌──────────────────────┐
 │ agent                │  tool call   ┌───────────────┐ private socket ┌──────────────────────────┐
 │  PreToolUse hook ────┼─(guard.mjs)─▶│ launch.mjs    │───────────────▶│ helper (daemon.mjs)      │
 │  PostToolUse hook    │   stdio MCP  │ stdio bridge  │  (in a folder  │  serve: refusal checks,  │
 │  runs MCP server     │◀─────────────│               │   only you open│   policy, secrets        │
 └──────────────────────┘              └───────────────┘                │  context: browser, tabs  │
                                                                        │  hud, panel, output mask │
                                                                        │  sharing, live view      │
                                                                        └──────┬───────────┬───────┘
                                                                 pipe (no TCP  │           │ loopback + key
                                                                 debug port)   ▼           ▼
                                                                  ┌─────────────────┐  ┌───────────────┐
                                                                  │ PairBrowse      │  │ live view     │
                                                                  │ browser         │  │ (127.0.0.1)   │
                                                                  │ (Chromium,      │  └──────┬────────┘
                                                                  │  own profile)   │         │ only when you invite
                                                                  └─────────────────┘         ▼
                                                                                     Cloudflare Quick Tunnel
                                                                                     ─▶ joiners (key + your Allow)
```

- **Plugin manifests** (`.claude-plugin/`, `.codex-plugin/`, `.mcp.json`, `mcp.json`): register the
  `browser` and `runs` MCP servers and the hooks with Claude Code or Codex.
- **Bridge** (`scripts/launch.mjs`): the process the agent app starts. It installs the pinned
  runtime (`runtime/`, from a lockfile, install scripts off) on first use and connects to the
  helper, starting it if needed.
- **Helper** (`scripts/daemon.mjs` and `scripts/daemon/`): one long-running process per user. It
  owns the browser and serves every tool call. Each part is a `createX(deps)` factory:
  `serve` (refusal checks, then a handler table), `context` (browser, sessions, downloads, tabs),
  `presence` (people using the browser), `hud` (badge, bar, cursor), `screenshot`, `output`
  (masking what the agent reads), `panel` (side panel), `sharing` (invites, join codes, tunnel).
- **Policy and secrets** (`scripts/policy.mjs`, `scripts/secrets.mjs`): which tools exist, which
  addresses open, which clicks need the user, where a password may be typed and how it is masked.
- **Hooks** (`scripts/guard.mjs`, `scripts/log.mjs`, `scripts/session-start.mjs`): the PreToolUse
  hook asks the user before final actions; the PostToolUse hook writes the run log; session start
  adds the PairBrowse core instructions. Apps that can't ask (Codex) get the same decisions applied
  by the helper itself.
- **Runs server** (`scripts/runs.mjs`): saved runs and pre-submit reviews, no network.
- **Browser** (`scripts/browser.mjs`, `scripts/native-*.mjs`): a Chromium of its own with its own
  profile under `~/.pairbrowse`, always visible. Builds are pinned by SHA-256 and checked before
  every install.
- **Live view and sharing** (`scripts/liveview.mjs`, `scripts/liveview/`, `scripts/tunnel.mjs`,
  `scripts/devshare.mjs`): a key-protected page on loopback, and, only when the user invites
  someone, a Cloudflare Quick Tunnel that joiners reach with a key and the user's Allow.
- **Side panel and page script** (`scripts/browser/`, `scripts/hud.js`): the extension and in-page
  bar that show people what agents are doing; names and keys are random per run.

## Data and state

Everything lives in `~/.pairbrowse`, created private to the user: the browser profile, saved
details (facts), passwords (a separate file, readable only by the user), runs, logs, downloads.
Nothing is sent to a PairBrowse server; there is none. Network traffic is the user's own browsing,
the pinned downloads (GitHub, npm) and, while sharing, the tunnel.

## Trust boundaries

1. **Agent app → helper.** The agent is trusted to ask, not to decide: every call passes the
   hook and the helper's own checks (allowed tools, navigation, click classes, password domains).
2. **Web page → agent.** Page content is untrusted data. What the agent reads is masked
   (passwords, card numbers) and pages can't reach the helper, the socket or the badge's key.
3. **Other local users and programs → helper.** The socket and files are private to the user; the
   browser has no TCP debugging port.
4. **Joiners → helper.** A joiner needs a key and the user's Allow, gets only what their role and
   mode allow, and is rate-limited.
5. **Downloads → install.** Runtime packages, browser builds and the engine pack are checked
   against pins in this repository before use.
