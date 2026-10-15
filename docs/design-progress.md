# Design progress: the collaborative browser interface

The durable handoff for the design mission (the dark navy collaborative browser: optional
workspace navigation, agent panel, agent cursors, contextual approvals, session controls, a
hidden-by-default timeline; Focus, Collaborate and Inspect modes). The rule above every other:
nothing of 0.15.42's measured performance, security or behaviour regresses (its numbers are in
`docs/engineering-progress.md`; the bench is `test/bench.mjs`). The logo is never changed.

File names in the entries below are as they were on their date: the side panel's `panel.html`,
`panel.css` and `panel.js` are now `ui/right/` (`index.html`, `right.css`, `right.js`), and the
other extension pages sit in `ui/<page>/` (`ui/newtab/`, `ui/picker/`, `ui/screen/`, `ui/capture/`).

## Git state

- Started 2026-10-11 from `da3fb9f` (0.15.42 shipped on main, working tree clean).
- Work goes on branch `design/collaborative-browser`, in reviewable commits; merge, push and
  the version bump at the user's word.

## Baseline (0.15.42, same bench, same machine; see engineering-progress.md for every number)

| Measure | 0.15.42 |
|---|---|
| Helper idle CPU, 3 tabs | 0.4% of a core |
| GPU process while the agent scrolls a long page | 5.5% |
| Click p50 (verified, screenshots on) | 517 ms |
| Snapshot small page p50 | 65–74 ms, 1 image in 20 repeats |
| Navigate local page p50 | ~390 ms |
| Cold start to first answer | 1.2 s |
| Helper RSS / tree RSS, 1 tab | ~205 MB / 1.1–1.4 GB |
| Soak 1000 rounds | helper flat; heap +20 KB/navigation (Playwright's own, bounded) |

Acceptance for this mission: each of these within noise (±10%, idle CPU +0.2 points at most),
no new timer or observer that runs while a panel is hidden, no new screenshot anywhere, no new
process, no new runtime dependency.

## The reference, read closely (Phase 2)

The mockup is a fully expanded workspace. Element by element, with where it lands in PairBrowse:

**Window and chrome.** Deep navy frame; a top row with the logo + "PairBrowse ⌄" (workspace
switcher), the tab strip (active tab a lighter navy surface with favicon, title, an orange dot
for the agent that owns it, ×; inactive tabs darker), "+", then at the right a "● Live session"
pill, an avatar stack (C orange, G purple, Y green, +2), "Share", "⋯". A second row: back,
forward, reload, the address pill with a lock, star, search and a sparkle. In PairBrowse the
window is Chromium's own: the colors come from the color theme set in the profile
(`scripts/browser.mjs`), and the tab strip and toolbar can't take new buttons from the plugin
(the one extension button is the side panel's). So: the palette moves to navy through the
theme; tab ownership stays the spark on the tab icon (`scripts/hud.js`, already in the agent's
color); the "Live session" pill, avatar stack and Share live in the side panel header and the
bottom bar, not in the toolbar.

**Left workspace sidebar.** "Workspace" header; Browser (count), Sessions, History, Activity,
Tools; "Agents +" with Claude Code (Active · 2 tabs), Codex (Idle), Gemini (Working), You
(Online); "Shared with +" (Team 3 online, Client 1 online); a storage meter. Chromium has one
side panel, right or left (`side_panel.is_right_aligned`); PairBrowse's panel is that panel.
The mockup's two columns become one panel with sections, and the live view page (the Claude
desktop workspace) is where the expanded two-column workspace can exist in full. "History" is
Chromium's own; "Storage" has no PairBrowse meaning (dropped). "Agents" and "Shared with" are
real (participants, invites, joiners).

**Agent cursors.** Orange "Claude" pointer with a label pill at the field it edits (the field
outlined in its color), purple "Codex" at another field, blue "Gemini" elsewhere. PairBrowse has
the agent cursor and peers' pointers in `scripts/hud.js`: refine geometry, the label pill in the
participant's color, the edited field's outline (the "targets"/"press" declaration knows the
box), no glow, no trail.

**Contextual approval.** A card anchored bottom-right over the page: avatar, "Claude Code wants
to click", the target "Continue →" as a chip, one sentence of consequence, Allow (primary blue),
Deny, "More actions ⌄", ×. In PairBrowse the agent's final-action confirmations happen in the
coding app (the guard hook), never in the page; what the page does ask is the join request
(Allow / Deny in the bottom bar) and the dev-server share question in the panel. Those become
the card. Nothing new auto-approves; nothing moves a confirmation out of the coding app.

**Bottom activity bar.** "● Claude is driving" then step chips: ✓ Filled workspace name,
✓ Filled email, ○ Selected use case, ⋯ Clicked Continue, "⋯". PairBrowse's bar exists
(`scripts/hud.js`: who's driving, the last four actions, Pause agents, the join request). It
becomes the chips: done / current / pending from the goal log's own lines, never invented.

**Right agent panel.** Tabs Agent | Page | Screenshots | Tools; the active agent's card (avatar,
name, "● Working…", Pause, collapse); "Current task"; a checklist (done ✓, current ◉, pending
○); "Live reasoning"; other participants as compact rows (Codex "Observing" with "Take
control", Gemini "Helping · Suggesting inputs", You "Active"); a session card (name, "Saved
2 min ago", Save, Share, End session). PairBrowse's side panel has statuses, activity, the
board, sessions, invites, join requests, dev servers, profile. Refine into these cards. Not
copied: "Screenshots" as a tab (pictures are never kept: the policy stands), "Live reasoning"
(no model thoughts exist; the agent's own `pairbrowse_status` text is shown as its status, named
as such), "Take control" as a one-click (the real controls are Pause agents, and a person simply
using a tab; acquire/release are agents' tools).

**Modes.** Focus: the page, the spark on tabs, the small badge only when a status is set, no
panel. Collaborate: the side panel open with the agent cards, cursors, the bar. Inspect: the
live view page (tabs overview, activity, board, session, diagnostics) and the goal log as the
timeline. Mode = which of these are open; no browser restart, no reload, no new picture.

## Surfaces (Phase 1 map)

The full map (six surfaces: chrome, side panel, in-page script, live view, the extension pages,
the state the UI could show; who renders each, state sources, update mechanism, styling,
constraints, the tests that pin them) is `docs/design-surfaces.md`, written by the
`design-understand` workflow at `da3fb9f`. Its classification of the mockup:

| Mockup element | Surface | Classification |
|---|---|---|
| Deep navy frame, tab strip, toolbar colors | 1 chrome | REFINE: `THEME_COLOR` `scripts/browser.mjs`; next start; user theme wins `profilePreferences()` |
| Logo + "PairBrowse ⌄" switcher in the toolbar | 1 chrome | UNSUITABLE in chrome; function EXISTS as Switch session (`ui/right/index.html` `#switch-btn`) and picker (surface 5); logo unchanged |
| Active/inactive tab surfaces | 1 chrome | EXISTS (Chromium's derivation); not per-element |
| Orange owner dot on a tab | 3 hud | EXISTS: tab icon spark `scripts/hud/spark.js` `sparkIcon()`, `scripts/daemon/hud.mjs` `tabIcon()` |
| "+", ×, back/forward/reload, address pill, lock | 1 chrome, 4 live view | EXISTS (Chromium; `scripts/liveview.html` `#tabs`, `#newtab`, `#state`, `#state-text` and more) |
| Star, search, sparkle buttons | 1 chrome, 4 live view | UNSUITABLE (no toolbar slots; no state) |
| "● Live session" pill | 2 panel, 3 hud, 4 live view | REFINE: `ui/right/right.js` `collaboration` listener, bar who line `scripts/hud/bar.js` `drawBar()`, `scripts/liveview.js` `renderCollaboration()`; fed by `collaborationNow` `scripts/liveview.mjs` |
| Avatar stack (C, G, Y, +2) | 2 panel, 4 live view | REFINE: board people `ui/right/right.js` `board` listener, guests `scripts/liveview.mjs` `startLiveView()`; colors `SPARK_COLORS` `ui/vocab.js` |
| Share button | 2 panel, 4 live view | NEW: needs an owner-only route for invites (`scripts/daemon/sharing.mjs` `codeOf()`, no event today); security table entry |
| "⋯" toolbar menu | 1 chrome | UNSUITABLE |
| New tab page in navy | 1 chrome / 5 | REFINE: `newtab.css`; drop `ntp.png`; `addressToUrl` unchanged |
| Left sidebar: Workspace header | 4 live view | NEW (Inspect layout), fed by `tabs`, `board`, `collaboration` |
| Left sidebar: Browser (count) | 2 panel, 4 live view | NEW listener in `panel.js` / `scripts/liveview.js` `tabs` listener; event already sent `scripts/liveview/routes/viewer.mjs` `events()`, `scripts/liveview.mjs` `refreshTabs()` |
| Left sidebar: Sessions | 2 panel, 5 picker | EXISTS: Switch session, picker (`scripts/daemon/sessions/picker.mjs` `showPicker()`, `reopenPicker()`) |
| Left sidebar: History | any | UNSUITABLE (Chromium's own) |
| Left sidebar: Activity | 2 panel, 4 live view | EXISTS: `ui/right/index.html` `#collaboration`, `#activity`, `scripts/liveview.html` `#driver`, `#driver-who`, `#who-filter`, `#activity` |
| Left sidebar: Tools | 2 panel, 4 live view | NEW static list, no state |
| Left sidebar: Agents (Active · 2 tabs, Idle, Working) | 2 panel, 4 live view | REFINE: board entries `scripts/daemon.mjs` `localEntries()`, `ui/right/right.js` `board` listener; tab counts from `tabs` |
| Left sidebar: Shared with (Team, Client) | 2 panel, 4 live view | REFINE: `collaboration.guests` `scripts/liveview.mjs` `startLiveView()`, approvals `open()` `scripts/sharing/join.mjs` |
| Left sidebar: storage meter | any | UNSUITABLE (no meaning) |
| Agent cursor with label pill (Claude) | 3 hud | EXISTS `scripts/hud/cursor.js` `motion`, `CURSOR_MOTION`, `fittsA`, `fittsB` and more; REFINE geometry, pill, no glow/trail |
| Several agents' cursors at once (Codex, Gemini) | 3 hud | EXISTS for joiners' agents as peers `scripts/hud/pointers.js` `peersHost`, `peersBox`, `peersFrame` and more; NEW per-agent cursor for this helper, fed by `cursor` calls' `who`/`color` `scripts/hud/status.js` `kind === "cursor"` |
| Edited field outlined in the agent's color | 3 hud | NEW inside the cursor shadow root, fed by `targets` `scripts/hud/status.js` `kind === "targets"`, `press` `kind === "press"`, `owned` `scripts/hud/fields.js` `fields()` |
| Approval card: join request Allow/Deny | 3 hud, 2 panel, 4 live view | EXISTS `scripts/hud/join.js` `JOIN_SHOWN_MS`, `JOIN_ARM_MS`, `JOIN_KEEP`, `joinSeen` and more, `ui/panels.js` `joinBanners()`; REFINE into a card inside `barHost`, gating kept (`ui/common.js`; `ui/panels.js` `joinBanners()`) |
| Approval card: dev-server share question | 2 panel | EXISTS `ui/panels.js` `devPanel()`; REFINE layout |
| Approval card: "Claude Code wants to click … Allow" | page | UNSUITABLE: confirmations stay in the coding app (guard hook) |
| Approval card: "More actions ⌄" | 3 hud | UNSUITABLE |
| Bottom bar "● Claude is driving" | 3 hud, 4 live view | EXISTS `scripts/hud/bar.js` `drawBar()`, `scripts/liveview.js` `allActivity`, `whoFilter`, `seenWho`, `filterEl` and more |
| Bottom bar done chips | 3 hud, 4 live view | REFINE from bar `items` `scripts/daemon/hud.mjs` `applyBar()` and `activity` |
| Bottom bar current/pending chips | 3 hud, 4 live view, 6 state | NEW payload fields via `applyBar` `scripts/daemon/hud.mjs`, fed by the journal `scripts/daemon/journal.mjs` `open()`; payload shape kept (`scripts/native/check.mjs` `checkBottomBar()`; `scripts/hud/bar.js` `setBar()`) |
| Pause agents / Resume | 3 hud, 2 panel | EXISTS `scripts/hud/bar.js` `ensureBar()`, `scripts/hud/bar.js` `pz` `mousedown` and `click` listeners, `ui/right/right.js` `click` listener |
| Right panel tabs Agent / Page / Tools | 2 panel | NEW section tabs in `panel.html`, no new state |
| Right panel tab Screenshots | 2 panel | UNSUITABLE (pictures never kept) |
| Active agent card (avatar, name, state, Pause, collapse) | 2 panel, 4 live view | REFINE: driver line `ui/right/right.js` `setDriver()` + pause `pause` listener + first board entry `board` listener |
| "Current task" | 2 panel, 4 live view | EXISTS: board `task` (`scripts/daemon.mjs` `localEntries()`; `scripts/daemon/board.mjs` `setStatus()`) |
| Checklist (done / current / pending) | 2 panel, 4 live view, 6 state | NEW: owner-only journal event/route (`scripts/daemon/journal.mjs` `open()`, file-only today `scripts/daemon/journal.mjs`) |
| "Live reasoning" | 2 panel | UNSUITABLE as named; REFINE: `pairbrowse_status` text shown as the agent's status, named as such |
| Other participants rows (Observing, Helping, Active) | 2 panel, 4 live view | REFINE: Session people list `ui/right/right.js` `board` listener; "Helping · Suggesting inputs" has no state |
| "Take control" | 2 panel | UNSUITABLE (`scripts/tools/catalog.mjs` `COLLABORATION_TOOL` are agents' tools; presence `scripts/daemon/presence.mjs` `personIn()`, `actingIn()`, `actedIn()`, `filledIn()` and more) |
| Session card: name, where | 2 panel, 4 live view | EXISTS `ui/right/right.js` `session` listener, `scripts/liveview.js` `session` listener |
| Session card: "Saved 2 min ago" | 2 panel, 6 state | NEW from journal `updatedAt`, same transport as the checklist |
| Session card: Save | 2 panel | EXISTS as Record (`ui/right/right.js` `drawRecord()`, `click` listener) for a recording; the run file saves itself (`scripts/daemon/journal.mjs` `schedule()`); a "Save" that copies the run is NEW via `runs.mjs` route, owner only |
| Session card: Share | 2 panel | NEW (see Share) |
| Session card: End session | 2 panel | UNSUITABLE as one-click; Switch session / picker are the controls |
| Hidden-by-default timeline | 4 live view, 6 state | NEW drawer like `#drawer` (`scripts/liveview.css` `.drawer` rule, `.drawer[data-open="true"]` rule), loads on open, fed by the journal event/route |
| Modes Focus / Collaborate / Inspect | 1, 2, 4 | EXISTS as which surface is open (side panel toggle `ui/background.js` `windowId`; live view page); NEW per-viewer persistence (`chrome.storage` / `localStorage`, like `pb-fit` `scripts/liveview.js`, `click` listener) |
| Shared token sheet | 2, 4, 5 (`hud.js` inlined) | REFINE: `ui/tokens.css` `:root` rule, `ui/tokens.css` `:root` rule, `ui/tokens.css` `:root` rule, `newtab.css`, `ui/screen/screen.css` `:root` rule, `ui/capture/record.js` `strip()`; `hud.js` via inline values or a `__PB_` substitution in `scripts/browser.mjs` `hudScript()` |
| Joiner's picture page overlays | 5 screen | REFINE colors only; `#hold` rgba and texts pinned (`test/ui-screen.test.mjs`) |
| Agent cursors drawn over the live view stage | 4 live view | UNSUITABLE (already in the streamed frame; a per-frame overlay) |
| Hold countdown "agents wait Ns" | 4 live view, 6 state | UNSUITABLE as drawn: `humanUntil` never produced (`scripts/collaboration.mjs`); per-tab `waiting`/`person` EXISTS (`scripts/liveview.mjs` `tabsInfo()`) |
Decisions taken from it: the color theme seed moves to navy (next start, a user's own theme
still wins); the side panel is the agent panel and the live view page the expanded workspace;
"Screenshots", "Live reasoning", "Take control", "End session", "More actions", History and the
storage meter are not built; the Share button and the checklist need new owner-only routes
(security table entries) and come after the surfaces that need no new state.

## Design tokens (Phase 3)

Starting values from the brief, to be refined for contrast: background `#0B1421`, chrome
`#101D2D`, sidebar `#111E2D`, elevated `#192A3D`, hover `#243750`, text `#F1F5FA` /
`#A2B2C6` / muted `#71869F`, border `#293B50`, accent `#3285F6`, success `#20C997`, warning
`#F4B45D`, error `#EF6468`. Participant colors stay PairBrowse's (`SPARK_COLORS` in
`scripts/daemon/hud.mjs`: orange, cyan, purple, green). One token sheet shared by the side
panel, the live view and the in-page script (`ui/common.js` is the shared
code today).

Built (tokens subset): `ui/tokens.css`, linked by the side panel, picker, new
tab page and joiner's picture page and served to the live view as `assets/tokens.css`. Refined
for WCAG AA: muted `#8699B1` (was `#71869F`: 3.9:1 on elevated); accent `#3285F6` stays for
fills, rings and borders, and as text it is `--accent-ink` `#6AA6F9`; primary buttons put `--bg`
text on `--accent` (white on accent is 3.6:1); the border token is named `--edge`; `--spark` is
`SPARK_COLORS[0]`. Type 11/12/13 px, radii 6/8/10 px (`--r-1..3`); no spacing tokens yet (nothing read them, and the test fails on an unused token); `--edge-input` `#647891` is a text field's border at 3:1 or more. A light
block under `:root[data-scheme="system"]` (live view only): bg `#F4F7FB`, chrome/sidebar
`#FFFFFF`, elevated `#E8EEF5`, hover `#DCE5EF`, ink `#0F1B2A` / `#3A4B60` / muted `#53667D`, edge
`#CBD6E2`, accent `#2468D0` (so `--bg` text on it passes; accent-soft is its channels at .14), accent-ink `#1F63C7`, spark `#C4521B` (3:1 on the light tab strip), ok `#11735A`,
warn `#8A5A00`, bad `#C0343A`. `hud.js` and `record.js` carry the values inline (closed shadow
roots and a canvas take no variables); `test/tokens.test.mjs` keeps them equal and checks the
contrast. `THEME_COLOR` is the chrome navy `0xff101d2d`. `ntp.png` is gone (flat `--bg`).

## Subset workflows

`.claude/workflows/`:

- `design-understand.js`: readers per surface → the Surfaces section.
- `design-subset.js` (args `{ subset, brief }`): Fable plans the subset from this file and the
  code → Opus 5.5 builds it (lint, unit tests) → in parallel a tester runs the relevant suites
  and Fable reviews against the reference and the rules → Opus fixes what the review names,
  up to three rounds → a report for this file.
- `design-validate.js`: the zero-regression gate: lint, unit, live suite, bench against the
  baseline table above, the screenshot and lifecycle tests, a reduced-motion and keyboard check.

Subsets, in order: `tokens` (shared sheet + the color theme), `hud` (bar chips, badge, cursors,
join card), `panel` (agent cards, session card, sections, collapsed state), `liveview` (the
expanded workspace: sidebar sections, timeline from the goal log), `modes` (persisted
presentation preferences; nothing restarts).

## Subset briefs

**hud** (`scripts/hud.js`, `scripts/daemon/hud.mjs`; tests `test/hud.test.mjs`,
`scripts/native/check.mjs` pins the bar payload shape). The bottom bar
becomes the reference's: at the left an avatar dot in the driver's color and "Claude is
driving" / "Paused by Sam" / "Reconnecting to Bob…"; then the last actions as chips, each with a
state glyph (done ✓ for actions already in the bar's `items`; the chip text is the bar's own
one-line description, never invented), the Pause agents button at the right; the join request
as an anchored card above the bar's right end (avatar, "Sam wants to join · drive", Allow
primary, Deny, ×; the same arming, visibility and trusted-click gating as today, unchanged
lines). The badge: same box, navy elevated surface, the agent's color as a 3 px left edge, "Your
turn" variant keeps its animation only when motion is allowed. The agent cursor: a refined
pointer path, the label pill in the participant's color with white text, a 1 px darker outline,
no glow or trail; the field the agent types in gets a 2 px outline in its color while the
"targets"/"press" declaration holds (drawn inside the cursor's shadow root with a positioned
box, never by touching the page's DOM). Peers' pointers the same pill style. No new timer:
everything keyed to the existing calls and the existing rAF loops; `prefers-reduced-motion`
turns the cursor glide into a jump and the ring into a static dot.

**panel** (then `panel.html`, `panel.css`, `panel.js`; now `ui/right/index.html`, `right.css`, `right.js`; `common.js`;
`test/integration/panel-reload.test.mjs`, `test/integration/join-prompt.test.mjs`, `docs/using.md` screenshots of the
panel mentioned?). The side panel becomes the agent panel: header with the logo (unchanged),
"PairBrowse", the session pill ("● Live session" when sharing, else the session's name) and an
avatar stack of the participants (colors from the board, initials, "+N"). Then the active
agent card: avatar, name, its status (the `pairbrowse_status` text, named "Status", or
"Working…" from the driver line), the tab it holds, Pause/Resume. Other participants as compact
rows (name, app, what the board says: observing / in tab N / paused). Requests (join, dev
share, host asks) as cards at the top in the approval style. Sections below, collapsible,
collapsed by default except Activity: Session (people, messages), Dev servers, Join addresses,
Activity, Remembered details, Passwords (forms unchanged). Switch session… and Record stay as
buttons in a compact row. All existing ids, event handlers and text the tests assert stay; the
collapsed state of sections persists in `chrome.storage.local` under one key. No new polling:
the panel already listens to the live view's SSE.

**liveview** (`scripts/liveview.html`, `.css`, `.js`, `scripts/liveview.mjs` events;
`test/liveview.test.mjs`, `test/shared-liveview.test.mjs`). The Inspect workspace: a left
column (collapsible to a rail, hidden with a key, remembered in `localStorage` like `pb-fit`)
with Browser (open tabs, who is in each, from `tabs`), Agents (from `collaboration` and
`board`), Shared with (guests), Session (name, where); the stage in the middle as today; a
right drawer for Activity (as today) and a Timeline entry that opens the goal log's lines (a
new owner-only read route `journal` on the live view server returning the current run's `done`,
`yourTurn`, `left`, `updatedAt`; nothing is captured for it, no images). Reduced motion honored;
hidden columns stop drawing (no listeners doing DOM work for a hidden column).

**modes**. Focus = side panel closed and no live view open (nothing to build beyond making the
badge appear only with a status and the bar fade as today); Collaborate = side panel open;
Inspect = live view with the column open. One shared preference object per viewer
(`chrome.storage.local` in the panel, `localStorage` in the live view) remembering sidebar
state and collapsed sections; no mode switch restarts, reloads, reconnects or captures anything.
Docs: `docs/using.md` gets a short "Three ways to look at it" paragraph.

## Done

**tokens** (2026-10-11, `design-subset` run wf_523d6638: plan Fable, build Opus, review pass
in one round; tests 381 unit pass, 50 live pass on the touched suites). `ui/tokens.css` is the one sheet (dark values from the brief with contrast fixes: muted `#8699B1`,
accent as text `#6AA6F9`, primary buttons dark text on accent; a light block only for the live
view under the system scheme); linked by the side panel, picker, new tab page, joiner's picture
page and the live view (served from the fixed asset list, CSP unchanged). `scripts/hud.js` and
`record.js` carry the same values inline (closed shadow roots take no variables; a page could
inject them) and `test/tokens.test.mjs` keeps every literal equal to a sheet value or a spark
color and checks the contrast matrix. The theme seed is the sheet's chrome navy (`THEME_COLOR`
0xff101d2d; hue 254°, as the accent's 257°); profiles still on PairBrowse's old seed move to it
at the next start (only the seed: a light or follow-the-system scheme the user chose stays), a
color the user picked stays (`scripts/browser.mjs`, `test/browser.test.mjs`).
The new tab page is flat navy, the 2.5 MB `ntp.png` and its blur are gone, the logo unchanged.
A joiner's picture page's pill is `--bg` at .9 (muted text over a white page 4.89:1). The "Opening tabs" restore page (`scripts/tabs.mjs`) carries the sheet's values inline: flat card (`--sidebar`), no blur or pulse, a waiting, opening or failed tab says so in text
(an open one has no label), not by its dot's color alone; the literal-color test covers it. In
the live view's light scheme the spark is `--spark` `#C4521B` (3:1 on the light tab strip), and
Claude's owner dot beside it and in the tab overview takes `var(--spark)` too, so one agent has
one orange per scheme; other participants' dots keep their color. Muted text is 4.1:1 on
`--hover`, so text that stays on it (the current tab's last action in the overview, the older
actions' code chips) is `--ink-2` (5.6:1). ESLint skips `.claude/` (local worktrees and
workflow scripts, not shipped), noted in `docs/development.md`. A half-finished daemon change
from the hud subset (badge `{ text, color }`) slipped into 6706756 and was taken back out
(fca819b); it lands with the hud subset. `node test/bench.mjs` on abef3ee (screenshots on,
against the engineering-progress "After" column): click p50/p95 508/528 ms (517/537), small
snapshot 67 ms with 1 image (74, 1), long snapshot 149 (166), navigate 386 (400), fast-mode form
336 (350), click_at 249 (251), status 1/4 ms (1/5), 9 processes; no regression. `docs/development.md` describes the sheet. Not verified by eye: the window frame's tint from the
new seed (screen capture isn't permitted for the helper's session here; one glance at the next
browser start); Chromium's tonal palette takes the seed's hue, so navy is expected.

**hud** (2026-10-11, `design-subset` run wf_a67d6ab3: review pass in one round; 384 unit pass,
the hud, join-prompt, tokens and native-engine live suites green). The bottom bar: a driver dot
in the tab's spark color before the unchanged who-line, the last three actions as chips oldest
to newest with a glyph from the bar's own lines (done ✓ in green, the newest "under way" dots
only while the agent really drives, a red "!" for "That didn't work"), the time as each chip's
title, Pause agents at the right, no spinning spark. The join request is a card anchored above
the bar's right end (avatar dot, "Sam (Claude Code) wants to join · drive", Allow, Deny, ×)
with the arming, visibility and trusted-click gating untouched; while it shows the badge drops
its shadow (Chromium's visibility tracking counted the shadow as cover). The badge sits on the
elevated navy with a 3 px left edge in the agent's color (blue for "your turn", green for
"done"); the helper passes the participant's spark color with the status. The agent cursor: a
refined pointer in the participant's color, the label pill in that color with dark ink
(white fails AA on three of the four participant colors; same choice as the primary buttons),
a 1 px darker outline, no glow or trail; the control it acts on is outlined 2 px in its color
inside the cursor's shadow root while the press or targets declaration holds; peers' pointers
share the pill. Reduced motion: the glide jumps, the click ring is a static dot. No new timer
or observer. `docs/security.md` row on join requests updated. Looked at (headless, the helper's
own pictures of six states): matches the reference's bar, card, badge and cursors.

**panel** (2026-10-11, `design-subset` run wf_1569325e: review pass in round two; 391 unit pass,
the panel and tokens live suites green). The side panel is the agent panel: header with the
unchanged logo, the wordmark (visually hidden under 340 px, still in the tree), the session pill
("● Live session" with guests, else "Local · name") and an avatar stack from the board and the
guests (initials in their colors, "+N" past four); requests (join, dev share, host asks) as
approval cards at the top with their gating untouched; the active agent card (avatar, name, the
driver line, the agent's own status named "Status", the tab it holds, Pause/Resume); other
participants as compact rows in Session; Switch session… and Record in one row; Session, Dev
servers, Join addresses, Activity (open), Remembered details and Passwords as disclosures with
aria-expanded, remembered in `chrome.storage.local` under `pb-panel`. No new state, route or
timer (the two existing timers stay); `test/ui-right.test.mjs` pins the markup, the logo hash, the
timer count and, with the runtime, renders the panel over a fake SSE feed.

**liveview + modes** (2026-10-11, `design-subset` run wf_3a381cca: review pass in round three;
396 unit pass, the liveview, journal, shared-liveview and invites live suites green). The
live view is the Inspect workspace: a left column (open 240 px, a 44 px rail, hidden; a toolbar
toggle with Ctrl/Cmd+B; remembered per viewer in `localStorage` `pb-view` beside `pb-fit`)
with Browser (the open tabs, who holds each, the spark), Agents (board and collaboration, state
in words), Shared with (guests) and Session; the stage unchanged; the right drawer gains a
Timeline tab (owner only) that reads the goal log through one new owner-only route
`journal.json` (masked again on read, no images, read once on open and on an explicit refresh;
`docs/security.md` row added). Hidden or folded parts skip their DOM work. Fixed in the rounds:
the column toggle on watch links, avatar ink in the light scheme (dark ink on every participant
color, as the hud pills). Modes are what is open: Focus (panel closed), Collaborate (panel),
Inspect (live view with the column); the panel's `pb-panel` and the live view's `pb-view` keep
each viewer's choice; nothing restarts, reloads or captures on a switch (`docs/using.md`,
"Three ways to look at it"). Left as a minor: on a watch link the tab rows are disabled buttons
(unreachable by keyboard); render them as plain rows there.

**picker + picture page** (2026-10-11, `design-subset` run wf_ed3a2cb5: review pass in one
round; 401 unit pass, the picker, screen and tokens suites green). The session picker is a
compact navy card with the unchanged logo, the recent sessions as rows (avatar initial in the
person's color, name, tabs, who used it, a Live pill), More sessions as a disclosure, the two
secondary actions, the join-code form unchanged, the host-ask as an approval card; the one
4 s timer stays the only timer; every id, text and keyboard path kept (`test/ui-picker.test.mjs`
pins them and the logo hash). The joiner's picture page overlays are compact navy pills, with a
"who is in this tab" pill in words and the person's color (neutral when none); the pinned hold
scrim and texts byte for byte; nothing per frame, no new timer. The watch-link tab rows in the
live view's column are plain focusable rows now.

**share + checklist** (2026-10-11, `design-subset` run wf_fd1ecf9e: review pass in one round;
403 unit pass, the share subset's live suites green). A Share button in the side panel header
and the live view toolbar (owner only) opens an anchored, non-modal card: Join code (shared
browser, can drive) or Watch link, a first-name field when none is known, Make invite, the
result shown once with Copy; it posts to one new owner-only route `invite` that runs the same
`createInvite` as `pairbrowse_invite create` (lifted out of `inviteCommand`, tool output
unchanged); keys never reach logs, `state.json` or the event stream; 403 on invite keys, not
served on the join-code port (`docs/security.md` row). The active agent card gains a Checklist
disclosure: the goal log's lines (done ✓, current ◉, waiting for you ●, pending ○; state in a
visually hidden prefix too) from the existing `journal.json`, read once when opened and again on
an activity event at most every 5 s through one cleared debounce; nothing while folded. Escape
and focus leaving the card close it.

**finish** (2026-10-11, `design-subset` run wf_b223fe6d: review pass in one round; 404 unit
pass, tabs, tokens, hud, liveview and motion live suites green). The "Opening tabs" page's rows
are the column's rows (initial avatar, title, host, a state mark with the words kept); the bar
shows a REC pill with a red dot while this browser's recorder runs (one optional boolean on the
bar payload, set by the recorder's own change callback, never crossed to joiners); the live
view's stage toolbar sits on the compact sizes and the workspace header's label shares the tab
labels' baseline (7 px measured, not the plan's 10). No open items remain in this mission; the
next subsets, if any, are the user's to name.

**hud** (2026-10-11, `design-subset`, built by Opus; the lead commits). `scripts/hud.js`: the
bottom bar has a driver dot in the tab's spark color (orange until set, muted while
reconnecting) in front of the unchanged who-lines, and the last three actions as chips, oldest
to newest, the newest next to Pause agents, the row fading at its left. Each chip's state comes
from the bar's own lines only: a check when done, three dots for the newest while the agent
drives (the existing 8 s redraw turns it into a check), "!" for a "That didn't work" line; the
state is in the glyph's shape and the class, not color alone. The spinning spark is gone. The
join request is a card 12 px from the right, 10 px above the bar (elevated navy, edge ring,
shadow, an orange dot, "Sam (Claude Code) wants to join · drive", Allow, Deny, × at its corner);
its arming, visibility and trusted-click checks are unchanged. The badge moves above the card
and drops its drop shadow meanwhile: Chromium's visibility tracking counts a shadow over the
card as covering it, so Allow would not have counted (the join-prompt test caught it). The
badge has a 3 px left edge: the agent's spark color (`scripts/daemon/hud.mjs` sends
`{ text, color }` for agents' statuses, a plain string for PairBrowse's own), accent for Your
turn, ok for Done. The agent cursor is a pointer filled in its color with a white edge, tip
exactly at the point; its name pill and the peers' pills carry dark ink (`#0B1421`) with a 1 px
darker outline, no glow or trail. Deliberate deviation from the brief: white pill text is 1.7:1
on cyan and green, dark ink is 6.9:1 to 12:1 on all four colors (the sheet's primary-button rule).
A 2 px outline in the agent's color is drawn inside the cursor's shadow root around the box the
cursor, a press declaration or a form fill's first target names; the existing scroll listener
keeps it in place, the cursor's hold timer and cursor-off take it away. With reduced motion the
cursor jumps and a click leaves a static dot. No new timer, observer or animation loop (13 call
sites before and after); the bar payload is unchanged. Looked at (headless, 1100x720 @2x,
`hud-look.mjs`): driving (dot, three chips with check/check/dots, Email outlined, orange
"Sam's Claude" pill, Codex and Gemini pointers, orange-edged badge), your turn with the click
ring on Continue, the join card with the green-edged Done badge above it and the bar intact,
paused (warn border, Resume, dot still orange), reconnecting (muted dot, outline gone after
cursor-off), waiting; reduced motion: the static white dot on Continue. Tests: 5 new in
`test/hud.test.mjs`, the join-prompt geometry assertion now "a card above the bottom bar's
right end" plus the badge-above-card check.

**panel** (2026-10-11, `design-subset`, built by Opus; the lead commits). The side panel is the
reference's agent panel, fed only by events already on the owner stream (status, session,
collaboration, board, activity, pause, record, join, dev, joinhost); no new route, listener,
timer, observer or SSE event. Header: the unchanged logo line, "PairBrowse", `#where` as a pill
("● Live session" while `collaboration.guests` is non-empty, else "Local · <name>", the full
"where · name" as its title, `data-clean` kept) and an avatar stack from the board's people
plus guests not already on it: four initials in the board's colors (only a plain `#rrggbb`;
else an outlined plain avatar), then "+N", each `role=img` named by the person. Requests
(`#joins`, `#dev-asks`, `#host-asks`) come first as cards (edge ring, accent left edge, a dot:
accent for join and dev asks, warn for join addresses, ok for "is in"); `joinBanners`,
`devPanel`, `hostPanel` and their trusted-click gating are untouched. The active agent card
wraps the unchanged `#turn`-adjacent `#driver` and `#pause` blocks: avatar in its board color
(`--spark` when none), the name (`whose` of the newest activity's agent), "Status" plus that
board entry's `pairbrowse_status` text (hidden when none), "In <tab>" (board tab, else the
newest activity's tab). The spark no longer spins. Other participants are compact rows in
Session (avatar, name, app split from "Name · App", the state word, where/tab, task or last
action), the active agent not repeated; the idle-agents line, messages and the `#session`
hidden rule unchanged; the dead `.people .state[data-s]` selectors are gone. Session, Dev
servers, Join addresses, Activity, Remembered details and Passwords fold under an h2 button
(`aria-expanded`, `aria-controls`; body `hidden`, content and listeners kept), Activity open
by default, remembered in `chrome.storage.local` "pb-panel" `{ collapsed }`; every `chrome.*`
access is guarded so the page renders as a plain page. `common.js` gained definitions only
(`isColor`, `splitLabel`, `initialOf`, `avatar`). `.field:focus` no longer removes the outline
(the sheet's `:focus-visible` ring shows). Looked at (`panel-look.mjs`, 360x900 @2x over a fake
stream): idle/connecting, live with Claude driving plus a join card and a dev-share question,
paused (warn edge, Resume), your turn with the local pill (ellipsis, full name in the title),
all sections open, reduced motion with keyboard focus, and without `chrome` at all (no page
error); the logo unchanged (sha256 415a3f8e…bffd8a). Deviations: the agent card's name falls
back to the first working local agent only when there is no activity yet; with activity from
an agent not on the board, the card shows no status rather than another agent's; the request
cards sit above the "Your turn" card. Tests: new `test/ui-right.test.mjs` (markup ids, folding
markup, logo hashes, two timers, one storage key, sheet rules; live: rendered over a fake
stream, header, card, rows, pause click, join card gating, folding and its persistence,
no interval, no page error with and without `chrome`, reduced motion). `docs/security.md`,
`using.md`, `development.md`: no change needed (same clicks, routes and gating; the one new
storage is a list of folded section names). Full suite with the runtime: one failure,
`memory.integration` "leave no screenshot maps behind", caused by the hud subset, not old: the
old bar's spinning spark made two pictures in a row differ, the static driver dot makes a
snapshot right after a navigate byte-identical to the navigate's picture (the intended dedupe),
and the test demanded an image. The test now accepts the same-picture note (gate run
wf_8b5157bb bisected it to fdab983).

**picker** (2026-10-11, `design-subset`, built by Opus; the lead commits). The session picker
(`ui/picker/`) is a compact card (min(480px, 100%), `--sidebar`, 1 px edge)
on flat `--bg`: the unchanged 56 px logo, a "PairBrowse" wordmark over the kept "Which session?"
and its line. The three recent sessions are the panel's rows: a 24 px round avatar (`avatar()`
from `common.js`, `role=img`, named) with the initial of the person in it now, else who used it
last, in their steady hue; a session nobody used shows its own initial on the soft accent; the
name bold, "N tabs · sites" muted, who-used-it chips (16 px marks, `aria-hidden`), "Last used"
and "Live · N other(s)" as edge-ring pills in words (the live dot without its halo,
`data-live="true"`). "More sessions (N)" is the panel's disclosure (chevron, filter); closed,
it keeps its height (before, a tall join card could squeeze it over the "Or" heading). Start
fresh and Join are two outlined secondary rows; the join form's ids, placeholders and texts are
unchanged; the address question is an approval card (elevated, 1 px edge, 3 px warn left edge,
a warn dot, Allow once focused / Always allow / Cancel). Every focusable shows the 2 px accent
ring; reduced motion stops every transition. No id, text, handler, route or timer changed (one
4 s `setInterval`). A joiner's picture page (`screen.*`): status, hold, tag and address are
28 px navy pills with a 1 px edge and 7 px dots, no halo; a new `#who` pill beside the tag says
who works in the tab in words ("Sam is in this tab", "Claude (agent) is working in it",
"Sam · Claude (agent) working") with a dot in the color the helper already sends through
`pbScreen.who()` (the person's, else the agent's, else `--spark`); it shows with the tag when it
changes and fades on the tag's own timer (no new timer; counts 2/1/1 unchanged, the same two
keyframes). Pointer names carry dark ink (`--bg`) on the participant color, as the hud's; the
file request is a card with an accent edge; the hold scrim `rgb(11 20 33 / 0.35)`, its
`pointer-events: none` and every wording are byte for byte. Looked at (scratch
`render-pages.mjs`, 1200x760 and 1100x700 @2x, with and without reduced motion): ready (focus
ring on the first row, Live pill, chips, "+1"), More open with a filter, Join open, the address
card with the warn edge; the picture page with the three top pills and two pointers, the hold
over the dimmed frame, the connecting pill. Logo files unchanged (sha256 415a3f8e…bffd8a).
Deviations: the row grid has two columns (the brief's third "auto" column had nothing to hold;
the badges stay beside the name); "Last used" is an edge pill in `--ok` text instead of a tinted
fill (no literal colors). `docs/security.md` needs no change: no route, gating, capture or
input path changed. Tests: new `test/ui-picker.test.mjs` (markup, texts, logo, one timer, no new
route, sheet rules; live over a fake chrome and sessions.json: rows, avatars, disclosure,
filter, keyboard paths, the bad-code message, the address card, reduced motion);
`test/ui-screen.test.mjs` gains a markup/timer test and a live who-pill test.

## Gate (hud + panel), 2026-10-11, run wf_8b5157bb

Lint clean; unit 391 pass; fuzz 37 pass; manifests valid; live suite 459 pass, 1 fail (the
cleanup test above, fixed since). Bench on a busy machine: click p50 502 ms (517), snapshot
long page 104 ms (166), navigate 347 ms (390), cold start 1.13 s (1.2), 1 image in 20 repeated
snapshots, 3-tab idle CPU inside the baseline band, soak with a viewer flat (heap 85 → 83 MB).
Two flags (helper RSS at the bench's end 249 vs 210 MB; one browser idle sample +0.3 points)
cleared by a quiet re-run: helper RSS 219 → 227 MB (baseline 202 → 210), browser idle after
work 1.1% (1.0%), click p50 515 ms, navigate 344 ms, snapshot 67 ms with 1 image in 20. Diff
checks: no new capture or retention, no timer or observer while hidden, infinite animations
down (panel 2 → 1, hud 3 → 2), reduced motion honored everywhere added, the logo untouched.

## Gate (all subsets), 2026-10-11, run wf_e1c222bb, branch at 9fb9ac2

Suites: lint clean; unit 396 pass; live 466 pass, 0 fail, 20 skipped (opt-in); fuzz 37;
manifests valid. Bench vs 0.15.42: click p50 513 ms (517), long snapshot 105 ms (166),
navigate 345 ms (390), fast-mode form 286 ms (350), click_at 237 ms (251), cold start 1.19 s
(1.2), 1 image in 20 repeated snapshots, idle CPU after start inside the baseline band; helper
heap 86 → 88 MB over the bench, flat in the soak. Diff checks: no capture or retention added,
no timer or observer while hidden, reduced motion honored, the logo untouched, the journal
route owner-only and masked. The verdict agent held on helper RSS at start (219–231 MB against
a 205 figure). Across all eight bench runs on both codebases that number spans 163–221 MB at
start and 202–247 at the end (the pre-design code itself measured 220 at start in one run), so
the branch sits inside the spread with a flat heap: noise, not a regression. Verdict: SHIP.

## Gate (picker, picture page, share, checklist), 2026-10-11, run wf_80d6a344, branch at 8ca5d4d

Suites: lint clean; unit 403 pass; live 476 pass, 0 fail, 20 skipped; fuzz 37; manifests
valid. Bench vs 0.15.42: click p50 501 ms (517), long snapshot 102 ms (166), navigate 342 ms
(390), fast-mode form 291 ms (350), click_at 249 ms (251), cold start 1.21 s (1.2), 1 image in
20 repeated snapshots, helper idle 0.2–0.5%; soak flat (heap 82 → 84 MB, RSS 227 → 218). One
blip: helper RSS 254 MB at the end of one screenshots-on run (flat in the other run and the
soak: GC timing). Diff checks: the new `invite` route owner-only, answered once, nothing
logged; no timer while folded; reduced motion everywhere added; keyboard and names on every
new control; the logo untouched. Verdict: SHIP. The two minors are fixed since: the watch-link row has a default cursor; the
checklist list is no live region any more, a visually hidden status line says the counts only
when they change.

## The browser track (decided 2026-10-11)

PairBrowse stops being an extension: its chrome (strip with tabs and the agent dot, the Live
pill, avatars and Share; a left workspace dock; a right agent dock; new tab, picker, picture,
approval and settings pages) becomes the browser's own WebUI pages, built from a new `ui/`
directory here into the native build, talking to the browser over `pairbrowse.mojom` and to
the helper over the live view's channel. The exact plan for both repos, patch by patch, page by
page, with phases and exit criteria, is `../pairbrowse-native/DESIGN.md` (private).

### Lane U: the pages (2026-10-11, branch `browser/ui`)

The extension's pages moved to `ui/` (one source for two hosts: the native build's slots over
`window.pairbrowse`, the side panel extension on plain Chromium), a harness renders every page
headless under the chrome pages' CSP over a mojom shim and a fake helper (`test/ui.test.mjs`,
`test/helpers/`, `scripts/dev/ui-look.mjs`), and the nine pages of Part B are built and merged
after their own review: the top strip (`ui/strip`), the left dock (`ui/left`), the right dock
(`ui/right`: the side panel on plain Chromium), the new tab page, the picker, the joiner's
picture page, the approval card, settings and the timeline strip. Nothing a user sees on plain
Chromium changed: the extension loads from `ui/` and its live suites stay green at every gate.
Follow-ups landed: frame-src/frame-ancestors for the picker and the switcher popover in the strip and the left dock, approvals in the fake helper, and `scripts/dev/ui-look-all.mjs` with per-page review fixtures (`scripts/dev/look/`).

## Next

1. Nothing open. The window frame's tint is verified from Chromium's own computed theme sheet
   (`chrome://theme/colors.css?sets=ui,chrome` opened in a profile prepared by `prepareProfile`
   with the new seed, headed Playwright Chromium): frame `#15202F`, toolbar and active tab
   `#313C4C`, inactive tabs `#15202F`, new tab page `#313C4C`: the dark navy and blue-grey of
   the sheet's family. New subsets run through `design-subset` with a brief; `design-validate`
   before a release.
