# Using PairBrowse

## Remembered details and passwords

The person icon in the live view's toolbar opens the **Profile** panel:

- **Remembered details** (company name, VAT number, addresses, contact...): add, edit or remove
  them. Claude saves details you tell it, and fast mode keeps what it filled in forms, so the
  next form fills itself. What you set yourself is never overwritten by what Claude or a form saw.
  Passwords, PINs, verification codes, card and bank numbers are never remembered.
- **Passwords**: save one with a name and the sites it may be used on, replace it, or delete it.
  It goes straight from the panel to `~/.pairbrowse/secrets.env` (readable only by you) and works
  at once. It's never shown again: Claude sees only the name, PairBrowse fills the real value on
  the listed HTTPS sites, and masks it in everything Claude reads back.

Details and passwords live on the machine the browser runs on. In a cloud session that's the
cloud container, which is reset when the session ends, so keep long-lived ones on your own computer.

## Sessions, and local or server

When the browser starts, its first tab is the session picker: your three most recently used
sessions with how many tabs each has and who used them ("Mac · You", "Bob · Codex", "Alice · Linux";
a **Live** badge when people are in it right now), the rest under **More sessions** with a search
field (continue one), **Start a fresh session** (a clean, throwaway browser) and **Join a
shared session** (paste a `pb-join:` code; the host still has to let you in). Claude's or Codex's
first browser action waits for your pick (after about 3 minutes it stops and asks you in the chat
instead), then carries on in the session you picked and is told which. Tell Claude first ("I want a
fresh session", "use the client-x session", "join this session: pb-join:...") and the picker never
shows. It doesn't show the very first time either (there's nothing to go back to), nor in cloud
sessions. Set `"sessionPicker": false` to turn it off: Claude then asks you in the chat.

Claude asks which browser to use (local or server) when a server is set up. You can also just say
it, for example "use a clean session on the server".

- `pairbrowse_session`: list, use, new (named and kept, or clean and throwaway), delete (asks you).
- `pairbrowse_where`: switch between the local and the server browser at any time.

Tabs: PairBrowse remembers each session's tabs, in order. When Chrome restarts, it shows an
"Opening tabs" screen and brings them back one by one, then puts you on the tab you were on.
Logins with "remember me" survive restarts; session-only logins last while the PairBrowse Chrome
stays open (it keeps running between Claude Code sessions), and end when Chrome itself quits.

## Fast mode and playbooks

Claude can send a whole page, or a whole flow, as one `pairbrowse_run` call: go, fill, tick, choose,
click, wait. It runs at machine speed (a typical signup page takes about 0.3 s) and returns a
short outline of the next page (about 50 tokens), so there's no model turn between steps.
A flow that worked can be saved as a playbook and replayed with new values in one call.
Each filled field is checked after focus leaves it, the way you'd tab out: date pickers and
masked fields that throw a pasted value away get it typed key by key, and a field that still
won't keep it stops the run with what it shows, instead of a silent "done".
Final actions (pay, publish, submit for review, delete, and any form submit that commits
something, judged by the page's structure, not its words) never run in fast mode: Claude uses a
normal click for them, so you confirm.

## Popups and notifications

PairBrowse keeps pages out of Claude's way: alerts and "leave this page?" prompts are answered,
and new tabs reported to Claude. Cookie banners and popups are found by their shape and place on
the page, in any language. Plain ones close by themselves (a standard "Accept",
`"cookieChoice": "reject"` in `~/.pairbrowse/config.json` picks "Reject" instead; an offer's ×
in its corner, also when it shows up seconds later); for the rest, Claude gets the popup's text
and buttons with the screenshot, and closes it. It never takes an offer to make one go away. A page's own confirm dialogs stay for Claude and you: PairBrowse never answers OK to one, and Claude's OK asks you. Site notification and
location requests never pop up: they show only as a small icon in the address bar (Chromium's
quiet prompts), and sites see the ordinary "ask" state, like in an everyday Chrome. Files a site hands over (invoices, exports) are saved to your
Downloads folder (`"downloadsDir"` to change it).

You and Claude can work in the same tab. When you click or type in the PairBrowse window, Claude's
next action in that tab waits (the bottom bar says "waiting… you're using the browser") and
continues when you've stopped for two seconds; moving the mouse or scrolling holds nothing up. Fields you fill are yours for two minutes: Claude
leaves them as you wrote them. Claude is then told what you did, which button or field, never what
you typed. "Pause agents" in the bottom bar or side panel stops all agents until you press Resume. A visible CAPTCHA or bot check, or Claude handing over for a
sign-in, 2FA or approval, shows "Your turn" and sends you a PairBrowse notification.

## Uploads without a file picker

Claude puts files into a page in one call, `pairbrowse_upload`: a screen recording it just
made, a logo on your Desktop, a PDF. It works with upload fields (also hidden ones), upload
buttons and drag-and-drop zones, and the macOS file picker never opens. Images, video, PDFs and
office documents go through; key and credential files never do (see Security).
