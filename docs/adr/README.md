# Architecture decision records

Short records of decisions already taken in PairBrowse, each with its context, the decision, its
consequences and where it lives in the code. Their reasons were spread over
[security.md](../security.md), [architecture.md](../architecture.md), [browser.md](../browser.md),
[sharing.md](../sharing.md) and the [CHANGELOG](../../CHANGELOG.md); these records collect them.
A record's date is when the decision was taken (the introducing commit, or the release it is known
by). A new decision gets the next number; a reversed one is marked Superseded and points to the
record that replaces it.

| No. | Title | Status | Date |
|---|---|---|---|
| [1](0001-native-shell-and-own-pages.md) | The native build draws PairBrowse's own UI from ui/ | Accepted | 2026-10-11 |
| [2](0002-approve-role.md) | Joiners can hold an approve role | Accepted | 2026-10-16 |
| [3](0003-named-instances.md) | Named instances: one home per helper | Accepted | 2026-10-16 |
| [4](0004-no-tcp-debugging-port.md) | No TCP debugging port: the browser is driven over a pipe | Accepted | by v0.13.1 (2026-10-04) |
| [5](0005-chromium-sandbox-on.md) | Chromium's sandbox is on, and never dropped quietly | Accepted | 2026-10-07 (v0.15.20), 2026-10-14 (v0.15.46) |
| [6](0006-test-gate.md) | Test switches work only in a helper the test harness started | Accepted | 2026-10-15 |
| [7](0007-pairbrowse-addresses.md) | pairbrowse:// names the browser's own pages, and agents never get them | Accepted | 2026-10-11 |
| [8](0008-dev-build-identity.md) | A development build has an identity of its own | Accepted | 2026-10-16 |
| [9](0009-always-headed.md) | The browser is always headed; there is no headless mode | Accepted | by v0.13.1 (2026-10-04) |
| [10](0010-quick-tunnels-for-sharing.md) | Cloudflare Quick Tunnels carry sharing by default | Accepted | by v0.13.1 (2026-10-04) |
