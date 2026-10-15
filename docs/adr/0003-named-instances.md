# 3. Named instances: one home per helper

- Status: Accepted
- Date: 2026-10-16 (commit e9954f9, "Named instances: PAIRBROWSE_INSTANCE or a project's .pairbrowse.json"); "Named instances and coexistence" in the Unreleased notes of [CHANGELOG](../../CHANGELOG.md)

## Context

One helper runs one browser with one profile, and every agent window on the computer shares it.
People want separate browsers side by side: work and personal logins, one per client, a
development build next to the release ([using.md](../using.md#several-browsers-instances)).
`PAIRBROWSE_HOME` already moved the whole home, but it also moved the installs, and a project's
settings could set it to a folder of its choosing.

## Decision

- `PAIRBROWSE_INSTANCE=<name>`, or `"instance"` in a `.pairbrowse.json` in the project folder,
  selects `~/.pairbrowse/instances/<name>`, with its own profile, sessions, config, secrets, facts,
  runs and logs. `PAIRBROWSE_HOME` still wins over both.
- A name is 1 to 32 of `a-z`, `0-9` and `-`; it can only ever select a folder under
  `instances/`. The project file must be a regular file owned by the user, at most 4 KB, read only
  in that folder (no parents). A malformed `PAIRBROWSE_INSTANCE` stops the helper.
- Instances share one read-only install of the runtime, browser apps, engine pack and cloudflared,
  installed one at a time under a lock.
- Each helper records the build it launches in an opener registry, so a browser opened by hand
  reaches its own helper.

## Consequences

- A project can choose among the user's own instances, never an arbitrary folder; a project's
  `PAIRBROWSE_HOME` is ignored ([security.md](../security.md), "A project picks which PairBrowse
  profile the agent uses").
- `pairbrowse_status` and the docks name the instance.
- Home selection must happen before `paths.mjs` loads, so `home.mjs` has no side effects.

## In code

- `scripts/home.mjs`: `resolveHome`, `selectHome`, `projectInstance`, `instanceHome`,
  `validInstance`, `gateProjectEnv`
- `scripts/paths.mjs` (every path under the chosen home)
- `scripts/install-lock.mjs`: `withInstallLock`, `withInstallLockSync`
- `scripts/openers.mjs`: `openersDir`, `recordFile`, `parseRecord`; `scripts/opener.mjs`, `scripts/open.mjs`
