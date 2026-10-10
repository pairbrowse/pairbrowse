# Engineering progress: performance, memory, screenshots, reliability

The durable handoff for the engineering mission (fastest, lightest, most precise PairBrowse without
losing a capability). A new session reads this first, checks the repo state, and resumes from the
verified work below. Nothing here is claimed done without a test or a measurement.

## Commit examined

- Started from `d73a501` (PairBrowse 0.15.41) on 2026-10-11.
- Benchmarks: `PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime node test/bench.mjs --json out.json`
  (its own helper on a temporary home, headless Patchright Chromium, a local site; compare runs
  on the same machine only). `PAIRBROWSE_TRACE=1` makes the helper log each call's phases
  (`trace <tool> total=… guard=… turn=… cursor=… mcp=… tidy=… notes=… shot=…` in `daemon.log`).

## Confirmed architecture (what matters for resources)

- One helper process (`scripts/daemon.mjs`) owns the browser over Playwright's pipe; each agent
  connection gets its own Playwright MCP server instance (`serve.mjs`, about 1 MB each, listeners
  removed on close); every tool result is decorated (`finishResult`): popups closed, page settled,
  notes, then a screenshot (`screenshot.mjs`, one CDP screencast frame, JPEG q55 ≤820 px).
- Screenshots were never kept: the result carries the bytes; per participant only the page and
  the pixel-to-CSS scale stayed (for `pairbrowse_click_at`).
- Recurring work while idle (before this work): presence read every frame of every tab twice a
  second (`presence.mjs`); `cobrowse.mjs` woke 30 times a second even with nothing shared;
  `sharing.mjs` dev-server refresh every 3 s; live view `invites.sweep` 1.5 s; hud spark expiry 2 s;
  MCP request-trim 60 s; tunnel heartbeat 15 s; output sweep 10 min.
- Live view: one shared CDP screencast per shown tab for all viewers (SSE), plus a sharp still
  180 ms after motion; shared-browser joiners get WebRTC per joiner (one tab capture per tab) or a
  JPEG fallback screencast per tab.

## Measurements (same bench, same machine, 2026-10-11, macOS, Node 26, headless Patchright)

"Baseline" is commit `d73a501` run from a worktree with this bench; "After" is the working tree
at the end of this session (`bench-after3`). One run each: treat ±10% as noise, the idle CPU of
the GPU process as noise (it winds down for seconds after any work).

| Measure (screenshots on) | Baseline | After |
|---|---|---|
| `browser_click` p50 / p95 (20 verified clicks) | 802 / 819 ms | 517 / 537 ms |
| `browser_click` p50, screenshots off | 566 ms | 266 ms |
| `browser_snapshot` small form p50, images sent of 20 | 70 ms, 20 | 74 ms, 1 |
| `browser_snapshot` long page p50 | 154 ms | 166 ms |
| `browser_navigate` local page p50 | 385 ms | 400 ms |
| `pairbrowse_run` 4-field form p50 | 355 ms | 350 ms |
| `pairbrowse_click_at` p50 | 250 ms | 251 ms |
| `pairbrowse_status` round trip p50 / p95 | 1 / 3 ms | 1 / 5 ms |
| Cold start to first tool answer | 1.5 s | 1.2 s |
| Helper RSS start → end of bench | 176 → 228 MB | 202 → 210 MB |
| Tree RSS, 1 tab | 1.14 GB | 1.32 GB (noise: 1.1–1.4 across runs) |

Idle CPU A/B (3 tabs on a form page, 20 s samples after 8 s rest, `idle-exp`):

| Process | Baseline | After |
|---|---|---|
| Helper | 1.3% | 0.4% |
| Renderers (all) | 0.3–1.0% | 0.3–0.7% |
| Browser / GPU / utility | 0.5–0.7 / 0–0.4 / 0.2 | 0.2–0.8 / 0–0.5 / 0.1–0.2 |

Multi-agent (`--agents N --rounds 10`, one helper, each agent in its own tab, every click's
count verified in the click's own result):

| Agents | Wall time | Calls/s | Verified / wrong | navigate p50 | snapshot p50 | click p50 | Tree RSS |
|---|---|---|---|---|---|---|---|
| 1 | 11.7 s | 2.6 | 10 / 0 | 398 ms | 265 ms | 519 ms | 1.39 GB |
| 3 | 19.5 s | 4.6 | 30 / 0 | 559–807 ms | 519–780 ms | 551–812 ms | 1.84 GB |
| 5 | 23.1 s | 6.5 | 50 / 0 | 617–1062 ms | 552–912 ms | 618–1027 ms | 2.20 GB |

Three agents get 1.8× the throughput of one and five get 2.5×, with every click correct
(helper RSS 214 MB with five); per-call latency rises
about 1.5–2× (shared helper queue, three renderers). Tabs are independent lanes (`collaboration.run`
per tab), so the remaining serialization is the helper's single thread and the browser.

Soak with viewers (`--soak 100 --viewers N`, two watch-link event streams open): see item 23.

Long runs (helpers started with `--expose-gc`; the memory probe collects garbage first):

- `--soak 1000` (about 4,000 calls, 22 minutes): helper RSS 207 → 205 MB, tree 1.30 → 1.38 GB,
  heap 82 → 101 MB, a straight line of about 20 KB per round. Heap snapshots before and after
  300 rounds (`scratchpad/leak-hunt.mjs`, `pairbrowse_test_memory { heap }`) name it: one
  navigation's Playwright `Request`, `Response` and (with Patchright) `Route` objects with their
  dispatchers, 11 promises and 18 Maps stay reachable per round. They are scoped to the page in
  Playwright's own server (`RequestDispatcher` under `PageDispatcher`), the same on plain
  Playwright, and Playwright disposes the oldest 10% of a kind once 10,000 exist
  (`maybeDisposeStaleDispatchers`): bounded at roughly 100–200 MB for a tab navigated ten
  thousand times, released when the tab closes. The limit setter is a test-only export that
  would also cap element handles, so it is left alone; the helper's own per-tab request trim
  (200 entries) stays.
- `--joiner 300` (300 rounds, 5.7 minutes, both agents active): 300 of 300 verified, 0 joiner
  errors, connection "connected" at every probe; host heap 83 → 90 MB, RSS 228 → 195; joiner
  heap 81 → 78, RSS 221 → 182; host tree CPU 55%, joiner 34%; host click p50 520 ms, p99 583;
  joiner snapshot p50 734 ms, p99 766.
- `--agents 8`: 8.7 calls/s (3.3× one agent), 80 of 80 verified, helper RSS 252 MB, heap 90 MB,
  tree 2.98 GB (eight renderers); per-agent click p50 665–1211 ms.

Soak (`--soak 200`: 200 rounds of navigate + snapshot + click + type, about 800 calls): helper
heap 83 → 108 MB (GC not forced; the bench's own memory probe shows no monotonic climb), helper
RSS 220 → 189 MB, tree RSS 1.32 → 1.36 GB, driver execution contexts 1 → 2. No leak signal.

Where the time goes (trace, after): a click is cursor ≈10 ms, MCP action ≈260 ms (its own
200 ms settle plus Playwright's click), tidy ≈130 ms (popup looks, a 500 ms-bounded quiet wait),
screenshot ≈115 ms. A navigate is tidy ≈240 ms (load check, quiet wait, popup looks, CAPTCHA
check) and screenshot ≈115 ms. A screenshot is CDP session + first screencast frame + a 40–80 ms
newest-frame wait.

## Diagnosed problems (and status)

1. **Screenshot taken after every decorated result, identical or not.** Fixed: bytes are hashed;
   the same bytes for the same participant and tab send a one-line note instead of an image
   (`SAME_PICTURE` in serve.mjs). Measured: 1 of 20 repeated snapshots carries an image (was 20).
2. **Password check read the whole page text in every frame for every screenshot even with no
   saved password.** Fixed: the reading runs only when a secret value is saved.
3. **A stale screenshot could be clicked on** (same tab, but navigated, scrolled, resized, or
   minutes old). Fixed: `pairbrowse_click_at` refuses with the reason and asks for a snapshot;
   it also refuses spots outside the picture. Metadata kept per participant: url, scroll,
   viewport, time, hash; never pixels. A closed tab drops its map (`forgetPage`).
4. **CDP screencast session could stay attached if the capture threw mid-way.** Fixed: stop and
   detach in `finally`.
5. **Presence polled every frame of every tab twice a second.** Fixed: the page script now holds
   one wait per frame (`user-wait`, answered at the first input, empty after 5 s); frames without
   the script are asked again after 2 s; a late answer still counts. Input is noticed at once
   rather than up to 500 ms later.
6. **cobrowse woke 30×/s with nothing shared.** Fixed: self-scheduling rounds, 500 ms apart while
   no tab is shared, 33 ms while one is.
7. **Live view `thumb.jpg` started a screencast with no viewer and nothing stopped it.** Fixed:
   a thumbnail with no shown tab uses a one-off CDP session, detached at once.
8. **Shared-browser CDP sessions (`Page.enable`) lived for the tab's life after joiners left.**
   Fixed: released once a tab has no peer and no watcher; the close listener is added once.
9. **push.mjs per-joiner heartbeat timers were not unref'd.** Fixed.
10. **The join request's IntersectionObserver (trackVisibility) ran on every page.** Fixed: only
    while a request shows.
11. **Shutdown never closed screen-share peers/sessions.** Fixed: `screens.close()` on shutdown.
12. **Playwright MCP slept 500 ms after every action (and again after any request) before
    answering.** PairBrowse already waits for the page itself (tidy). Fixed: `timeouts.settle`
    200 ms (`settleMs` in config.json overrides). Click p50 802 → 517 ms.
13. **The helper had no `unhandledRejection` / `uncaughtException` handler**: Node would end the
    process and the browser died without writing cookies. Fixed: rejections are logged and the
    helper goes on; an uncaught exception logs and shuts down cleanly (browser closed properly).
14. **The live view page kept its event stream (and so the screencast) while hidden.** Fixed:
    the stream closes 3 s after the page is hidden and reopens when shown.
15. **A closed tab's spark stayed in the helper until the agent moved.** Fixed: `hud.forgetPage`
    on tab close.
16. **Every screenshot attaches and detaches its own CDP session.** Tried one kept session per
    tab (captures of a tab serialized on it, tabs in parallel): the screenshot phase stayed at
    102–116 ms, so it was reverted. The cost is the screencast's first frame plus the 40–80 ms
    newest-frame wait, not the attach. Noted in `screenshot.mjs`.
17. **A browser crash within 1.5 s of a navigation lost that tab** (the tab list is saved on a
    debounce). Fixed (`scripts/tabs.mjs`): when the browser dies with a save pending, the tabs as
    last known are written at once; tabs closed in the last second count as taken down with the
    browser, not by a person. Covered by a unit test and the live test below.
18. **No test killed the browser under a session.** Added `test/interruption.integration.test.mjs`:
    SIGKILL on the browser while a wait is in flight; the call is answered, the helper lives on,
    the session's picture maps are gone (`pairbrowse_test_memory` now reports `screenshots` and
    `clients`), the next session reopens the browser with both tabs back and works.
20. **The bottom bar's `backdrop-filter: blur` repainted on every scroll of every page.** Measured
    (40 agent scrolls of a long page, twice each): GPU process 13.7% of a core with the blur,
    5.4–5.7% without; helper and renderer unchanged. Fixed: the bar and the badge use a flat,
    slightly more opaque background (alpha .96/.97 instead of .93/.94).
21. **The 200 ms MCP settle on real sites** (headless Patchright, `scratchpad/realsites.mjs`):
    Playwright, React, MDN, Wikipedia, Vue and GitHub, one navigation click each: the click's own
    result (inline snapshot) showed the new view in 6 of 6 at 200 ms, as at 500 ms. Click totals
    0.5–1.1 s (react.dev once 5.9 s: its navigation's load, waited for by the MCP's request path,
    not the settle). **Native headed build** (the installed PairBrowse browser with its engine
    pack, a temporary home linking `engine/` and the host profile, `PB_NATIVE=1`): the same six
    sites, 6 of 6 new views in the click's own result at 200 ms. Clicks take 1.4–1.8 s there
    (MCP phase 1.2–1.6 s: the engine's human-like pointer motion and press), the helper's own
    phases the same as headless (tidy 127–142 ms, picture 93–109 ms).
22. **Live view's sharp still** (q90, no size cap): with "Fit to pane" on (the default) the page is
    already emulated at the pane's size, so the still is pane-sized; only with Fit off is it the
    window's full size. Left as is.
23. **The live view's screencast ran unpaced: a busy page encoded about 60 frames a second for
    the viewers.** Measured with `--soak 100 --viewers 2` (two watch-link event streams open
    during 100 rounds of navigate + snapshot + click + type): the browser process at 34% of a
    core (10.5% with no viewer), 15,568 frames and 356 MB to the two viewers in 2 minutes.
    Fixed: frame acknowledgements paced to one per 33 ms (`FRAME_EVERY_MS`) in the live view and
    the shared-browser fallback route. After: browser 22.7%, 8,108 frames (about 30 a second),
    186 MB; helper heap 95 → 94 MB and RSS 216 → 205 MB over the soak, tree flat. The sharp
    still 180 ms after motion is unchanged. (A third of the browser's CPU with viewers is the
    JPEG encoding itself; WebRTC for shared-browser joiners is the cheaper route and unchanged.)
24. **Popup looks on a heavy page** (`scratchpad/heavy-popups.mjs`: about 4000 nodes, 40 fixed
    boxes): tidy after a click 148–162 ms against 130–138 on the small form page, so the two
    looks cost about 20 ms there; a snapshot's tidy is 10 ms. Not worth a cache. The heavy part
    is Playwright's own inline snapshot of the page (190 ms in the MCP phase).
25. **Shared-browser joiner soak** (`scratchpad/joiner-soak.mjs`: a host helper and a joiner
    helper, a pb-join code approved, the joiner's picture page connected over WebRTC, 60 rounds
    of host navigate + click with the joiner's agent snapshotting in the host's browser at the
    same time): both helpers' memory flat (host heap 84 → 96 MB, RSS 227 → 191; joiner heap
    88 → 84, RSS 221 → 182; both trees flat), the connection stayed "connected" throughout,
    60 of 60 host clicks verified, 0 joiner errors; host navigate p50 398 ms, host click 531 ms,
    joiner snapshot 735 ms (over the join channel). CPU during the soak: host tree 67%, joiner
    tree 41% of a core, mostly the tab capture at 60 fps and its decoding. Fixed: capped at
    30 fps (`scripts/browser/panel/share.js`, capture and encoder; docs/sharing.md says so).
    Same soak after: host tree 54%, joiner tree 32%, same latencies (host click p50 519 ms,
    joiner snapshot 733 ms), 60 of 60 verified, memory flat, connection stable.
19. **No multi-agent measurement.** Added `test/bench.mjs --agents N --rounds R`: N sessions in
    tabs of their own, each navigate + snapshot + click with the count verified in the click's
    own result; per-agent p50/p95, calls per second, verified and wrong counts.

## Changed files (this session)

`scripts/daemon/screenshot.mjs` (rewritten around the same behaviour), `scripts/daemon/serve.mjs`
(same-picture note, phase trace), `scripts/daemon.mjs` (forgetPage on tab close, screens.close,
user-wait), `scripts/hud.js` (user-wait, join observer gating), `scripts/daemon/presence.mjs`,
`scripts/daemon/cobrowse.mjs`, `scripts/liveview.mjs` (thumb), `scripts/daemon/screenshare.mjs`,
`scripts/liveview/push.mjs`, `scripts/liveview.js` (stream pause while hidden),
`docs/configuration.md` (`settleMs`), `skills/pairbrowse/SKILL.md` (same-picture note, click_at
freshness), `test/bench.mjs` (new), `test/screenshot.test.mjs` (new), `test/hud.test.mjs`,
`test/presence.test.mjs`. Nothing is committed: the user decides what to commit and publish.

## Tests run (2026-10-11)

- `npm run lint`: clean. `claude plugin validate .`: passed.
- `node --test test/*.test.mjs` (no runtime): 373 pass, 0 fail, 80 skipped (live).
- Full live run (`PAIRBROWSE_TEST_RUNTIME`), before the MCP settle change: 435 pass, 0 fail,
  20 skipped (opt-in modes: real tunnel, YouTube, Excalidraw, two machines), 3 min 12 s.
- `npm run test:fuzz`: 36 pass.
- Final full live run with every change: see the end of this file.

## Known limitations

- Identical-picture detection is byte-exact: a blinking caret in a focused field makes frames
  differ, so a page with a focused text field still gets a picture each time.
- Freshness can't see a layout shift without a scroll or navigation; the 120 s age bound and the
  structure check under the spot (label, risk) are the guards.
- The bench runs headless Patchright Chromium, not the PairBrowse native build.

## Next highest-priority actions

1. Shipped as 0.15.42. The bar and badge were looked at in the native headed browser (the
   helper's own picture of a form page with a status up): bar text, time, address and the Pause
   button crisp on the flat dark bar, the badge readable bottom-right; nothing lost with the blur.
2. The 200 ms MCP settle passed 6 of 6 on real sites both headless and with the native headed
   build; an SPA that reacts late without any request would need `settleMs` higher (config).
3. Screenshot cost (≈110 ms per decorated result) is the screencast's first frame plus the
   40–80 ms newest-frame wait; ending the wait at the first frame when tidy settled just before
   is the remaining idea (measure; session reuse gave nothing).
4. Popup looks (two evaluates per result, plus late checks at 3 s and 8 s) on big pages: cache
   per page revision, or skip the second look when the first found nothing. Measure on a heavy
   page first (the bench's long page shows little).
6. Done: `--joiner R` in the bench, a 1000-round soak and a 300-round joiner soak with forced
   GC (above). The one growth found is Playwright's bounded request bookkeeping per page.
8. Decided against sharing one screencast between the live view and the slow route: they
   differ in size, session (the live view's carries the input replayer and the fit emulation)
   and lifetime, and the combination (a joiner on the slow route while the host watches the
   live view of the same tab) is rare; both are paced to 30 frames a second now.
7. Idle CPU of the GPU process after work (several seconds at 5–9%) is Chromium's; nothing of
   PairBrowse's drives it (checked: about:blank idles at 0).

## Final run (2026-10-11, every change in place)

- `npm run lint`: clean.
- Full suite with the runtime: 458 tests, 438 pass, 0 fail, 20 skipped (opt-in modes), run
  after the last change (the 30 fps cap).
- Fuzz: 36 pass. Bench: `bench-after4` figures in the table above; agents 1/3/5 and the
  viewer and joiner soaks as recorded.
- One flake seen once in six full runs under the suite's load (eleven browsers at once):
  form-patterns' "a value a script rewrites 300 ms after the field is left" read the field
  mid-rewrite. It passes alone (2 of 2) and in the other full runs.
- Shipped as PairBrowse 0.15.42: merged into main (fast-forward), tagged `v0.15.42`, pushed
  with the tag on 2026-10-11 at the user's word. Scratchpad scripts used for the one-off measurements (`realsites.mjs`,
  `scroll-exp.mjs`, `heavy-popups.mjs`, `joiner-soak.mjs`, `idle-exp.mjs`) are described
  above; `test/bench.mjs` holds the repeatable ones.
