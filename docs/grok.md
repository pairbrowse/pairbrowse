# PairBrowse in Grok

Grok (the Grok CLI) loads Claude Code plugins by itself, so PairBrowse needs no Grok plugin of its
own: install it in Claude Code and Grok uses the same install. Needs Node.js 20+.

## Install

```bash
claude plugin marketplace add pairbrowse/pairbrowse
claude plugin install pairbrowse@pairbrowse
```

Then start Grok. `grok inspect` lists the plugin `pairbrowse` with its MCP servers `browser` and
`runs`, its skills and its hooks. (`grok plugin list` and `grok mcp list` don't show plugins Grok
reads from Claude Code; `grok inspect` does.)

Don't add PairBrowse to Grok a second time (as a Grok plugin or an MCP server of its own): a
second copy starts `browser` and `runs` again, and every tool shows up twice.

## How it works in Grok

Grok, Claude Code and Codex share the same helper, browser, logins and Profile: the same
`scripts/launch.mjs`, the same private socket, the same browser profile. You can switch between
them or run them at once; each agent has its own tab, its own cursor and its own color (Grok's is
silver).

- **Tools** are named `browser__<tool>` and `runs__<tool>` in Grok (`browser__pairbrowse_run`,
  `browser__browser_click`, `runs__run_save`).
- **Instructions.** Grok's SessionStart hook is observe-only (nothing printed there reaches the
  model); only tool hooks' `additionalContext` does. So PairBrowse gives Grok its core, worded for
  Grok, with the first PairBrowse tool result of each Grok session (a PostToolUse hook on
  `browser__*` and `runs__*`; the hook tells Grok from Claude Code by `GROK_HOOK_EVENT`, which Grok
  sets on every hook). Until that first result, the skills carry the rules as in Claude Code.
- **Where you watch.** The PairBrowse browser window: there is no dock beside Grok
  (`pairbrowse_dock` is Claude Code's, on macOS).
- **Confirms.** The plugin's guard hook matches Claude Code's and Codex's tool names, not
  Grok's, so the helper applies the same rules itself, as it does for every app other than Claude
  Code: what is blocked stays blocked (secret domains, navigation limits, the blocked code tools,
  the upload checks, the pre-submit review). What Claude Code would ask you about asks you once,
  on an approval card in the PairBrowse window, and the call waits up to two minutes for your
  answer: a named final click (pay, delete, publish, send, submit), a page on your local network
  or this computer, a session delete, a drive or approve invite, letting a join request in, an
  upload of another file type. Allow lets it go on. Deny, "I'll do it myself", or no answer hands
  the step to you: Grok sets its badge to "you" and says what to click or open. When no card can
  show (another person is looking at the browser, the agent has no tab yet) the step is handed to
  you at once.
- **Status.** `pairbrowse_status` kind `agent` while working (`claude` is the same, for any app),
  `you` for your turn, `done`, `clear`.

See [using.md](using.md) for the tools and [security.md](security.md) for every rule.
