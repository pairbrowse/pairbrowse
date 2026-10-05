# Assurance case

Why we believe PairBrowse meets its security requirements, and where the argument stops. The
requirements and each mitigation in detail are in the Security table of [security.md](security.md);
the parts and boundaries are in [architecture.md](architecture.md).

## Security requirements

PairBrowse drives a browser that is signed into the user's real accounts. It must:

1. Keep that browser to the user and the agents they run: no other user, program or web page can
   drive it, read it or reach the helper.
2. Never let a web page talk the agent into a real commitment (paying, deleting, publishing,
   sending, submitting for review) without the user confirming it.
3. Never expose the user's passwords: not to the agent, not to a page on the wrong domain, not in
   logs or on screen.
4. Never let a page lead the agent outside the web: no local files, browser internals or arbitrary
   code.
5. Share only what the user chose, only with the people they let in, only for as long as they want.
6. Install only the exact software this repository pins.

## Threat model

Attackers we defend against:

- **A malicious or compromised web page**: shows text meant to instruct the agent (prompt
  injection), fakes PairBrowse's own UI, tries to read what was typed, floods downloads.
- **Another local user or program** on the same computer, without the user's privileges.
- **A joiner or someone holding a leaked link or code**: tries to see or do more than their role
  allows, or keeps access after it should end.
- **A network attacker or tampered download**: swaps a runtime package, browser build or engine
  pack.
- **A mistaken agent**: misreads a page and clicks something final.

Out of scope, said plainly in the "Limits, honestly" part of [security.md](security.md): malware already running
as the user, a browser exploit (Chromium currently runs without its own sandbox), and attacks no
software can stop, such as a person the user deliberately let drive their browser.

## Trust boundaries

| Boundary | Crossing | Control |
|---|---|---|
| Agent app → helper | Every tool call | PreToolUse hook (asks the user) and the helper's own checks; blocked tools never exist |
| Web page → agent | Snapshots, page text | Treated as data; passwords and card numbers masked in what the agent reads |
| Web page → helper and badge | Page scripts | No route to the socket; random per-run names and keys for the page script |
| Local users → helper | Socket, files | `~/.pairbrowse` private to the user (0700); no TCP debugging port |
| Joiner → helper | Tunnel requests, WebSocket | 256-bit key, the user's Allow, role and mode checks, rate limits, revocation |
| Internet → install | Downloads | SHA-256 pins in this repository, lockfile, install scripts off |

## Secure design principles applied

- **Least privilege.** The browser has its own profile, not the user's everyday Chrome. Agents get
  no run-code tool; the browser reads files only from its own folder and the project, and key or
  credential files are never uploaded; joiners get only their role.
- **Fail-safe defaults.** A click whose element can't be read counts as final. If the safety hook
  fails it asks rather than allows. Invites expire; watch is the narrowest role.
- **Complete mediation.** Every navigation, click, keypress, upload and password use goes through
  the helper's checks, whichever app sent it (apps that can't ask the user get the same decisions
  in the helper).
- **Economy of mechanism.** Hooks and the helper use only Node's standard library; checks are small
  pure functions (`policy.mjs`, `secrets.mjs`, `liveview/http.mjs`) that are unit-tested and fuzzed.
- **Separation of privilege.** A final action needs the agent to name it *and* the user to confirm
  it; a joiner needs a key *and* the user's Allow.
- **Open design.** Everything except the optional native browser builds is public; security does
  not depend on hidden code. Keys are random, compared in constant time.
- **Psychological acceptability.** Ordinary steps never interrupt; only real commitments ask, so
  questions stay meaningful.

## Common weaknesses countered

| Weakness | Where it would bite | Countermeasure | Evidence |
|---|---|---|---|
| Prompt injection (OWASP LLM01) | Page text steering the agent | Final actions need the user; pages are data | Click guard tests, `guard.test.mjs`, `shared-rules` tests |
| Credential exposure (CWE-522, CWE-532) | Passwords in pages, logs, snapshots | Passwords used by name only, per-domain over HTTPS, masked everywhere | `security.test.mjs`, fuzz: `hostAllowed`, `redact` |
| Open redirect / unsafe navigation (CWE-601) | `javascript:`, `file:`, `chrome:` URLs | Only http(s) and about:blank open | Fuzz: `navigationProblem` |
| Cross-site request forgery / DNS rebinding (CWE-352, CWE-350) | Live view reached from a page | Loopback host and origin checks, key required | Fuzz: `hostOk`, `originOk`, `keyOk` |
| Path traversal (CWE-22) | Uploads, downloads | Uploads checked and copied first, credential files refused; downloads saved under a plain name, never over an existing file | `upload.test.mjs` |
| Race conditions (CWE-367) | Files checked then used | One open file for check and read; create-only writes | CodeQL, fixed findings |
| Supply chain (CWE-494) | Runtime, browser, engine | SHA-256 pins, lockfile, signed release check, VirusTotal | Release check workflow |
| Weak randomness (CWE-338) | Keys, codes | `crypto.randomBytes` / `randomInt` | CodeQL |

## How we know it stays true

- The Security table in [security.md](security.md) is updated in the same change as any behaviour
  it describes ([CONTRIBUTING.md](../CONTRIBUTING.md)), and changes are reviewed by a second
  maintainer.
- On every push and pull request: unit tests, property-based fuzzing of the security checks
  (`test/fuzz/`), and CodeQL (security-extended). Live browser tests run before releases.
- Releases: native builds checked against their pins and attested in Sigstore's public log;
  dependencies watched by Dependabot.
