# Changelog

Every PairBrowse plugin release, newest first. Each version is tagged `vX.Y.Z` in this repository.
Native browser builds are released separately as `browser-<version>` on the
[GitHub releases page](https://github.com/pairbrowse/pairbrowse/releases), with their SHA-256s, signed
release check and VirusTotal reports. No release so far fixed a vulnerability with a CVE.

## 0.15.27 (2026-10-08)

- Joining a shared session shows it: the shared window comes to the front once this browser's own saved tabs are back, instead of staying hidden behind them.
- A joiner sees the host's agent's pointer for as long as the host sees its cursor (while it works), and it goes when the agent is done.

## 0.15.26 (2026-10-08)

- Agents in different tabs act at the same time: two agents drawing in two tabs no longer wait for each other. Actions in one tab still take turns, and browser-wide actions (opening a tab, switching the session) wait for all.
- The tab strip says who works where: the agent's name goes in front of its tab's title ("Claude (Mac) · Inbox") while it works there. Agents, saved sessions, the live view and joiners still get the page's own title.
- Recordings: the strip above the video no longer names the agent twice.

## 0.15.25 (2026-10-08)

- Record the browser: the side panel's Record button, or `pairbrowse_record` for agents. The video (60 fps, the browser's own tab capture, no screen permission) follows the tab in front, or with `follow: "agents"` the tabs agents work in, under a strip naming each tab and its agent. Saved in Downloads.
- Agents check their own work: a fast-mode run reports fields the page flags as wrong (in the page's own words) and dropdowns that show another choice, and agents are told to look at each result and fix mistakes (forms, drawings, missed clicks) before going on.
- Drawing is faster: after the first stroke, the hand glides to the next one in a fraction of a second instead of a slow reach; two agents drew a full house in under a minute.
- An agent's cursor and name stay on screen while it works, also while it waits its turn between actions, and go when it's done or leaves.

## 0.15.24 (2026-10-07)

0.15.23 with its form-filling change corrected (its release check failed on it).

- A fast-mode form fill waits while a person uses the tab, then goes on, leaving the fields they filled alone; 0.15.23 stopped the run instead. Drawing strokes still stop at once.
- An agent's own typing is never taken for a person's (0.15.23 could, on a busy computer).

## 0.15.23 (2026-10-07)

People always come first, also mid-action; two agents on two computers can build on one board together; sharing survives restarts and dropped links.

- When you click or type in a tab, the agents in it stop and wait until you're done, also while one is in the middle of an action: a long drawing stroke stops at once, and a fast-mode form fill waits for you before its next field, then goes on and leaves the fields you filled alone. Before, input made while an agent acted was taken for the agent's own and ignored. Pause agents now always works too (only Resume is refused while an agent acts, so an agent can't undo a person's pause).
- A join request shows again in the bar after you reload the page; only your × or an answer takes it down.
- Agents on two computers in a shared browser session can share a tab when the user means them to; sharing a tab means taking turns (one pointer, one selected tool). To build something at the same time in an app that keeps everyone in sync (a whiteboard, a design file, a shared doc), agents open the same address in a tab each, and they're told so.
- Drawing strokes go at a drawing pace: about 3 s for a 30-point stroke instead of 19 s (the humanized mouse used to give every point of a stroke a whole reach-and-settle move).
- A joined agent never falls back to its own browser: while the link to the host is down, its calls wait up to a minute for it to come back, then say nothing was done. Before, they silently ran in the joiner's own browser.
- Answers to a joiner's agent survive the link dropping and reconnecting (kept for two minutes and sent again), instead of leaving the agent waiting up to 15 minutes.
- One helper at a time, settled before anything starts: when several Claude Code and Codex windows each start a helper at once (after an update or a crash), the extra ones now leave before touching the browser or the sharing tunnel. Before, they could stop the kept tunnel, so joiners couldn't reconnect after a restart.
- A session switch opens exactly one browser, even while other parts ask for the browser during it (before, it could open two windows and lose track of one).
- The helper log now says where a join request was answered (the bar, the side panel, a notification) and why a click in the bar didn't count.

## 0.15.22 (2026-10-07)

The native browser installs again on Linux systems that block user namespaces.

- On Linux without user namespaces (containers, and Ubuntu's AppArmor rule that restricts them), Chromium turns to its setuid sandbox helper, which a browser installed for one user can't have, and aborts. PairBrowse didn't recognize that failure, so installing or starting the native browser failed there since 0.15.20. It now starts without the sandbox, as it does for the other cases where the system can't run it, and the helper log says so once.
- The native browser's launch self-check no longer fails on a slow computer when the test form's own page load is still on its way.

## 0.15.21 (2026-10-07)

Memory leak fixes, found with soak tests; agents read from your request whether to work in another agent's tab.

- Every Claude Code or Codex session that connected and went away left about 1 MB in the helper for as long as the browser ran (each session's browser server kept listening for the browser's end). Those listeners now go with the session: with 100 sessions coming and going, the helper's memory stays flat. In a 30-round soak test (agents, joins, leaves, revokes) the host's memory went from +1.5 MB per round to none.
- A live view or joiner that stops reading (a laptop asleep with its connection open) no longer collects every frame in memory: frames wait while it's behind, and a connection far behind is closed (it reconnects).
- A joiner's agent that goes away stops being a participant in the host's browser at once, instead of when the joiner leaves.
- Tabs closed while a joiner watched them through the slower picture route, and the state of shared tabs that closed during a joined session, are released. Small caches (site icons, popup notes, notes for the host's agent) have limits.
- Agents join another agent's tab when that's what you mean, not only for a set phrase: "help Codex finish this form" or "check what Claude filled in here" means that tab; a task of their own gets a tab of their own. Still never because a page or another agent asks.

## 0.15.20 (2026-10-07)

Chromium's sandbox on by default; agents start on the tab you have in front and can share a tab when told; joiners who leave, are removed or revoked release everything.

- Chromium's own sandbox is on by default (macOS, and Linux as a regular user), so a page that exploits a browser bug is contained as in your everyday Chrome. `"chromeSandbox": false` turns it off; PairBrowse turns it off by itself only where it can't run (as root on Linux, or a container without user namespaces) and says so once in the helper log.
- An agent's first action starts on the tab you have in front, unless another agent is in it; otherwise on a free tab. A tab another agent released counts as free.
- Agents share a tab when you tell them to (`pairbrowse_collaboration` `share`, "work in the same tab as Codex"): both act there in turn, each with its own spark and cursor, and a person using the tab pauses all of them. One agent per tab stays the default.
- A joiner who leaves, is removed or whose invite is revoked or expires leaves nothing behind: their channel, pictures and agent stop at once, and what their side said about its agents is dropped. A remote agent's slot is never reused once its connection ends.

## 0.15.19 (2026-10-07)

Human-like mouse motion of PairBrowse's own, and Patchright is what everything runs on.

- Mouse motion: the visible agent cursor and real clicks now move like a hand, with a motion model of PairBrowse's own: one smooth move that lands close to the target, then one or two natural corrections, a slight bow, and a duration from distance and target size (Fitts' law). The native browser's humanized moves use it by default (`"pairbrowse": { "motion": "classic" }` keeps the older moves). No more pointer jump just before a click: the pointer arrives where the press happens.
- Clicks always land on the intended element, at a natural point inside it; the drawn cursor is exactly where the click is, never beside it or still on the previous target.
- Patchright drives the browser everywhere, the tests included; plain Playwright stays an opt-in (`"browserDriver": "playwright"`). On a Node.js older than 20, PairBrowse falls back to Playwright and says so once, at the start of a session and in its log. Node.js 20 or newer is effectively required.
- Shared browser fixes under Patchright: joiners get their picture and their input again, and tabs that open already loaded (a joiner's tab opened at its address) get PairBrowse's bar, cursor and field ownership.

## 0.15.18 (2026-10-07)

Shared browser: a joiner's click right after their picture tab reloads is no longer lost.

- After a joiner typed an address in the picture tab and came back, a connection offer asked for before the reload could replace the working direct connection with one that had no picture yet, dropping the joiner's next click (mostly on busy computers). Each picture page now has an id, an offer applies only to the page it was asked for, and stale ones are refused and closed on the host side.

## 0.15.17 (2026-10-06)

The side panel loads its new version after an update, so join notifications have their Allow and Deny buttons.

- After an update the browser could go on running the side panel's previous version, which the browser keeps in your profile: join notifications then came without Allow and Deny. Now the side panel reports its version, and when it changed since the browser last started, the browser loads the new one from disk before it opens. Sites' background workers in the PairBrowse profile are reset with it (they come back on your next visit to the site); their stored data stays.
- If the helper still finds an old side panel running, it says so in its log and the next browser start loads the new one; until then join requests are announced by your system's notification and answered in the side panel.
- Tests: the two-machine test always removes its Docker container, also after Ctrl+C, a kill or an earlier interrupted run.

## 0.15.16 (2026-10-06)

Join requests answered in the page's bottom bar or the notification, one at a time.

- When you're looking at the browser (its window has the focus and a web page is in front), the bottom bar of that tab asks at its right end: "Sam (Claude Code) wants to join (drive) · Allow · Deny · ×", for about 10 seconds, with who's driving and Claude's last actions still on its left. Several requests: the newest, with "+N more in the side panel". No notification then. The separate prompt in the tab's corner is gone.
- When you're not (another app in front, the window minimized, the new tab page or session picker in front), a notification instead, now with Allow and Deny buttons; clicking it brings the browser to the front, where the bar asks if the request is still waiting. A request whose time in the bar ran out while you were away asks again when you come back. Without the side panel the system's notification is used, text only, pointing to the side panel.
- Whether you're looking is read from the browser itself (the side panel's worker), not from the page. The side panel still lists every waiting request.
- The same rules as before: only your own real click counts in the bar, never an agent's, a page script's, a joiner's or the live view's; a notification's button answers only the request it was made for. See the Security table.

## 0.15.15 (2026-10-06)

Join requests: answer them in a prompt in your own tab, and clearer invite and join copy.

- When someone asks to join, a small prompt ("Sam (Claude Code) wants to join (drive)") shows in the bottom-right corner of the tab in front, with Allow, Deny and a close. It goes by itself after about 10 seconds (the request stays in the side panel) and comes down once the request is answered anywhere, revoked or expires.
- Only a real click by you counts on it: never an agent's, a page script's, a joiner's or the live view's input, nor a click while it is covered or just appeared. See the Security table.
- Claude now hears your Allow, Deny and Remove from the side panel, the live view or the prompt in its next result.
- A joiner you remove sees "<host> took you out of the session." instead of "didn't let you in".
- Answering a request that is already gone (answered elsewhere, or timed out) now says so in the side panel and live view, instead of a button that does nothing.
- Invite, join and notification wording now points to the side panel (and the prompt), and says what really happens: someone turned away or removed who tries the code again is asked about again (revoke the invite to stop it), codes survive a restart of PairBrowse and end when you close the browser window. The sharing docs, the together skill and the tool descriptions are corrected to match, including shared browser mode as the default.

## 0.15.14 (2026-10-06)

Security and reliability: 21 bugs found by new fuzz and connection tests, fixed, each with a regression test.

- A connection reset while being refused on the joiner port (reachable through the public tunnel) no longer crashes the host's helper; nor does a `null` line on the helper's socket or the bridge's input.
- A malformed tool call is refused at once instead of holding every agent's queue.
- Uploads: credential folders can't be reached with other casing (macOS) or through a link in the uploads folder.
- A drag named as a final action at either end asks first.
- A saved password that contains another is masked whole; values with unusual line separators survive saving.
- Secret query strings no longer cross to joiners after brackets, on IPv6 addresses or before a line break; local IPv6 addresses aren't named; malformed data from a joiner is refused instead of throwing; names drop invisible formatting characters.
- Host folders are hidden in a joiner's agent's results also inside web addresses, without mangling them.
- Joined sessions: a person's click is never lost when the page answers slowly, and a joiner's clicks always reach the host's agents.
- Playbook placeholders like `{{constructor}}` are reported as missing; old snapshots with passwords are cleaned up on time.
- New tests: fuzz properties for sharing and the user's guards, live connection tests (helper killed, churn, drops, malformed input), unit tests for six modules.

## 0.15.13 (2026-10-05)

Faster human-like typing; switch sessions from the side panel; one stuck call no longer holds up every agent.

- Human-like typing is about 95 words a minute instead of 60 (new engine pack; `"pairbrowse": { "typingPace" }` sets it, 0.2 to 1).
- Side panel: "Switch session..." opens the session picker again at any time.
- Only sessions that used the browser in the last 10 minutes hold up an agent's session switch; open but idle ones don't.
- A call that holds the shared browser queue for more than 10 minutes is answered with an error and the browser resets, so other agents go on.

## 0.15.12 (2026-10-05)

Shared browser fixes found by the live tests, now run in CI; lint; project docs. The first release with a signed tag.

- Shared browser: an address typed in the picture tab always reaches the host's tab, also right after the host moved its tab (it was sometimes lost on a slow computer).
- Shared browser: a pointer resting over a page no longer counts as the person reading it.
- The safety hook no longer reads the config file on every call (left over from a removed setting).
- Live browser tests run in CI on every push and pull request, with coverage (81.6% of statements); ESLint in CI.
- Governance, roadmap, code of conduct, architecture and assurance case docs; how to report and how reports are handled, in SECURITY.md.
- Release tags are signed; see SECURITY.md to verify one.

## 0.15.11 (2026-10-05)

Tunnels stop without a helper; signals only to our own keeper; more paths hidden.

- Each Quick Tunnel runs under a keeper of its own (tunnel-keeper.mjs) that stops cloudflared once no PairBrowse helper has touched its heartbeat for 2 minutes: a restart still keeps join codes, but a crash or a helper that never comes back leaves no public address forwarding to a port another account on the computer could take.
- A tunnel from an earlier run is taken over, watched and stopped only while its process is our keeper for that same port (checked again before any signal), so a reused process id is never killed.
- A joiner's agent's results also hide temp, system and other-disk folders (/var/folders, /private, /tmp, /root, /Volumes, /mnt, /media, C:\Users, C:\Windows, C:\Temp and the real temp folder); web addresses stay whole.
- Shared-mode test: waits for the joiner's helper to see which picture is in sight, and for Alice's field to be free, instead of fixed sleeps (a busy computer made it fail now and then).

## 0.15.10 (2026-10-05)

Join codes outlive a restart; Remove after Allow; no host paths to joiners.

- A join code, the host's yeses and its tunnels now outlive a restart of the helper (an update, a crash): cloudflared runs on its own, the state is kept in ~/.pairbrowse/sharing.json (0600; keys and names only), and the next run takes over a tunnel only if it is still a cloudflared to the same port. Joiners reconnect by themselves, already let in, and their agent is set up again on the host without a word. Closing the browser window, revoking or expiry end it and delete the file.
- Side panel and live view: next to each person let in, "is in" with Remove (a real click). They're out at once (channel, pictures, agent), and that invite refuses them from then on.
- A joiner's agent's results name no folder on the host's computer: links to files saved there keep their name only, the home folder becomes "~".
- Side panel: idle agents with no tab fold into one line.
- New live test: the joiner stays in through a restart of the host's helper, with no new approval; revoking ends it, saved state and all.

## 0.15.9 (2026-10-05)

A joiner's agent gets only its own notes.

- The host's own notes (join requests, downloads) went to whichever agent answered first, a joiner's included. They now go to the host's agents only.
- What people did in a tab was labelled with whoever was there last, so the host's login steps reached the joiner's agent as "Sven used this tab". Each person's steps are now named as theirs, and "the user" is the reader's own person (the host, or the joiner for their agent).
- "went to" steps kept the whole address, so a login link's code reached the joiner's agent. Addresses in these notes now carry no query or fragment.

## 0.15.8 (2026-10-05)

Picker says it's waiting after 15 s; two-machine test both ways.

- An agent's first browser action, while the session picker is up, now waits 15 seconds instead of 3 minutes before saying the browser is waiting for the person to pick, so the agent tells them in chat instead of hanging silently.
- The two-machine Docker test runs both ways (Mac hosts and Linux joins, Linux hosts and Mac joins) and checks that a joiner's new agent starts on the tab the joiner looks at, or looked at last, and that its release frees the tab in the host's browser at once.
- Adds docs/review-2026-10-05.md.

## 0.15.7 (2026-10-05)

Joiner's agents hand tabs back at once; start on the tab last looked at.

- In shared browser mode a joiner's agent saying "release" now also releases its turns in the host's browser, where it holds them; before, its tabs stayed held for up to two minutes.
- A joiner's agent starts on the host tab its person is looking at, or, when none is in sight, the one they looked at last.

## 0.15.6 (2026-10-05)

A failed drag never leaves the mouse button held.

## 0.15.5 (2026-10-05)

Shared browser polish: who is in each tab, the real address, agents start on your tab.

- A joiner's agent starts on the tab its person looks at and takes its turn there: if the host's agent holds it, it hears "in use" and tries that tab again; with no tab of its own it never acts in someone else's.
- Each picture tab shows who works in the host's tab (name or spark before the title, their mark as the icon); on the host, a joiner using a tab by hand shows as a dot in their color.
- A picture shows the host tab's real address (lock, "Not secure"), its tab has the page's title, and its own address is short (screen.html#id). Title and address are said again until the page takes them (a typed address could drop them).
- A click whose element went away while it was read (a banner closed meanwhile) is answered "isn't on the page any more" instead of being taken for a final action.
- The join test waits for the joiner's click to reach the host instead of a fixed sleep.

## 0.15.4 (2026-10-05)

Agents can draw: fast mode's drag step.

## 0.15.3 (2026-10-05)

Shared browser: joiner's agent starts on the tab they view; Excalidraw test.

- A joiner's agent starts on the host's tab its person is looking at.
- "<host>'s tab · live" fades after a few seconds and comes back when the pointer goes near it, so it doesn't cover the page.
- PAIRBROWSE_TEST_EXCALIDRAW=1: the joiner presses R and drags through the picture on excalidraw.com; a rectangle appears in the host's drawing (read from Excalidraw's own storage).
- The test-only picture tool lists the picture pages.

## 0.15.2 (2026-10-05)

A joiner's pointer shows as theirs, not the host's.

## 0.15.1 (2026-10-05)

Live view no longer pulls you back to Claude's tab mid-switch.

## 0.15.0 (2026-10-05)

Shared browser mode: one browser for everyone, live and smooth.

- Drive joiners click, type, scroll, draw and upload in the host's tabs, logged in as the host; logins, cookies and passwords never leave the host. Input is checked before it's replayed; the host's clipboard is never used.
- A file dialog a joiner's click opens is shown on their computer; the picked files are sent over into that field.
- Pointers and agent cursors show with name tags on both sides.
- A joiner's own Claude or Codex works in the host's browser as a participant: turns, presence and its name apply; final actions are handed to a person; no host passwords, details, sessions, invites or host files (uploads only from files its side sent, checked by its own upload rules).
- Joiners' input counts as theirs (presence, field ownership), not the host's.
- Agents log how long they waited for a person.

## 0.14.21 (2026-10-05)

Natural single actions, fast fast mode; pairbrowse_scroll.

- Human-like input is on by default in the PairBrowse browser: an agent's single clicks, drags and typing move and type like a person.
- Fast mode (pairbrowse_run) is just fast: it turns human-like input off for its run, and its scroll step goes at once.
- New pairbrowse_scroll: the cursor moves onto the page and the wheel turns smoothly, so people watching see it. Agents use it instead of PageDown.

## 0.14.20 (2026-10-05)

The agent's cursor carries its name in its color.

## 0.14.19 (2026-10-05)

Smooth scroll step with the agent's cursor.

## 0.14.18 (2026-10-05)

Pointers, cursor and bar on Trusted Types pages; 3 s stall detection.

- YouTube and other pages that require Trusted Types refused the page script's HTML, so people's pointers, the agent's cursor and the bottom bar never showed there. PairBrowse's fixed templates now go through a policy of its own. New live test with a Trusted Types page.
- The host's heartbeat is every second; a joiner drops a stalled stream after 3 s and goes straight on to the standby tunnel.

## 0.14.17 (2026-10-05)

Scrollbar presses and scrolling keys no longer hold agents up.

## 0.14.16 (2026-10-05)

Never fall back to Chromium quietly; faster stall detection; agent cursor for selectors.

- The PairBrowse browser is required unless "browserEngine" is "chromium": a failed install or a platform without a build stops with the reason instead of switching engines. While it installs, a notification says so and actions answer "installing" at once.
- The host sends a heartbeat every 2 s; a joiner drops a stalled stream after three missed beats (at least 6 s) and tries the next tunnel, instead of waiting 40 s with pointers and typing frozen.
- The agent's cursor shows for selector targets too, not only snapshot refs.
- Join test: Alice types again before her field is checked (5 s window).

## 0.14.15 (2026-10-05)

Drive invites by default; joiners' new tabs cross; fields free sooner.

- Invites are drive unless the user asks for view-only (watch). The guard still asks before a drive invite is made.
- A drive joiner's new tab in the shared window opens on the host too, once it has a web address; tabs in the joiner's other windows stay theirs.
- A text field's "change" on leaving it no longer counts as the person typing (a value set from the other browser made the field look owned).
- A field a person typed in is theirs for 5 s after the last keystroke (10 s while they stay in it), not 2 and 10 minutes.
- Remote server mode removed (remote.mjs, setup-server.mjs, docs/server.md).
- Join codes and shared dev servers keep a standby tunnel; joiners move to it when one goes down, and dead tunnels are replaced (watchTunnel).

## 0.14.14 (2026-10-05)

Stop sharing tunnels that finish starting after sharing ended.

## 0.14.13 (2026-10-04)

Share your dev server with joiners.

## 0.14.12 (2026-10-04)

Remove the unused neverConfirm setting.

## 0.14.11 (2026-10-04)

Fewer interruptions: only real commitments stop a click.

## 0.14.10 (2026-10-04)

The agent in the loop judges unclear clicks; no click judge model.

## 0.14.9 (2026-10-04)

Click guard by structure and context, no word lists.

## 0.14.8 (2026-10-04)

the click guard by what a click does.

## 0.14.7 (2026-10-04)

Pin the browser builds now on the release.

## 0.14.6 (2026-10-04)

Shared sessions: agent turns across computers, typing pauses, scroll presence.

- An agent holding a tab holds it on every computer of a shared session: its turn (how long it still holds) crosses over the push channel both ways, and the other side's agents wait briefly or hear "in use by X (in Bob's browser)", never acting in their copy. The host's agent wins a tie.
- A person clicking or typing in a tab pauses every agent action there until they've been idle for two seconds, then agents hear what happened (names, never values). Moving the pointer and scrolling never pause, here or across browsers. Field ownership stays.
- Where each person reads (their own scrolling only) crosses, throttled, and shows as a small named mark in their color on the right edge of the other side's copy.
- A payment form's submit is a final action by structure, whatever its words ("Submit order"): card fields (cc-* autocomplete or a card-number value) or billing/shipping address fields. Clicks are refused until called a payment; Enter in such a form is refused; fast mode too.
- Form values: a card number replacing a plain value both sides had clears it on the other side instead of leaving it stale (and never echoes an empty value back); a card typed on one side is never overwritten from the other.
- A popup check that found nothing no longer swallows a person's click right after it.

## 0.14.5 (2026-10-04)

Session picker: the browser asks which session to start with.

## 0.14.4 (2026-10-04)

Start new profiles without a window so the new tab page is acknowledged.

## 0.14.3 (2026-10-04)

Capture the Mac host once, hidden; brand notification helpers.

- The Mac host fingerprint is captured once per Mac in a headless browser (real Metal GPU, real screen via --screen-info), cached 0600 in ~/.pairbrowse/mac-host-profile.json, keyed on browser version, hw.model and GPU; software WebGL renderers are refused.
- brandNativeApp names the notification helpers PairBrowse (Info.plist and every InfoPlist.strings), keeps their ID matched to the app, resigns under it; BRANDING 5 rebrands installed apps.
- Headless test browsers launch with --disable-notifications so test runs don't start a notification helper and trigger the macOS prompt.

## 0.14.2 (2026-10-04)

Give the side panel extension a fixed ID.

## 0.14.1 (2026-10-04)

pause agents, side-by-side editing.

## 0.14.0 (2026-10-04)

Release.

## 0.13.1 (2026-10-04)

PairBrowse: shared browser sessions for people and coding agents.
