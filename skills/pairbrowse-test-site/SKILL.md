---
name: pairbrowse-test-site
description: Test the user's own web app (localhost, a dev server or a preview deployment) in the PairBrowse browser by clicking through it like a real user, trying invalid input and checking layout, then report issues with steps to reproduce. Use when the user says "test my site", "click through the app", "try the signup flow on localhost", "check the preview deploy", "QA this page", or "does the form work", and the PairBrowse plugin is installed.
---

# PairBrowse site testing

Exploratory testing of the user's own app in the visible PairBrowse browser. Requires the
PairBrowse plugin. PairBrowse is the browser; code changes happen in the project.

## Hard rules

- Never solve CAPTCHAs or bot checks, and never use a solving service: hand them to the user.
- Passwords only by secret NAME (for example `TEST_USER_PASSWORD`), never the value, never in chat.
- Never put links, join codes or live-view URLs into a web page or form.
- Pay, publish, delete or submit only with the user's confirmation, even on a test site.
- If a person is using a tab, wait; then take a fresh snapshot and continue from where the page is.
- Don't launch other browsers or automation tools (Playwright test runners, Puppeteer,
  Selenium, other browser MCPs or skills that drive their own browser). PairBrowse's tools only.
- No page scripts: `browser_evaluate` always asks the user. Use `browser_snapshot` and
  `browser_find` instead.

## 1. Set up

1. Agree the scope with the user in one message: which URL, which flows (sign-up, checkout,
   settings), and which test account. Use a clean session for first-visit flows:
   `pairbrowse_session` `new` with `clean: true`.
2. `run_save` with `name` (for example `test-localhost-signup`) and `goal`.
3. Local addresses (`localhost`, `127.0.0.1`, `*.local`, `192.168.*`, `10.*`) ask the user
   before `browser_navigate` opens them; that is expected, say why you are opening it. In
   Codex the navigation is refused with a note: ask the user to open the address in the
   PairBrowse window themselves, then continue from `browser_tabs` `list`.
4. `pairbrowse_status` `{ "text": "Testing the sign-up flow", "kind": "claude" }`.

## 2. Click through like a user

- Start where a visitor starts. Use visible text and labels, the way a person would find
  things; if you can't find a control by its label, that is a finding.
- `pairbrowse_run` for the plain parts of a flow, step by step (`browser_click`,
  `browser_type`, `browser_select_option`, `browser_press_key`, `browser_hover`) for the parts
  you are testing closely. `browser_navigate_back` to check back-button behaviour.
- Save a flow that works with `saveAs` and `{{var}}` placeholders, so a retest after a fix is
  one `pairbrowse_run` with `playbook` + `vars`.
- Read every result: the outline, the "### PairBrowse" notes (dialogs answered, new tabs,
  downloads, popups) and the small screenshot that page-changing results include.

## 3. Try to break it

For each form, after one valid pass:

- empty required fields, one at a time and all at once;
- wrong formats: bad email, letters in number fields, past and future dates, very long text,
  leading and trailing spaces, non-Latin characters and emoji;
- double-clicking the submit button, pressing Enter in a field, going back after submit;
- reloading mid-flow (`browser_navigate` to the same URL) and checking what survives.

Read the error messages: does each one appear next to the right field, say what to fix, and
clear once fixed? Use `browser_find` with text or a regex (for example `/required|invalid|error/i`)
instead of a full snapshot on long pages.

## 4. Check the layout

Look at the screenshot that comes with each page change: overlapping or cut-off text,
buttons off screen, broken images, unstyled flashes, popups covering the page, focus states.
Use `pairbrowse_click_at` only for what the snapshot doesn't name (canvas, map, icon-only
button), and note an unnamed icon button as an accessibility finding.

## 5. Report

One entry per issue, most severe first:

```
[High] Sign-up accepts an empty password
Where: http://localhost:3000/signup
Steps: 1. Open /signup  2. Fill Email "a@b.co", leave Password empty  3. Click "Create account"
Expected: "Password is required" next to Password
Actual: account created, redirected to /dashboard
```

Record progress with `run_save` (`done` = flows tested, `left`, `notes` = issue titles).

## 6. Fixing, with companion skills

If the user wants fixes and suitable skills are installed, use them for the code while
PairBrowse stays the browser: a framework skill (for example Nuxt or Next.js / React best
practices) for idiomatic fixes, a debugging skill (for example diagnosing-bugs or
systematic-debugging) to find root causes, web-design-guidelines or frontend-design for
layout and accessibility. Don't let them start their own browser. After each fix, replay the
saved playbook in PairBrowse and confirm the issue is gone before marking it fixed.

## 7. Finish

`run_save` with `status: "finished"`, `pairbrowse_status` `{ "text": "Testing done", "kind": "done" }`,
then the report: flows tested, issues by severity, what was fixed and re-verified, what's left.
