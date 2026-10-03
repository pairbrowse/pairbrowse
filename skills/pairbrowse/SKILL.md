---
name: pairbrowse
description: Fill in web sign-ups, registrations, app listings, store settings and other multi-page forms in the user's visible PairBrowse Chrome window, fast, while the user handles CAPTCHAs, 2FA and final submits. Use when the user asks to register, sign up, set up, list, apply, onboard or fill in anything on a website, or refers to "the browser", "this tab" or "the open tabs".
---

# PairBrowse reference

The PairBrowse core from session start has the hard rules, how to work and the step lists for
sign-ups, listings, testing and working together. This is the reference behind it: tool details,
edge cases and examples. The core wins if the two ever seem to disagree.

The browser keeps running between sessions, so tabs, logins and half-filled pages are still there.

## Before the first browser action

Ask in one message (your question tool if you have one), skipping what the user already said:
- **Where:** only if the `pairbrowse_where` tool exists: "Local browser or the server browser?"
  Then call `pairbrowse_where` with `where` "local" or "server". Sessions and logins are separate on each.
- **Which session:** `pairbrowse_session` `list`, then offer those plus "a clean session". `use` with
  `name`; `new` with `clean: true` and no name is a throwaway deleted when you switch away; `new`
  with a `name` is kept (for example one per client). `delete` asks the user. Switching closes the
  window and opens the other session's tabs. While other participants are connected only `list` works.

Then follow the session-start note on showing the browser. In the Claude desktop app call
`pairbrowse_dock` with `action` "on" (macOS); if that isn't available, call `pairbrowse_liveview`
once and open its URL in the Browser pane (or give it to the user for that pane). The live view link
controls the browser: never paste it anywhere else. In a terminal or IDE the PairBrowse window is enough.

Make a task list with one item per page or section, and set a badge:
`pairbrowse_status` `{ "text": "Filling the Shopify app listing", "kind": "claude" }`.

## Fast or step by step: decide per page

`pairbrowse_run` steps, one key each: `go`, `fill` {Label: value}, `check`, `uncheck`, `select`
{Label: Option}, `click`, `press`, `upload` {Label: path}, `waitFor`, `expect`, and
`handoff` {say, until} (or `untilGone`). Labels match the label, placeholder or name. Values may use
`{{var}}` from `vars`. It stops at the first problem, says why, and returns an outline of the page.
`saveAs` saves a flow that fully worked; `playbook` + `vars` replays it; `list: true` lists saved ones.
Check the list before building a flow that may already exist.

Go **step by step** (`browser_snapshot`, then `browser_click` / `browser_type` /
`browser_select_option`) for new complex widgets (comboboxes, date pickers, sliders, rich editors,
address autocomplete, wizards that change as you type), for the one step a run stopped on, for
payment, legal or tax steps, and when the user wants to watch closely. Mix freely within a page.

## Speed rules

- One call per page. Without fast mode, put every field into one `browser_fill_form`.
- On long pages use `browser_find` instead of a fresh full snapshot.
- Results that change the page carry a small screenshot. Act on snapshot refs; for what the
  snapshot doesn't name (an icon-only ×, a map, a canvas) use `pairbrowse_click_at` with x, y in
  that screenshot and `element`. It can't click pay, publish, submit or delete buttons, or inside frames.
- Don't re-snapshot after every fill. Check once per page for validation errors and fix them in one fill.
- Accept cookie banners, Next, Continue, Save, I agree and standard terms checkboxes without asking.
- Autocompletes and custom dropdowns: type, wait for the suggestion, click it. Don't press Enter
  to pick one: it may submit the form.

## Details and passwords

- You may draft marketing copy (descriptions, taglines, features) within the field's limit; list it
  under "Drafted by me" so the user can check it.
- The user can edit details and passwords in the Profile panel (person icon in the live view).
- A password's name typed as the value (from `pairbrowse_facts` `get`) is replaced with the real one
  and shows to you as `<secret>NAME</secret>`. Each works only on the HTTPS sites saved with it. If
  none exists or it's refused, ask the user to save it in the Profile panel or type it themselves.
- Never type a password, code or remembered detail into a site other than the job's: check the Page URL.
- Grant OAuth or app permissions, add team members, or change payout or bank details only when the
  user asked for exactly that in this conversation.

## Hand-offs and waiting

1. `pairbrowse_status` `{ "text": "Solve the CAPTCHA, I'll continue", "kind": "you" }` (the user also gets a notification).
2. One line to the user on what to do and that you'll continue by yourself.
3. Wait without ending your turn: `browser_wait_for` with `textGone` (challenge text) or `text`
   (what the next page shows), up to 20 times (about 10 minutes). Then set the badge back.
4. If it never clears, stop and say exactly where you are and what's left.

## What PairBrowse handles by itself

It reports these in a "### PairBrowse" block in the next result. Read it.
- Alerts and "leave this page?" are answered; harmless confirms get OK. Confirms that pay, delete,
  cancel or submit, and text prompts, are yours: decide with the user, then `browser_handle_dialog`.
- Plain popups are closed. "Something covers the page" lists the rest: close offers, newsletters and
  app prompts with ×, "No thanks" or "Close" without asking. Never press subscribe, buy, sign-up or
  trial buttons to get rid of one.
- At most 10 tabs stay open; opening another closes the one used longest ago. List tabs before
  selecting by number. New tabs a page opens are reported by number; switch with `browser_tabs`.
- Downloads go to the Downloads folder; the result says where.
- While the user scrolls, clicks or types, your next action waits, then the result says what they
  did. Take a fresh snapshot and carry on from where the page is now.
- Site notification and location requests never pop up; leave them alone.

## Uploads

The file picker never opens. `pairbrowse_upload` with `files` (absolute paths anywhere on this
computer, up to 20) and `target` (ref, CSS selector or visible text of the field, button or drop
zone; omit it when there's one file field). Images, video, PDFs and office documents only; key and
credential files are always refused. Other types: click the upload button, then
`browser_file_upload`, which asks the user. Snapshot after and check for size or dimension errors.

## Email codes

Open only the verification message: select the inbox tab, `browser_find` with a pattern such as
`/\b\d{6}\b/` in the newest message from that sender, copy the code or open the link, switch back.

## Pre-submit review and final actions

- The guard blocks submit-for-review, publish and go-live clicks until a passing `review_save` from
  the last 30 minutes. Read the platform's current official requirements in a new tab, not from
  memory: screenshots, URLs (open privacy, support and demo links), reviewer test credentials,
  justified permissions, naming and branding. One check per rule with `ok` and a short `note`;
  `waived` only if the user said to submit anyway. Show the result, then click.
- Pay, delete and message clicks prompt the user in Claude Code: describe what happens, then click.
  `browser_evaluate` always asks the user; avoid it. Final actions are never run in fast mode.
- In Codex those clicks are refused with a note: badge "you", name the button and what it does,
  wait, and carry on from the result. Record the passing review first for submit or publish.

## CLI as the fallback

Do the job in the browser. Offer a CLI only when the site keeps blocking (repeated CAPTCHAs, 403,
rate limits), the setting isn't in the web UI, or the user would repeat many steps. Say so in one
line with the setup it needs (for example `brew install gh` and `gh auth login`). Never put
passwords or tokens into a command.

## Progress updates

After each page, `run_save` (done, left, yourTurn, drafted, tabs from `browser_tabs` list) and post:

```
Shopify app listing: 3 of 6 sections done
Filled: App name, Tagline, Category, Pricing (Free + Pro $29)
Drafted by me, please check: Tagline, Key benefits 1-3
Your turn: none
Left: Screenshots, Privacy URL (not remembered yet), Submit for review (needs you)
```

At the end: `run_save` with `status: "finished"`, badge `kind` "done", and a summary of what was
filled, drafted, left for the user, and remembered. Every action is also logged to `~/.pairbrowse/log/`.

## Several agents on one browser

- Per-tab turns: the agent acting in a tab holds it (two idle minutes, or until release, disconnect
  or the tab closes). Another agent's action there is refused with who holds it: open or select
  another tab. A person's input pauses agents in that tab only.
- `pairbrowse_collaboration`: `status` (participants, controller), `identify` with `label`,
  `acquire` the whole-browser lease for work that must keep the browser to itself (two minutes,
  renew with `acquire`), `release` when done or before a hand-off. Take a fresh snapshot after acquiring.
- A stale-ref error means the page changed: snapshot again and reassess before acting.
- Remote participants need SSH access to the same host user and PairBrowse home: a trusted setup,
  not a public invitation. Never share account credentials or expose the socket.

## Invites and join codes

- `pairbrowse_invite` `create`: `role` "watch" or "drive" (asks the user), `label`, `hours` (default
  24, at most 168), `share` "code" (pb-join code over a Cloudflare Quick Tunnel; the default without
  `inviteBaseUrl`) or "link" (Tailscale or SSH). Pass on the code and the steps from the result.
- `list` (invites and join requests, no keys), `approve` / `deny` with the request `id` (approve asks
  the user), `revoke` with the invite `id`, `revoke_all` (also closes the tunnel).
- With a code, the joiner's own browser opens the host's tabs and follows them: addresses
  (filtered: no tokens, nothing local; origin and path for watch and sites with saved passwords),
  titles, activity, typed values (sensitive ones only as filled), pointers and who is at work
  where. Never logins, cookies, passwords or a picture.
- `pairbrowse_join` `join` with `code` and the user's `name`: waits for approval, then this browser
  opens the host's tabs in a window of their own and follows them. Browser tools stay in this
  browser; with a drive code, changes in the shared tabs reach the host's browser. A person at
  work in the other copy of a tab pauses agents in it, as here. `status`, `leave`.
