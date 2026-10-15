# 6. Test switches work only in a helper the test harness started

- Status: Accepted
- Date: 2026-10-15 (commit a25f313, "Helper review fixes: joiner input, test gates, ..."); "Test switches only in the test harness" in the Unreleased notes of [CHANGELOG](../../CHANGELOG.md)

## Context

The helper reads `PAIRBROWSE_TEST_*` variables for its tests: shorter timers, a local stand-in
tunnel, no capture, and test-only tools, among them one that clicks an approval card as a person
would. Claude Code hands a project's `.claude/settings.json` `env` to the plugin, so a project
(or any app that starts the helper) could set those variables and give an agent a way to answer
its own approvals.

## Decision

- Every switch is listed in one table, `SWITCHES`, and read only through `testOn`, `testMs` and
  `testValue`; an unlisted name throws.
- The gate (`applyTestGate`) removes every `PAIRBROWSE_TEST_*` from the environment unless the
  harness started this helper: its `PAIRBROWSE_HOME` is inside the system's temp folder and its
  `runtime` there is a symbolic link, which the harness makes and an installed helper never has.
  A settings file can name variables but can't make that link.
- `scripts/test-gate.mjs` runs the gate on import, and `daemon.mjs` imports it first, before any
  module reads a switch. The plugin's bridge also drops the switches when it starts the helper.

## Consequences

- An installed helper never runs test-only behaviour, whatever environment it inherits
  ([security.md](../security.md), "A project or app turns on the helper's test switches").
- Tests must use the harness's temp home with a linked runtime (`test/helpers/live.mjs`).
- Test-only behaviour in production code is reviewable in one place.

## In code

- `scripts/testenv.mjs`: `SWITCHES`, `harnessStarted`, `applyTestGate`, `withoutTestSwitches`,
  `testOn`, `testMs`, `testValue`
- `scripts/test-gate.mjs` (imported first by `scripts/daemon.mjs`)
- `scripts/launcher/daemon-connect.mjs` (the bridge drops the switches)
