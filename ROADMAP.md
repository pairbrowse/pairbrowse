# Roadmap

What PairBrowse plans for the next year (to late 2027), and what it won't do. Plans change; this
file changes with them, through a reviewed pull request like any change.

## Will do

**Safety**

- Keep every behaviour in the Security table of [docs/security.md](docs/security.md) true, tested
  and fuzzed where it takes untrusted input.
- Run the browser with Chromium's own sandbox where the platform allows it.
- Signed and notarized macOS builds, so Gatekeeper accepts them without the install step's help.
- Raise automated test coverage to at least 80% of statements, and lint the code in CI.

**Platforms**

- Native PairBrowse browser builds for Windows, next to macOS and Linux.
- Keep up with Claude Code and Codex plugin changes, and with new Chromium releases.

**Working together**

- Shared sessions that hold up on slow or changing networks: reconnecting without a new code,
  across two computers on different networks (tested on every release).
- Clearer hand-offs between people and agents in the same browser.

**Project**

- An OpenSSF Best Practices silver badge, and a higher OpenSSF Scorecard.
- Answer issues and security reports within the times in [SECURITY.md](SECURITY.md).

## Won't do

- A TCP debugging port, unrestricted file access, or tools that run arbitrary code in pages
  (run-code, WebMCP).
- Solving CAPTCHAs or bot checks, or integrating solving services.
- Sending what a page shows, what the user types or which buttons they click to another model or
  service to judge it.
- Taking over the user's everyday browser or its profile.
- A headless mode: the browser is always visible to the person it acts for.
