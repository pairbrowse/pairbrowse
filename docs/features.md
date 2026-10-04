# What PairBrowse does

- **Fast.** Claude reads the page structure (Playwright's accessibility snapshot) and fills a
  whole page of fields in one action. A small screenshot taken a second after each page loads
  shows it what the structure can't: what's covering the page, where an icon sits.
- **Works alongside you.** It sees every tab you have open in the PairBrowse window. You sign
  into Gmail once, and Claude copies verification codes from it into the form in the other tab.
- **A browser that stays.** A small PairBrowse helper keeps the browser running between
  Claude Code sessions, with your tabs and logins. When the browser itself restarts, PairBrowse opens
  your tabs again one by one, in order, behind an "Opening tabs" screen, so startup stays fast.
- **Sessions.** Separate browsers with their own logins and tabs (for example one per client),
  plus throwaway clean sessions that are deleted when you switch away. When the browser starts,
  its first tab asks which one you want: go back to a saved session, start a fresh one, or join a
  shared one with a code.
- **Secure by default.** No debugging port, a key-protected live view, passwords locked to their domains, a hostile page
  can't make Claude upload your files or type your secrets elsewhere. See [Security](security.md).
- **Resume tomorrow.** Each job is saved as a run (done, left, your turn, open tabs). A new
  session tells Claude about unfinished runs, so "carry on with the Shopify listing" picks up
  where it stopped.
- **Inside your workspace.** In the Claude desktop app, the live view shows the PairBrowse
  browser in the Browser pane, next to the chat. Click and type in it to solve a CAPTCHA or
  sign in without switching windows.
- **Uploads without Finder.** Clicking an upload button never opens the file picker. Claude
  finds the file you mean, copies it into its uploads folder, and attaches it.
- **Always reviews before submitting.** "Submit for review" and "Publish" are blocked until
  Claude has checked the listing against the platform's current official requirements and
  recorded a passing review. This can't be turned off.
- **Doesn't nag.** Typing, clicking Next, accepting cookie banners and standard terms all run
  without permission prompts. It stops only before paying, publishing, submitting for review,
  deleting or messaging people.
- **Keeps you posted.** A badge in the browser shows what Claude is doing and when it's
  your turn. Claude posts a filled / drafted / your-turn / left update after each page, and
  every action is logged to `~/.pairbrowse/log/`.
- **Remembers.** Company details live in the Profile panel; Claude and fast mode add to them,
  so it never asks twice.
- **Keeps passwords out of the model.** Claude types a secret's name. PairBrowse fills the real
  value from `~/.pairbrowse/secrets.env`, only on the sites you allowed for it, and masks it in
  everything Claude reads back.

## Why PairBrowse

Browser automation usually looks like `Agent → Browser`. PairBrowse is built around
`Human ⇄ Agent ⇄ Browser`: pair programming, inside the browser.

An agent can work through a site until it reaches something that needs a person: a login, 2FA,
a CAPTCHA, an ambiguous page, a sensitive action, or something you simply want to look at
yourself. Instead of losing the browser state or explaining everything through screenshots, you
step into the same browser:

```text
Agent working
    ↓
Agent needs you ("Your turn", with what to do)  or  you click, type or scroll in its tab
    ↓
Agent waits
    ↓
You finish the step
    ↓
Agent takes a fresh look at the page (old element references are refused)
    ↓
Agent continues
```

No fighting over the mouse, no separate browser state, no screenshot ping-pong, no restarting
the flow. Others can join too: invite a teammate to watch or co-drive, or let several agents
(Claude Code, Codex, any MCP client) share one browser, taking turns per tab.

It's useful for:

- sign-ups, registrations, app store listings and store settings
- testing your own site (localhost or a preview) and reporting what breaks
- debugging in the browser with a teammate or an agent
- remote pairing and QA, with watch or drive invites
- any human-in-the-loop agent work in a real, logged-in browser

## How a run goes

1. Claude lists your open tabs, reads the remembered details, and makes a task list of the pages ahead.
2. On each page: one snapshot, one batch fill, one validation check, then Next.
3. Missing a legal, tax, address or bank detail? It asks for all of them at once, in one message.
4. CAPTCHA, login or 2FA? The badge turns orange with "Your turn". Claude waits and continues
   by itself once the page moves on (up to about 10 minutes).
5. Email code? Claude switches to your inbox tab, copies the code, and switches back.
6. Upload? Claude copies the file into `~/.pairbrowse/files/uploads/` and attaches it.
7. Before Submit for review or Publish, Claude opens the platform's requirements, checks every
   rule, fixes what it can, and shows you the result. Then you confirm the click.
8. Pay or Delete? Claude Code asks you to confirm that one click.
9. Progress is saved after every page. Stop any time and resume another day.

## Design principles

- **Collaboration first.** How well people and agents work together matters more than having
  hundreds of automation commands.
- **Human control.** You can step in at any moment, and agents wait for you.
- **Ask instead of guessing.** When an agent isn't sure (a legal detail, an unclear page, a final
  click), it asks.
- **Agent agnostic.** Claude Code, Codex and other MCP clients share the same browser and rules.
- **Fast.** Browser actions should feel local; latency matters.
- **Persistent when useful.** Agents work in a real, logged-in browser that survives restarts.
- **Observable by default.** You can always see what an agent is doing and what it did.
- **Self-hostable.** The browser runs on your own machine; no cloud account needed.
