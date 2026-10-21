# Browser profiles

A browser profile is the set of settings a session's browser starts with: its languages, time
zone, screen, window, light or dark scheme, reduced motion, graphics request, persona seed, saved
card and ad blocker choice, and the network it uses unless the session names one. Each session
runs on one profile; sessions keep their own cookies, storage, logins, extensions, history and
cache apart whatever profile they share. Profiles are kept owner-only in
`~/.pairbrowse/browser-profiles/`, one file per profile with its history beside it. The details
of every key are under `requireValidatedProfiles` in [Configuration](configuration.md).

## The default profile

`default` is read from `config.json` and never written into it: `browser` gives the browser it is
for, the screened `browserArgs` its languages, window, dark scheme and reduced motion, and with
the native browser the `pairbrowse` block its languages, time zone, `geoip`, screen, graphics
backend and seed. A change in `config.json` changes `default` at the next start. A session without
an assignment uses it.

## Making and using profiles

On the sessions page (the browser's All sessions) or with `node scripts/profiles/cli.mjs`:

```
list                                   every browser profile, and which sessions use it
show <profile>                         one profile's settings, history and checks (JSON)
create <name> [--settings <json>]      a new profile (settings left out take the defaults)
edit <profile> [--settings <json>] [--name <new>] [--revision <n>]
retire <profile> | restore <profile>   a retired profile is kept but never assigned or started
assign <session> <profile>             the session starts on the profile from its next start
import <file> [--dry-run] [--source <where from>] [--license <SPDX id|own-capture|unknown>]
export <profile> [<file>] [--with-history] [--include-identity]
validate [<profile>]                   check it on the native build installed now, measuring its graphics
migrate [--report | --undo | --dismiss]
```

`--settings` is JSON, such as `'{"locale":{"timezone":"Europe/Berlin","languages":["de-DE","de"]}}'`
or `'{"graphics":{"backend":"software"}}'`. Agents can only list profiles and pick one for a new
session (`pairbrowse_session` `profiles` and `new` with `profile`); making, changing, importing,
exporting, checking and reassigning are yours.

A session's profile is recorded in its own `assignment.json`, and the session's browser folder is
bound to that profile at its first start: a start on any other profile is refused until you
reassign the session (never one open in a browser), which also drops the persona kept for the old
profile. A profile with a pinned seed is one device to every site, so it runs in one browser at a
time across your instances.

## Import and export

Import takes one file of at most 1 MiB: a PairBrowse export, the engine's collector output or an
engine persona. Only settings are taken (languages, time zone, screen, and a seed); another
device's hardware (GPU, WebGL, WebGPU, fonts, audio, codecs, memory, cores, canvas) is reported
as unsupported and never applied, and a proxy, credentials, launch options or the canvas bridge
are reported and dropped. What the browser in use can't apply is said at import and refused by
name when a session is put on the profile, never found only by a start that fails. An export
carries a SHA-256 over its content, so an edited one is refused on import; `--include-identity`
adds the pinned seed, `--with-history` the revisions.

## Checking a profile

A profile is held to the engine major it was made on; a build of another major refuses to start it
until you check it on the build installed now (`validate`, or Check on the sessions page). What a
check finds is kept with the profile as evidence for that build, never as a new revision.

Graphics are measured once per runtime (build, engine pack, display kind, GPU and driver): the
first start of a profile measures them in a throwaway browser of its own, never in a tab of yours
(a minute or two; an agent asking meanwhile is told so and retries), and `validate` does the same
on the command line. The measurement is checked against what the profile asked for and against
itself (the WebGL strings against the browser process's own backend, the WebGPU adapter, the
canvas, the fonts, the screen, the time zone and languages, the sandbox) and the verdict is kept:

- `validated`: measured on this computer's own graphics, every check matched;
- `consistent`: measured on a computer without a graphics card, where the browser shows pages
  one identity it carries (see [Running on a server](server.md)); every check matched, the identity
  checked for consistency rather than against the host;
- `failed`: a check found a mismatch (the items name it);
- `unverified`: not measured on this runtime yet, or measured with another engine pack.

`pairbrowse_status` names it (`Profile: <name> (rev <n>, <status> on <build>)`, then the graphics
line), and with `requireValidatedProfiles` `true` a session starts only on a profile that is
`validated` or `consistent` for the build and runtime in use. The measurement holds this
computer's renderer and GPU identifiers; they stay in the profile's own file and never reach a
report, a joiner or an agent (which see the kind, the status and, on a computer without a graphics
card, the identity shown, which is the engine's own).

## Moving an older home to profiles

The first start of a version with profiles moves the home once: every kept session is put on
`default`, the engine's persona folder is copied into `engine-profiles/`, and
`browser-profiles/migration.json` records it. `migrate --report` shows what it read, `--dismiss`
hides its notes, and `--undo` (with no helper running) exports every stored profile and puts each
session's files back as they were.
