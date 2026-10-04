# PairBrowse in Codex

PairBrowse is a Codex plugin too, from the same repository (`.codex-plugin/plugin.json`, with the
skill, both MCP servers and the hooks). Needs Codex CLI 0.160 or newer and Node.js 20+.

## Install

```bash
codex plugin marketplace add pairbrowse/pairbrowse
codex plugin add pairbrowse@pairbrowse
```

Then start Codex. If it asks whether to trust PairBrowse's hooks, say yes: they give Codex its
PairBrowse instructions and log what it does. (Paying, publishing and deleting are blocked
either way: PairBrowse itself hands those to you.) If you once added PairBrowse to Codex by hand, also
run `codex mcp remove pairbrowse` so its tools don't show up twice.

Update: `codex plugin marketplace upgrade pairbrowse`, then `codex plugin remove pairbrowse@pairbrowse && codex plugin add pairbrowse@pairbrowse`, and restart Codex.
Uninstall: `codex plugin remove pairbrowse@pairbrowse`.

## How it works in Codex

Codex and Claude
Code share the same helper, browser, logins and Profile, so you can switch between them or run
both at once.

In Codex the tools are `mcp__pairbrowse_browser__*` and `mcp__pairbrowse_runs__*`, approved
without a prompt each time (`"default_tools_approval_mode": "approve"` in
`.codex-plugin/mcp.json`). The rules don't depend on that or on the hooks: the helper enforces
them itself for every app other than Claude Code. Secret domains, navigation limits, blocked code
tools, the upload checks and the pre-submit review hold, and the steps Claude Code would ask you
about (pay, publish, delete, send, an upload of another file type, a page on your local network)
are refused in Codex with a note to hand them to you: you click those yourself in the
PairBrowse window.
