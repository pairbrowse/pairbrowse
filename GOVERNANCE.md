# Governance

PairBrowse is a small project run by its maintainers. This page says who decides what, how changes
get in, and how the project carries on if a maintainer is gone.

## Roles

| Role | Who | Responsibilities |
|---|---|---|
| Owner | [@pairbrowse](https://github.com/pairbrowse) | Holds the repository, its settings and secrets, the GitHub releases and the pairbrowse.com site. Sets direction (the [roadmap](ROADMAP.md)), cuts releases, answers security reports ([SECURITY.md](SECURITY.md)). Also a maintainer. |
| Maintainer | [@pairbrowse](https://github.com/pairbrowse), [@scoutscapital](https://github.com/scoutscapital) | Reviews and merges pull requests (listed in [`.github/CODEOWNERS`](.github/CODEOWNERS)), triages issues, keeps the docs true to the code, enforces the [code of conduct](CODE_OF_CONDUCT.md). |
| Contributor | Anyone | Opens issues and pull requests under [CONTRIBUTING.md](CONTRIBUTING.md). |

AI coding agents (Claude Code, Codex) write some of the changes. They are tools of the maintainer
who runs them: that maintainer is the change's author and answers for it, and an agent never
approves a change.

## How decisions are made

- **Changes.** Maintainers push to `main` or merge pull requests; contributors send pull requests,
  which a maintainer reviews before merging. Tests, lint and CodeQL run on every push and pull
  request, and a failing run is fixed before the next release. `main` can't be force-pushed or
  deleted. Changes are not required to have a second maintainer's review, and OpenSSF Scorecard
  shows that.
- **Day-to-day questions** (a bug fix, a doc change, a small feature) are settled in the pull
  request by the reviewing maintainer.
- **Larger questions** (a new feature area, a change to the security model or the Security table
  in [docs/security.md](docs/security.md), a new dependency, licensing) are discussed in an issue
  first. Maintainers aim for agreement; if they can't agree, the owner decides and writes down why
  in that issue.
- **Fixed rules.** Some things are not up for a vote, because security is the product: no TCP
  debugging port, no unrestricted file access, no run-code or WebMCP tools, no CAPTCHA solver
  ([.claude/CLAUDE.md](.claude/CLAUDE.md)).

## Releases

A maintainer bumps the version in `package.json` and both plugin manifests, adds the
[CHANGELOG.md](CHANGELOG.md) entry and tags `vX.Y.Z` (tags are signed). Native browser builds are
released as `browser-<version>` on the GitHub releases page, checked and attested by the Release check workflow.

## Continuity

The project must keep going if any one person can't continue.

- Two maintainers can review, merge and release. Either can triage and close issues.
- [@scoutscapital](https://github.com/scoutscapital) is the owner account's GitHub
  [successor](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/maintaining-ownership-continuity-of-your-personal-accounts-repositories):
  if the owner can't continue, they can take over the repository and its settings.
- Everything needed to work on the project is public in this repository: code, tests, docs, the
  release and signing workflows. Releases are signed by GitHub Actions (Sigstore), not by a key
  one person holds.
- The owner keeps a written handover (account recovery, the pairbrowse.com domain, the Cloudflare
  account and the release secrets) where the other maintainer can reach it if the owner can't.

## Changing this document

Through a pull request, merged by a maintainer.
