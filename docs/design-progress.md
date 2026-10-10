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

## Done

(nothing yet)

## Next

1. `design-subset` with `tokens` (the shared sheet, the theme seed, the new tab page).
2. `hud`, `panel`, `liveview`, `modes`; `design-validate` after each.
