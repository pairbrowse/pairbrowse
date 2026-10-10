# Design progress: the collaborative browser interface

The durable handoff for the design mission (the dark navy collaborative browser: optional
workspace navigation, agent panel, agent cursors, contextual approvals, session controls, a
hidden-by-default timeline; Focus, Collaborate and Inspect modes). The rule above every other:
nothing of 0.15.42's measured performance, security or behaviour regresses (its numbers are in
`docs/engineering-progress.md`; the bench is `test/bench.mjs`). The logo is never changed.

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
| Deep navy frame, tab strip, toolbar colors | 1 chrome | REFINE: `THEME_COLOR` `browser.mjs:119`; next start; user theme wins `:140` |
| Logo + "PairBrowse ⌄" switcher in the toolbar | 1 chrome | UNSUITABLE in chrome; function EXISTS as Switch session (`panel.html:25`) and picker (surface 5); logo unchanged |
| Active/inactive tab surfaces | 1 chrome | EXISTS (Chromium's derivation); not per-element |
| Orange owner dot on a tab | 3 hud | EXISTS: tab icon spark `hud.js:252-288`, `daemon/hud.mjs:77` |
| "+", ×, back/forward/reload, address pill, lock | 1 chrome, 4 live view | EXISTS (Chromium; `liveview.html:13-25`) |
| Star, search, sparkle buttons | 1 chrome, 4 live view | UNSUITABLE (no toolbar slots; no state) |
| "● Live session" pill | 2 panel, 3 hud, 4 live view | REFINE: `panel.js:82-86`, bar who line `hud.js:406-408`, `liveview.js:227-252`; fed by `collaborationNow` `liveview.mjs:144` |
| Avatar stack (C, G, Y, +2) | 2 panel, 4 live view | REFINE: board people `panel.js:99-117`, guests `liveview.mjs:136-143`; colors `SPARK_COLORS` `daemon/hud.mjs:11` |
| Share button | 2 panel, 4 live view | NEW: needs an owner-only route for invites (`sharing.mjs:290-299`, no event today); security table entry |
| "⋯" toolbar menu | 1 chrome | UNSUITABLE |
| New tab page in navy | 1 chrome / 5 | REFINE: `newtab.css`; drop `ntp.png`; `addressToUrl` unchanged |
| Left sidebar: Workspace header | 4 live view | NEW (Inspect layout), fed by `tabs`, `board`, `collaboration` |
| Left sidebar: Browser (count) | 2 panel, 4 live view | NEW listener in `panel.js` / `liveview.js:200-205`; event already sent `liveview.mjs:639,813` |
| Left sidebar: Sessions | 2 panel, 5 picker | EXISTS: Switch session, picker (`context.mjs:321-349`) |
| Left sidebar: History | any | UNSUITABLE (Chromium's own) |
| Left sidebar: Activity | 2 panel, 4 live view | EXISTS: `panel.html:46-50`, `liveview.html:65-69` |
| Left sidebar: Tools | 2 panel, 4 live view | NEW static list, no state |
| Left sidebar: Agents (Active · 2 tabs, Idle, Working) | 2 panel, 4 live view | REFINE: board entries `daemon.mjs:218-226`, `panel.js:99-117`; tab counts from `tabs` |
| Left sidebar: Shared with (Team, Client) | 2 panel, 4 live view | REFINE: `collaboration.guests` `liveview.mjs:136-143`, approvals `open()` `join.mjs:227` |
| Left sidebar: storage meter | any | UNSUITABLE (no meaning) |
| Agent cursor with label pill (Claude) | 3 hud | EXISTS `hud.js:559-631`; REFINE geometry, pill, no glow/trail |
| Several agents' cursors at once (Codex, Gemini) | 3 hud | EXISTS for joiners' agents as peers `hud.js:633-737`; NEW per-agent cursor for this helper, fed by `cursor` calls' `who`/`color` `hud.js:758-769` |
| Edited field outlined in the agent's color | 3 hud | NEW inside the cursor shadow root, fed by `targets` `hud.js:782-788`, `press` `:772-781`, `owned` `:168-173` |
| Approval card: join request Allow/Deny | 3 hud, 2 panel, 4 live view | EXISTS `hud.js:452-557`, `common.js:56-98`; REFINE into a card inside `barHost`, gating kept (`:473-474, :485-495`; `common.js:84, :91`) |
| Approval card: dev-server share question | 2 panel | EXISTS `common.js:148-155`; REFINE layout |
| Approval card: "Claude Code wants to click … Allow" | page | UNSUITABLE: confirmations stay in the coding app (guard hook) |
| Approval card: "More actions ⌄" | 3 hud | UNSUITABLE |
| Bottom bar "● Claude is driving" | 3 hud, 4 live view | EXISTS `hud.js:406-408`, `liveview.js:258-284` |
| Bottom bar done chips | 3 hud, 4 live view | REFINE from bar `items` `daemon/hud.mjs:95-100` and `activity` |
| Bottom bar current/pending chips | 3 hud, 4 live view, 6 state | NEW payload fields via `applyBar` `daemon/hud.mjs:95-99`, fed by the journal `journal.mjs:92-99`; payload shape kept (`native-check.mjs:64`; `hud.js:421-426`) |
| Pause agents / Resume | 3 hud, 2 panel | EXISTS `hud.js:375,381-383`, `panel.js:41-43` |
| Right panel tabs Agent / Page / Tools | 2 panel | NEW section tabs in `panel.html`, no new state |
| Right panel tab Screenshots | 2 panel | UNSUITABLE (pictures never kept) |
| Active agent card (avatar, name, state, Pause, collapse) | 2 panel, 4 live view | REFINE: driver line `panel.js:51-60` + pause `:119-126` + first board entry `:99-117` |
| "Current task" | 2 panel, 4 live view | EXISTS: board `task` (`daemon.mjs:218-226`; `session.mjs:71-75`) |
| Checklist (done / current / pending) | 2 panel, 4 live view, 6 state | NEW: owner-only journal event/route (`journal.mjs:92-99`, file-only today `:210`) |
| "Live reasoning" | 2 panel | UNSUITABLE as named; REFINE: `pairbrowse_status` text shown as the agent's status, named as such |
| Other participants rows (Observing, Helping, Active) | 2 panel, 4 live view | REFINE: Session people list `panel.js:99-117`; "Helping · Suggesting inputs" has no state |
| "Take control" | 2 panel | UNSUITABLE (`collaboration.mjs:128-142` are agents' tools; presence `presence.mjs:63-85`) |
| Session card: name, where | 2 panel, 4 live view | EXISTS `panel.js:75-81`, `liveview.js:216-223` |
| Session card: "Saved 2 min ago" | 2 panel, 6 state | NEW from journal `updatedAt`, same transport as the checklist |
| Session card: Save | 2 panel | EXISTS as Record (`panel.js:20-40`) for a recording; the run file saves itself (`journal.mjs:74-78`); a "Save" that copies the run is NEW via `runs.mjs` route, owner only |
| Session card: Share | 2 panel | NEW (see Share) |
| Session card: End session | 2 panel | UNSUITABLE as one-click; Switch session / picker are the controls |
| Hidden-by-default timeline | 4 live view, 6 state | NEW drawer like `#drawer` (`liveview.css:187-195`), loads on open, fed by the journal event/route |
| Modes Focus / Collaborate / Inspect | 1, 2, 4 | EXISTS as which surface is open (side panel toggle `background.js:18-21`; live view page); NEW per-viewer persistence (`chrome.storage` / `localStorage`, like `pb-fit` `liveview.js:72,96`) |
| Shared token sheet | 2, 4, 5 (`hud.js` inlined) | REFINE: `panel.css:2-11`, `liveview.css:4-18`, `picker.css:2-8`, `newtab.css`, `screen.css:1`, `record.js:70-99`; `hud.js` via inline values or a `__PB_` substitution in `browser.mjs:271-288` |
| Joiner's picture page overlays | 5 screen | REFINE colors only; `#hold` rgba and texts pinned (`test/screen.test.mjs:47-57`) |
| Agent cursors drawn over the live view stage | 4 live view | UNSUITABLE (already in the streamed frame; a per-frame overlay) |
| Hold countdown "agents wait Ns" | 4 live view, 6 state | UNSUITABLE as drawn: `humanUntil` never produced (`collaboration.mjs:32-39`); per-tab `waiting`/`person` EXISTS (`liveview.mjs:131`) |
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
panel, the live view and the in-page script (`scripts/browser/panel/common.js` is the shared
code today).

Built (tokens subset): `scripts/browser/panel/tokens.css`, linked by the side panel, picker, new
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
`test/hud-*.integration`, `native-check.mjs` pins the bar payload shape). The bottom bar
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

**panel** (`scripts/browser/panel/panel.html`, `panel.css`, `panel.js`, `common.js`;
`test/panel-*.integration`, `test/join-prompt.integration`, `docs/using.md` screenshots of the
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

**liveview** (`scripts/liveview.html/.css/.js`, `scripts/liveview.mjs` events;
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
in one round; tests 381 unit pass, 50 live pass on the touched suites). `scripts/browser/panel/
tokens.css` is the one sheet (dark values from the brief with contrast fixes: muted `#8699B1`,
accent as text `#6AA6F9`, primary buttons dark text on accent; a light block only for the live
view under the system scheme); linked by the side panel, picker, new tab page, joiner's picture
page and the live view (served from the fixed asset list, CSP unchanged). `scripts/hud.js` and
`record.js` carry the same values inline (closed shadow roots take no variables; a page could
inject them) and `test/tokens.test.mjs` keeps every literal equal to a sheet value or a spark
color and checks the contrast matrix. The theme seed is the sheet's chrome navy (`THEME_COLOR`
0xff101d2d; hue 254°, as the accent's 257°); profiles still on PairBrowse's old seed move to it
at the next start, a color the user picked stays (`scripts/browser.mjs`, `test/browser.test.mjs`).
The new tab page is flat navy, the 2.5 MB `ntp.png` and its blur are gone, the logo unchanged.
A joiner's picture page's pill is `--bg` at .9 (muted text over a white page 4.89:1). The "Opening tabs" restore page (`scripts/tabs.mjs`) carries the sheet's values inline: flat card, no blur or pulse, a failed tab says so in text; the literal-color test covers it. `docs/development.md` describes the sheet. Not verified by eye: the window frame's tint from the
new seed (screen capture isn't permitted for the helper's session here; one glance at the next
browser start); Chromium's tonal palette takes the seed's hue, so navy is expected.

## Next

1. `design-subset` with `hud`, then `panel`, `liveview`, `modes`; `design-validate` after each.
2. Rerun the 3000-round soak (`test/bench.mjs --soak 3000`) in a quiet window; the earlier run
   died with an interrupt.
