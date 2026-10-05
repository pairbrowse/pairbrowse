# Contributing to PairBrowse

Thanks for helping. PairBrowse has two parts, and changes go to the one they belong to.

| You want to change | Where | License |
|---|---|---|
| The plugin and helper: forms, fast mode, guards, side panel, live view, hooks, skill, docs | This repository | MIT |
| The PairBrowse browser itself: browser patches, build pipeline, packaging | The private PairBrowse Pro repository | PairBrowse Binary License |

## This repository (public)

Anyone can contribute here. By sending a change you agree it's licensed under the MIT License in
`LICENSE`, and you certify the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote it or otherwise have the right to submit it. Sign off each commit (`git commit -s`).
How the project is run is in [GOVERNANCE.md](GOVERNANCE.md); everyone follows the
[code of conduct](CODE_OF_CONDUCT.md).

Before you send it:

- Read `.claude/CLAUDE.md`. Security is the product: no debugging port, no unrestricted file access, no
  run-code or WebMCP tools, no CAPTCHA solver. If your change alters behaviour described in the
  Security table in `docs/security.md`, update the table in the same change.
- Hooks and the helper use only Node's standard library. New runtime dependencies go in
  `runtime/` with a regenerated lockfile.
- Fixes should be general: no lists of particular sites or words. Check them live on several real
  sites, and say which ones in your change.
- New behaviour comes with tests, and a fixed bug with a test that fails without the fix
  (`test/*.test.mjs`; checks on untrusted input also get a property in `test/fuzz/`).
- Run the checks:

  ```bash
  npm test
  PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime npm test   # also the live browser tests
  npm ci && npm run test:fuzz                              # fuzzing of the security checks
  claude plugin validate .
  ```

- Never include anything from `~/.pairbrowse` (profiles, passwords, saved details, runs, logs).

## The browser (PairBrowse Pro)

PairBrowse Pro members can become contributors to the private browser repository. Contributions
there need the PairBrowse contributor agreement first: it lets the copyright holder ship your
change in PairBrowse builds. Every browser change is reviewed before it goes into a build, because
the browser holds its users' logins.

## Contributor revenue share

PairBrowse should reward the people who materially help build it. **20% of PairBrowse Pro
revenue will go to a contributor rewards program.** Eligible work includes features, bug fixes,
integrations, browser improvements, performance and security work, testing, documentation,
design, architecture, maintenance, and work that enables or materially improves PairBrowse Pro.
The accounting, payout schedule, eligibility, minimum thresholds and distribution formula will be
published before paid distributions begin.

- **Private contribution reports.** Claude Code may help maintainers review merged work and write
  private reports (technical impact, complexity, quality, security and maintenance value, user
  impact, relevance to Pro). They are advisory and never published: there are no public rankings
  or scores, and payouts stay subject to maintainer review and the published rules.
- **Reviews and complaints.** If you think an assessment or payout missed something, ask for a
  private review and add context, related work or evidence of impact. A maintainer reviews it and
  may revise the assessment; AI-generated reports can always be corrected or overridden.
- **Public work, private Pro.** A public contribution may enable features later built in the
  private Pro repository (for example, a public session-reconnect fix that enables managed
  session recovery). Maintainers may count that link when assessing rewards, and can explain it
  to you privately without exposing Pro source, customer data or other confidential details.

## Reporting a security problem

Please don't open a public issue. See `SECURITY.md`.
