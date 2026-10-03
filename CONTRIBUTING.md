# Contributing to PairBrowse

Thanks for helping. PairBrowse has two parts, and changes go to the one they belong to.

| You want to change | Where | License |
|---|---|---|
| The plugin and helper: forms, fast mode, guards, side panel, live view, hooks, skill, docs | This repository | MIT |
| The PairBrowse browser itself: browser patches, build pipeline, packaging | The private PairBrowse Pro repository | PairBrowse Binary License |

## This repository (public)

Anyone can contribute here. By sending a change you agree it's licensed under the MIT License in
`LICENSE`.

Before you send it:

- Read `CLAUDE.md`. Security is the product: no debugging port, no unrestricted file access, no
  run-code or WebMCP tools, no CAPTCHA solver. If your change alters behaviour described in the
  README's Security table, update the table in the same change.
- Hooks and the helper use only Node's standard library. New runtime dependencies go in
  `runtime/` with a regenerated lockfile.
- Fixes should be general: no lists of particular sites or words. Check them live on several real
  sites, and say which ones in your change.
- Run the checks:

  ```bash
  npm test
  PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime npm test   # also the live browser tests
  claude plugin validate .
  ```

- Never include anything from `~/.pairbrowse` (profiles, passwords, saved details, runs, logs).

## The browser (PairBrowse Pro)

PairBrowse Pro members can become contributors to the private browser repository. Contributions
there need the PairBrowse contributor agreement first: it lets the copyright holder ship your
change in PairBrowse builds. Every browser change is reviewed before it goes into a build, because
the browser holds its users' logins.

## Reporting a security problem

Please don't open a public issue. See `SECURITY.md`.
