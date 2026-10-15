// Live view: the PairBrowse browser, streamed to a page you open in the Claude desktop
// app's Browser pane (or any browser on this computer). Clicks, scrolling and typing go back
// to the browser, so you can solve a CAPTCHA or sign in without leaving the workspace.
//
// Security: it starts with the browser (for its side panel), listens on 127.0.0.1 only, on a random port, and every
// URL carries a random 256-bit key generated at start. Requests with another Host or a
// cross-site Origin are refused, so other websites (including the pages open in PairBrowse)
// can't reach it. Invite links (createInvites) carry keys of their own with fewer rights, and
// the host names you add in liveViewHosts (say, for Tailscale) take invite links only.
//
// This file coordinates; the parts live in scripts/liveview/: http (checks, headers, the page),
// invites, input (replaying a viewer's input), joiner-server (the port the sharing tunnel
// reaches: shared tabs for joiners, never frames) and tabs.
import { ownTitle } from "./daemon/tablabels.mjs";
import { resolve, sep, basename } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { keepFocus } from "./focus.mjs";
import { createApprovals, personLabel, cleanName } from "./join.mjs";
import { stateForJoiner, readOps, shareableUrl, onSecretDomain, activityBudget } from "./tabsync.mjs";
import { createPush } from "./liveview/push.mjs";
import { hostOk, originOk, keyOk, readCapped, readJsonBody, parseJson, json, NOT_JSON, BODY_MAX, SECURITY_HEADERS, serveViewer, serveAsset, plain, pathParts, listen } from "./liveview/http.mjs";
import { createInvites, roleMay } from "./liveview/invites.mjs";
import { createInputReplayer, readViewerInput, inputBudget } from "./liveview/input.mjs";
import { createJoinerServer, recentlySeen } from "./liveview/joiner-server.mjs";
import { createIcons, guestTabs, guestActivity, withoutIcons } from "./liveview/tabs.mjs";
import { readLayout, layoutFrom, readDockTab } from "./liveview/layout.mjs";
import { hiddenFromLiveView, CHROME_PAGE_ORIGINS } from "../ui/urls.js";
import { APPROVAL_ID, ANSWERS } from "./daemon/approvals.mjs";
import { fileStill, openable, downloadMarked, openWay, confirmFor, isDocument } from "./daemon/toolstab.mjs";
import { scrub } from "./daemon/diagnostics.mjs";
import { within } from "./util.mjs";
import { NO_CAPTURE_SHARE, targetIdOf } from "./daemon/capture.mjs";
import { readPick } from "./daemon/pick.mjs";
import { REPORT_BODY_MAX } from "./liveview/report.mjs";
import { createActivityLog, readPageQuery } from "./daemon/activitylog.mjs";
import { PAGE_KINDS as PAGE_KIND_LIST } from "../ui/vocab.js";
import { FRAME_EVERY_MS, FRAME_SKIP_BYTES, STALLED_BYTES } from "../ui/limits.js";

export { hostOk, originOk, keyOk } from "./liveview/http.mjs";
export { liveViewHostsFrom, inviteBaseFrom, inviteLabel, createInvites, roleMay } from "./liveview/invites.mjs";
export { addressToUrl } from "./liveview/input.mjs";

const TICK_MS = 1500; // following Claude's tab, and the tab strip
const SETTLE_MS = 180; // the page is still this long: send one sharp frame
// Frames come as fast as they're acknowledged: at most one every FRAME_EVERY_MS (ui/limits.js; a
// form being filled or a page scrolling reads fine at 30; unpaced, a busy page encodes 60 a second).
const SHARP_QUALITY = 90;
const THUMB_QUALITY = { min: 20, max: 80, default: 50 };
const JOINER_NAV_MS = 15_000; // a joiner's change: until the host's tab starts loading it
const ACTIVITY_MAX = 30; // the activity event's lines; the session's log (activityLog) keeps more
const STATE_ACTIVITY = 4; // activity lines in state.json
const INPUT_BATCH_MAX = 500;
// A reader FRAME_SKIP_BYTES behind gets no new frames until it catches up; STALLED_BYTES behind,
// the connection is cut (the page reconnects). ui/limits.js.
const OWNER_ONLY = new Set(["profile", "join", "board", "dev", "joinhost", "layout", "agent-tabs", "timeline", "config", "approval", "driving", "outline", "downloads", "handoffs", "capture", "tab-order", "sessions", "invites", "overlay-pointers", "joiner-pointers"]); // events only the owner's streams get
// Events for the browser's own pages alone (streams opened with ?page=): the capture page's calls
// (liveview/capture.mjs), the tab strip's order requests and the pointers its browser draws over
// the page card (overlay-pointers). Never the live view page, a viewer
// or a guest. An event named here goes only to the page streams of that one kind (least
// privilege: the SDPs and recording calls reach the capture page alone); the others go to every
// page stream.
const PAGES_ONLY = new Set(["capture", "tab-order", "overlay-pointers"]);
const PAGE_EVENT_KIND = new Map([["capture", "capture"]]);
// The tab strip's report of every window's tabs (POST tab-order), checked.
const TAB_ORDER_MAX = 500;
const TARGET_ID = /^[A-F0-9]{32}$/i;
export function readTabOrder(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.tabs) || body.tabs.length > TAB_ORDER_MAX) return null;
  if (!Number.isInteger(body.focused) || !Number.isInteger(body.last)) return null;
  const tabs = [];
  for (const t of body.tabs) {
    if (!t || typeof t !== "object" || typeof t.target !== "string" || !TARGET_ID.test(t.target)) return null;
    if (!Number.isInteger(t.window) || !Number.isInteger(t.index) || t.index < 0 || typeof t.active !== "boolean") return null;
    tabs.push({ target: t.target.toUpperCase(), window: t.window, index: t.index, active: t.active });
  }
  return { tabs, focused: body.focused, last: body.last };
}
// The browser's own pages that open an events stream with ?page=<kind> (the owner's key only): a
// name for counting them, nothing more; they get no frame stream.
const PAGE_KINDS = new Set(PAGE_KIND_LIST);
const TIMELINE_ID = /^[0-9a-f]{12}$/;
const TOOL_ID = /^[0-9a-f]{12}$/; // a download, recording or hand-off (daemon/toolstab.mjs): never a path
const TIMELINE_OFF = "The timeline is off (timeline: false in ~/.pairbrowse/config.json).";
const SESSION_OP = 'A session change is { op: "rename", name, from? } or { op: "save" }.';
const SESSION_FIELDS = ["canRename", "canSave", "savedAt", "canRenameSaved"]; // the owner's streams only
const INVITE_ID = /^[0-9a-f]{8}$/;
// The invites as Settings lists them (GET invites.json, the invites event): never a key or a code.
const inviteItems = (list) => list.map((i) => ({ id: i.id, role: i.role, label: i.label, share: i.share, expires: i.expiresAt }));

const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };
// What the helper does for shared tabs beyond addresses (each a no-op until it's given).
// readForm(page): { url, fields } as they may cross, or null. applyForm(page, fields, who).
// onJoinerAgent(page, who, color, left, from, where): a drive joiner's agent works in their copy
// of the tab (left: ms its turn there still holds; from: that joiner; where: their name).
// arrange(pages): puts tabs in this order. order(pages): the pages as the tab strip shows them,
// or null. showPointers(page, list): draws the others' pointers
// there. sessionFor(j): who is doing what, for joiner j. onJoinerSay(body, j, key): who is doing
// what on a joiner's side, or a message from there (text only; any role).
const sharedDefaults = { readForm: async () => null, applyForm: async () => {}, onJoinerAgent: () => {}, arrange: async () => {}, order: async () => null, showPointers: () => {}, sessionFor: () => null, onJoinerSay: () => {}, onJoinerGone: () => {}, onJoinerLost: () => {} };

// Shows a tab in its browser window. (document.visibilityState can't tell: Playwright emulates focus.)
const bringTabForward = (page) => keepFocus(() => page.bringToFront().catch(() => {}));

// Runs tasks one at a time, in order; a failed task doesn't stop the next.
function serially() {
  let last = Promise.resolve();
  return (task) => {
    const run = last.then(task);
    last = run.catch(() => {});
    return run;
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Stops a tab's screencast and gives its window its normal size back.
async function release(cdp) {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await cdp.detach().catch(() => {});
}

// getContext(): the Playwright BrowserContext. currentUrl(): URL of the tab Claude is working in.
// hosts: extra host names from liveViewHosts. inviteOrigin: inviteBaseUrl's origin, where drive
// links post input from. invites: the helper's invite store (createInvites).
// Join codes (share "code" invites) are served on a second local port, the one the sharing
// tunnel forwards to: guestPort (0: any). tunnelHost(): the tunnel's public host name, or null.
// approvals: who the host let in (createApprovals). onJoinRequest(entry): a new joiner asks.
// tabMeta(page): who is in a tab ({ agent: { label, color }, person, last }).
// onHumanInput(page, who, changes): someone used a tab by hand (a drive joiner's tab changes count
// too); changes: false when they only moved the pointer or scrolled.
// onReplay(who): marks input replayed from a viewer while it runs (returns done()); who: an invite
// link's viewer's name, null for the owner.
// secretDomains(): sites with saved passwords, whose tabs reach joiners as origin + path only.
// onJoinerPerson(page, who, did, acting, changed, ago, heardAt): a drive joiner uses their copy of a
// tab by hand (agents here wait, as for a person here; changed: they navigated, opened or closed
// it). ago: how long before heardAt (when their news arrived here) they did: it can wait in line
// behind other input before it's applied.
// onJoinerActivity(page, text, who, from): their agent acted there.
// journal(): the goal log for the Timeline (journal.mjs read), or null.
// makeInvite(choice): the Share card's invite (sharing.mjs createInvite), or null.
// shared: the rest of what shared tabs carry (see sharedDefaults): form values, their agents'
// sparks, tab order and pointers.
// mask(text): as results are masked (saved passwords), for the tab strip's titles and the timeline.
// timeline: the session's pictures (daemon/timeline.mjs), or null. layoutDefaults: config.layout,
// or a function returning it (read whenever a session's layout starts). settings: the browser's
// own Settings page's three fields ({ read(), write(given) }, liveview/settings.mjs), or null.
// sessionOps: the session card and the sessions page ({ state() -> { canRename, canSave, savedAt,
// canRenameSaved (this helper renames saved sessions that aren't open: POST session's from) },
// current() -> the open session's name, rename(name, from?), save() }), or null. outlines: the Page tab's outlines (daemon/outline.mjs), or null.
// tools: the Tools tab ({ downloads, recordings, handoffs, diagnostics, open(path, how), marked(path)?,
// openTab(url, onClose)?, preview(entry, kind)?, personTab(page)?, engine()?, platform? },
// daemon/toolstab.mjs, daemon/preview.mjs and daemon/diagnostics.mjs), or null: files by id only,
// opened by the helper. personTab(page): a person's own tab (a file they opened from Downloads):
// the owner sees it (personal: true); guests never list, pick, close or type into it.
// onPagesKey(): called on every request authenticated with the browser's own pages' key under a
// loopback host; the receiver makes it idempotent (the helper deletes the key file).
// activityLog: the session's activity log (daemon/activitylog.mjs), for GET activity.json; by
// default one in memory for as long as this live view runs.
// reporter: Report a problem's relay ({ enabled(), relay(body) -> { status, body } },
// liveview/report.mjs), or null.
export async function startLiveView({ activityLog = null, reporter = null, tools = null, onPagesKey = () => {}, sessionOps = null, outlines = null, mask = (t) => t, timeline = null, layoutDefaults = null, settings = null, extraOrigins = [], getContext, currentUrl, log = () => {}, port: wantPort = 0, profile = null, onHumanInput = () => {}, hosts = [], inviteOrigin = null, invites = createInvites(),
  guestPort: wantGuestPort = 0, tunnelHost = () => null, approvals = createApprovals(), onJoinRequest = () => {}, tabMeta = () => ({}), secretDomains = () => [], onJoinerPerson = () => {}, onJoinerActivity = () => {}, shared: sharedGiven = {},
  onPause = () => ({}), pauseState = () => null, onRecord = async () => ({}), recordState = () => null, picker = null, devShare = null, devPanel = null, joinHost = null, relays = () => [], screens = null, remoteAgents = null, onReplay = () => () => {}, journal = null, makeInvite = null,
  clickApprovals = null, capture = null }) {
  const shared = { ...sharedDefaults, ...sharedGiven };
  const history = activityLog || createActivityLog({ mask });
  const key = randomBytes(32).toString("base64url");
  // A second owner key, for the browser's own pages (a native build's chrome://pairbrowse pages,
  // handed to them in an owner-only key file, never the command line): never in the owner's link,
  // the log or any event.
  const pagesKey = randomBytes(32).toString("base64url");
  // The capture page's own key (a build whose capture page reads one: native-engine
  // captureKeyed), new at each launch and handed only to that page in its own owner-only file:
  // the capture stream (?page=capture) and capture/reply take it besides the pages' key, so no
  // other page of the browser's (nor the owner's live view key) gets SDPs or answers for it.
  // null: the build takes none; the pages' key alone (never the owner's) still is required.
  let captureKey = null;
  const captureOk = (req, byPages) => {
    if (!byPages) return false;
    if (captureKey === null) return true;
    return keyOk(new URL(req.url, "http://x").searchParams.get("ck") || "", captureKey);
  };
  const clients = new Set(); // every open event stream
  const linkGuests = new Map(); // event stream -> the invite link it was opened with
  const owners = new Set(); // event streams opened with the owner's key (the Profile panel's updates go only there)
  const viewers = new Set(); // the ones that show the page (the PairBrowse side panel doesn't)
  const joiners = new Map(); // `${inviteId}:${joinerId}` -> { invite, joinerId, name, app, seen, inflight, ops }
  let shown = null; // the tab on screen: { page, cdp }
  let lastFrame = null;
  let lastFrameFrom = null; // the tab lastFrame came from (guests never get a person's tab's)
  let devState = null; // dev servers, for the owner's side panel
  let status = { text: "", kind: "clear" };
  let sessionInfo = { name: "", where: "" };
  let followed; // URL of the tab Claude is working in
  let followedPage = null;
  const activity = []; // newest last, at most ACTIVITY_MAX
  let collaboration = { participants: [], owner: null, active: null, humanUntil: 0 };
  let closed = false;
  let board = null; // who is doing what across a shared session, and its messages
  let driving = false; // an agent is acting (presence onActing), for the owner's pages while an approval waits
  const humanQueue = serially(); // people's input, in order
  const showQueue = serially(); // switching the shown tab: one CDP session at a time
  const replayer = createInputReplayer();
  const iconFor = createIcons();
  const kinds = new Map(); // event stream -> the browser page's kind (?page=), owner streams only
  let stripOrder = { sig: "", order: null }; // the tab strip's last report (POST tab-order); gone with this live view
  const loading = new WeakSet(); // tabs whose main frame is loading (watched from watchPages on)
  // The docks' layout, per browser session, in memory (the browser keeps its own in its profile).
  const layoutStart = () => layoutFrom(typeof layoutDefaults === "function" ? layoutDefaults() : layoutDefaults);
  const layouts = new Map(); // session name -> { left, right, strip }
  const layoutNow = () => ({ ...(layouts.get(sessionInfo.name) || layoutStart()) });

  const watching = () => viewers.size > 0;
  // People in the session the user joined (shared tabs), shown with everyone else here.
  let remote = [];
  // Tabs' ids for joiners: random, so they say nothing about the host's other tabs.
  const tabIds = new WeakMap();
  const idOf = (page) => { let id = tabIds.get(page); if (!id) tabIds.set(page, (id = randomBytes(4).toString("hex"))); return id; };

  const personTab = (p) => { try { return !!tools?.personTab?.(p); } catch { return false; } };
  // A person's tab showing a document preview -> its download's id (the owner's lists carry it, so
  // the shell can offer Open in Word beside that tab).
  const previewOf = new WeakMap();
  const personal = (p) => {
    if (!personTab(p)) return {};
    const id = previewOf.get(p);
    return id ? { personal: true, preview: { id, kind: "document" } } : { personal: true };
  };
  // Each tab with its number, without the browser's own pages (chrome://pairbrowse...) other than
  // a joiner's picture page (chrome://pairbrowse/screen/, like the extension's screen.html).
  const webPages = (pages) => pages.map((p, i) => [p, i]).filter(([p]) => !hiddenFromLiveView(p.url()));
  // Every tab, with who is in it (the agent holding it, with its spark color; a person using it
  // by hand) and the last thing done there: the tab overview.
  const tabsInfo = async () => {
    const ctx = await getContext();
    // The browser's own pages are never tabs here; the others keep their numbers in ctx.pages().
    return Promise.all(webPages(ctx.pages()).map(async ([p, i]) => {
      let meta = {};
      try { meta = tabMeta(p) || {}; } catch {}
      return { i, title: (await ownTitle(p)) || p.url(), url: p.url(), icon: await iconFor(p), shown: p === shown?.page, claude: p === followedPage,
        agent: meta.agent || null, person: meta.person || null, waiting: !!meta.waiting, last: meta.last || null, ...personal(p) };
    }));
  };
  // Guests' tab list: never a person's own tab.
  const guestList = (tabs) => guestTabs(tabs.filter((t) => !t.personal));

  // The tab strip's list (the browser's strip page, the owner only): each tab with its id, the
  // title masked as the goal log masks it, whether it loads, and who is in it.
  const agentOf = (meta) => (meta.agent ? { label: String(meta.agent.label || ""), color: String(meta.agent.color || "") } : null);
  const metaOf = (p) => { try { return tabMeta(p) || {}; } catch { return {}; } };
  const tabsStrip = async () => {
    const ctx = await getContext();
    const working = await currentUrl();
    const pages = ctx.pages();
    const active = pages.find((p) => p.url() === working) || null;
    return Promise.all(webPages(pages).map(async ([p, i]) => {
      const meta = metaOf(p);
      const url = p.url();
      return { id: idOf(p), i, title: mask((await ownTitle(p)) || url), host: hostOf(url), url: mask(url), icon: await iconFor(p), active: p === active, loading: loading.has(p),
        agent: agentOf(meta), person: meta.person || null, waiting: !!meta.waiting, ...personal(p) };
    }));
  };
  // Who holds which tab, from the tabs' addresses and the helper's own records (no page asked).
  const agentTabs = async () => webPages((await getContext()).pages()).map(([p, i]) => { const meta = metaOf(p); return { id: idOf(p), i, host: hostOf(p.url()), agent: agentOf(meta), person: meta.person || null }; });
  const agentTabsChanged = () => { if (kinds.size) agentTabs().then((list) => broadcast("agent-tabs", list)).catch(() => {}); };

  // Invited people who have the live view open, by name, as the participant list shows them.
  const guests = () => {
    const seen = new Map();
    for (const invite of linkGuests.values()) seen.set(invite.id, { label: invite.label, role: invite.role });
    for (const j of joiners.values()) if (recentlySeen(j)) seen.set(`${j.invite.id}:${j.joinerId}`, { label: personLabel(j.name, j.app), role: j.invite.role });
    for (const r of remote) seen.set(`remote:${r.label}`, r);
    return [...seen.values()];
  };
  const collaborationNow = () => ({ ...collaboration, guests: guests() });
  // Joiners connected right now (name, app, computer), for the session picker's "Live" badge.
  const joinersNow = () => [...joiners.values()].filter(recentlySeen).map((j) => ({ who: j.name, app: j.app || "", computer: j.computer || "" }));

  // The pause as guests get it: without who is paused on their own (the owner's only).
  const guestPause = (p) => { if (!p || typeof p !== "object") return p; const { perAgent, agents, ...rest } = p; return rest; };
  const broadcast = (event, data) => {
    const msg = sse(event, data);
    for (const res of event === "frame" ? viewers : OWNER_ONLY.has(event) ? owners : clients) {
      if (PAGES_ONLY.has(event) && !kinds.has(res)) continue;
      if (PAGE_EVENT_KIND.has(event) && kinds.get(res) !== PAGE_EVENT_KIND.get(event)) continue;
      // A reader that stopped reading (a laptop asleep with the connection still open) would
      // otherwise collect every frame in memory: frames wait for it, and one far behind is cut.
      if (res.writableLength > STALLED_BYTES) { res.destroy(); continue; }
      if (event === "frame" && res.writableLength > FRAME_SKIP_BYTES) continue;
      if (event === "frame" && linkGuests.has(res) && personTab(lastFrameFrom)) continue; // a person's own tab: never to guests
      // Link guests get addresses without query strings, like joiners.
      if (linkGuests.has(res) && event === "tabs") res.write(sse(event, guestList(data)));
      else if (linkGuests.has(res) && event === "activity") res.write(sse(event, guestActivity(data)));
      else if (linkGuests.has(res) && event === "session") res.write(sse(event, sessionInfo)); // never the owner's fields
      else if (linkGuests.has(res) && event === "pause") res.write(sse(event, guestPause(data))); // "Pause this agent" is the owner's
      else res.write(msg);
    }
  };
  const collaborationChanged = () => { broadcast("collaboration", collaborationNow()); agentTabsChanged(); };
  // The session as the owner's streams get it: with whether it can be renamed and saved now, and
  // when it was last saved (sessionOps). Guests and state.json get sessionInfo alone.
  const ownerSession = () => {
    if (!sessionOps) return sessionInfo;
    try {
      const st = sessionOps.state() || {};
      return { ...sessionInfo, ...Object.fromEntries(SESSION_FIELDS.filter((f) => st[f] !== undefined).map((f) => [f, st[f]])) };
    } catch { return sessionInfo; }
  };

  // The tab strip's order (a move by hand or by a drive joiner), read in the background: a slow
  // answer from the side panel's worker never holds up what joiners get. A new order goes out
  // with the next push; until the first answer, tabs go in the order they opened.
  let strip = [], stripAsk = null;
  const readStrip = (pages) => {
    if (stripAsk) return;
    stripAsk = shared.order(pages).catch(() => null).then((sorted) => {
      if (sorted && (sorted.length !== strip.length || sorted.some((p, i) => p !== strip[i]))) { strip = sorted; push.changed(); }
    }).finally(() => { stripAsk = null; });
  };

  // What one joiner gets (tabsync.mjs): the tabs that may cross, in order, with their addresses
  // filtered for that joiner's role; activity in those tabs; who is in the session.
  async function tabsFor(j) {
    const ctx = await getContext();
    readStrip(ctx.pages());
    const rank = new Map(strip.map((p, i) => [p, i]));
    const inStrip = ctx.pages().map((p, i) => [p, rank.has(p) ? rank.get(p) : strip.length + i]).sort((a, b) => a[1] - b[1]).map(([p]) => p);
    // A person's own tab never crosses, wherever it has gone since.
    const tabs = await Promise.all(inStrip.filter((p) => !personTab(p)).map(async (p) => {
      let meta = {};
      try { meta = tabMeta(p) || {}; } catch {}
      // A joiner's own agent isn't sent back to them; another joiner's is (their agents wait for it).
      const agent = meta.agent && (!meta.agent.joined || (meta.agent.from && meta.agent.from !== joinerKey(j))) ? meta.agent : null;
      // left: how long its turn there still holds (the joiner's agents wait or hear "in use"), in
      // whole seconds so the state isn't news every round.
      const left = agent?.until > Date.now() ? Math.ceil((agent.until - Date.now()) / 1000) * 1000 : 0;
      // at: when the person here last clicked or typed, while they act, rounded up to the second
      // for the same reason (a keystroke a second is news once; never older than it was). It
      // leaves as an ago (presence.mjs stateAgo), so the other computer's clock never matters.
      const actedAt = meta.sharedPerson?.acting && Number.isFinite(meta.sharedPerson.at) ? Math.ceil(meta.sharedPerson.at / 1000) * 1000 : null;
      return { id: idOf(p), url: p.url(), title: await ownTitle(p), agent: agent?.label || "", color: agent?.color || "", left, person: meta.sharedPerson?.who || "", acting: !!meta.sharedPerson?.acting, at: actedAt, did: meta.did || [] };
    }));
    const people = [...collaboration.participants.map((x) => x?.label || ""), ...guests().map((g) => g.label)].filter((x) => x && x !== personLabel(j.name, j.app));
    const state = stateForJoiner({ tabs, activity, people }, { drive: j.invite.role === "drive", secretDomains: secretDomains(), name: j.name, from: joinerKey(j), mapUrl: devUrl });
    // Shared dev servers (devshare.mjs): their addresses and this joiner's own token for them.
    const dev = devShare?.forJoiner(joinerKey(j), j.invite.role) || [];
    // Every tunnel address to this session (relay.mjs moves to another when one goes down).
    const urls = relays();
    return { ...state, ...(dev.length ? { dev } : {}), ...(urls.length > 1 ? { relays: urls } : {}) };
  }

  // A drive joiner's changes in the shared tabs: opened, moved to another address, closed, as if
  // by hand (presence pauses agents in that tab). Only addresses that may cross (never the host's
  // local network); ids the joiner can know.
  const joinerKey = (j) => `${j.invite.id}:${j.joinerId}`;
  // A tab on a shared dev server, as its shared address (null: not one).
  const devUrl = (url) => devShare?.toPublic(url) || null;
  devShare?.members((key) => joiners.has(key));
  // Shared browser joiners' pointers for the PairBrowse browser's overlay over the page card
  // (push.mjs pushOverlay): to the browser's own pages only (its strip passes them on to the
  // browser), each tab by its CDP target id. One at a time, the latest wins. The owner's live view
  // gets the shown tab's (joiner-pointers) and draws them over its picture: in plain Chromium,
  // which has no overlay of its own, that is where the host sees them (never drawn in the tab,
  // whose picture goes back to the joiners: nobody sees their own pointer trail their mouse).
  let overlayNext = null, overlayBusy = false, viewerPointersSig = "[]";
  async function overlayPointers(entries) {
    overlayNext = entries;
    if (overlayBusy) return;
    overlayBusy = true;
    try {
      while (overlayNext) {
        const list = overlayNext;
        overlayNext = null;
        const here = (list.find((x) => x.page === shown?.page)?.pointers || []).slice(0, 12);
        const sig = JSON.stringify(here.map(({ fresh, ...p }) => p));
        if (sig !== viewerPointersSig) { viewerPointersSig = sig; broadcast("joiner-pointers", here); }
        if (!kinds.size) continue;
        const tabs = [];
        for (const { page, pointers } of list.slice(0, 16)) {
          const target = page.isClosed() ? null : await targetIdOf(page, 1000);
          if (target) tabs.push({ target, pointers: pointers.slice(0, 12) });
        }
        broadcast("overlay-pointers", tabs);
      }
    } finally {
      overlayBusy = false;
    }
  }
  const push = createPush({ getContext, idOf, tabsFor, joinerKey, secretDomains, shared: { ...shared, toView: (page, x, y) => screens?.viewCached(page, x, y) || null, overlay: (entries) => { overlayPointers(entries).catch((e) => log("overlay", e?.message || e)); } }, tabMeta, isIn: (key) => joiners.has(key), sessionFor: (j) => shared.sessionFor(j), mapUrl: devUrl, onLost: (j) => lostJoiner(j), log });

  // Shared browser mode (invites with mode "shared", daemon/screenshare.mjs): a joiner sees the
  // tabs live and works in them. Here: setting up the direct connection for one tab (its offer
  // and the joiner's answer go over the join channel), and the slower route when there can be no
  // direct one (pictures and input through the channel).
  const pageById = async (id) => (await getContext()).pages().find((p) => !p.isClosed() && idOf(p) === id) || null;
  const lastInput = new Map(); // `${key}|${id}` -> when that joiner last acted there (presence, at most twice a second)
  function onScreenInput(page, j, id) {
    const key = joinerKey(j);
    return (ev, line, view) => {
      // Their pointer, for the others with their name: where they point in their picture of the
      // tab is a place in its view (never drawn in the tab itself: it would come back to them).
      if (ev.type === "mouse" && view) push.fromJoiner({ me: { id, x: Math.round(ev.x + view.sx), y: Math.round(ev.y + view.sy) }, t: Date.now() }, j, view.w > 0 && view.h > 0 ? { x: ev.x / view.w, y: ev.y / view.h } : null).catch(() => {});
      if (!line) return;
      const k = `${key}|${id}`;
      if (Date.now() - (lastInput.get(k) || 0) < 500 && line !== "clicked on the page") return;
      if (lastInput.size >= 500) for (const [x, t] of lastInput) if (Date.now() - t >= 500) lastInput.delete(x); // only the last half second counts
      lastInput.set(k, Date.now());
      onJoinerPerson(page, j.name, [line], line !== "scrolled");
      onHumanInput(page, j.name, line !== "scrolled");
    };
  }
  // A file dialog the joiner's click opened: they pick the files on their computer; they arrive
  // in their folder here (remoteFile) and go into the field. token -> { page, chooser, key, at }.
  const picks = new Map();
  function onScreenPick(page, j, id) {
    const key = joinerKey(j);
    return ({ chooser, multiple }) => {
      for (const [t, p] of picks) if (Date.now() - p.at > 10 * 60_000) picks.delete(t);
      const token = randomBytes(8).toString("hex");
      picks.set(token, { page, chooser, key, at: Date.now() });
      push.broadcast("screen", { op: "pick", id, token, multiple: !!multiple }, { to: key });
    };
  }
  async function screen(body, j) {
    if (!screens) return { problem: "Shared browser mode isn't available here." };
    const key = joinerKey(j);
    const op = String(body?.op || "");
    const peerOk = (peer) => typeof peer === "string" && peer.startsWith(`${key}|`) && peer.length < 200;
    if (op === "want") {
      // Nothing here captures a tab (a PairBrowse build without its capture page): the joiner's
      // side goes to the pictures through the channel at once.
      if (screens.available && !screens.available()) return { problem: NO_CAPTURE_SHARE, route: "frames" };
      const page = await pageById(String(body?.id || ""));
      if (!page || !crossesWhole(page) || personTab(page)) return { problem: "That tab isn't shared." };
      const id = idOf(page);
      const peer = `${key}|${id}|${randomBytes(4).toString("hex")}`;
      const r = await screens.offer(page, peer, {
        role: j.invite.role, who: j.name, onInput: onScreenInput(page, j, id), onPick: onScreenPick(page, j, id),
        onState: (state) => push.broadcast("screen", { op: "state", id, peer, state }, { to: key }),
      });
      return { peer, id, sdp: r.sdp };
    }
    if (op === "answer") return peerOk(body.peer) && await screens.answer(body.peer, body.sdp) ? { ok: true } : { problem: "No such connection." };
    if (op === "stop") { if (peerOk(body.peer)) await screens.stop(body.peer); return { ok: true }; }
    // The slower route: pictures of the tab through the channel, and input back.
    if (op === "frames") {
      const page = await pageById(String(body?.id || ""));
      if (!page || !crossesWhole(page) || personTab(page)) return { problem: "That tab isn't shared." };
      const id = idOf(page);
      if (body.on) await screens.frames(page, key, (img) => push.broadcast("screen", { op: "frame", id, img }, { to: key }));
      else await screens.frames(page, key, null);
      return { ok: true };
    }
    if (op === "input") {
      const page = await pageById(String(body?.id || ""));
      if (!page || !crossesWhole(page) || personTab(page)) return { problem: "That tab isn't shared." };
      if (j.invite.role !== "drive") return { problem: "This code is for watching only." };
      await screens.input(page, (Array.isArray(body.events) ? body.events : []).slice(0, 200), onScreenInput(page, j, idOf(page)), j.name, onScreenPick(page, j, idOf(page)));
      return { ok: true };
    }
    // The files they picked for that dialog: only from their own folder here (sent over just before).
    if (op === "picked") {
      const p = picks.get(String(body?.token || ""));
      if (!p || p.key !== key || p.page.isClosed()) return { problem: "That file request is over." };
      picks.delete(body.token);
      const mine = remoteAgents?.folder(key);
      const files = (Array.isArray(body.files) ? body.files : []).slice(0, 20).map(String);
      if (!mine || files.some((f) => !resolve(f).startsWith(resolve(mine) + sep))) return { problem: "Those files didn't come from you." };
      await screens.setFiles(p.chooser, files);
      return { ok: true };
    }
    return { problem: "Unknown request." };
  }
  // A joiner's agent's answers, kept for a while: their channel can drop and reconnect (a busy
  // computer, the tunnel), and an answer sent just then would be lost, leaving their agent waiting
  // for it. Each goes again when a channel opens; their side takes each answer once.
  const AGENT_KEEP_MS = 120_000;
  const agentOutbox = new Map(); // joiner key -> [{ msg, t }]
  function toJoinerAgent(key, msg) {
    const now = Date.now();
    const list = (agentOutbox.get(key) || []).filter((x) => now - x.t < AGENT_KEEP_MS).slice(-49);
    list.push({ msg, t: now });
    agentOutbox.set(key, list);
    push.broadcast("agent", msg, { to: key });
  }
  function resendAgent(key) {
    const now = Date.now();
    const list = (agentOutbox.get(key) || []).filter((x) => now - x.t < AGENT_KEEP_MS);
    if (!list.length) { agentOutbox.delete(key); return; }
    agentOutbox.set(key, list);
    for (const { msg } of list) push.broadcast("agent", msg, { to: key });
  }

  // A joiner's own agent at work in this browser (daemon/remote-agents.mjs): its MCP messages,
  // its answers back on the channel; files it sends over for an upload.
  async function remoteAgent(body, j) {
    if (!remoteAgents) return { problem: "Shared browser mode isn't available here." };
    if (j.invite.role !== "drive") return { problem: "This code is for watching only: your agent can't act in the host's browser." };
    const key = joinerKey(j);
    // The tab they look at: only one whose picture goes to joiners.
    const start = typeof body?.tab === "string" ? (await getContext()).pages().find((p) => idOf(p) === body.tab && crossesWhole(p) && !personTab(p)) || null : null;
    const ok = remoteAgents.line({ name: j.name, app: j.app, key }, String(body?.a || ""), body?.line, (line) => toJoinerAgent(key, { a: String(body.a), line }), start);
    return ok ? { ok: true } : { problem: "Bad message." };
  }
  function remoteFile(body, j) {
    if (!remoteAgents) return { problem: "Shared browser mode isn't available here." };
    if (j.invite.role !== "drive") return { problem: "This code is for watching only." };
    return remoteAgents.file({ key: joinerKey(j) }, body);
  }
  // A tab whose picture may go to joiners: any web page, never the browser's own pages.
  const crossesWhole = (page) => /^(https?:|about:blank)/.test(page.url());
  // Tabs opening, closing and going elsewhere reach joiners at once, not on the next round
  // (watched from the first joiner's stream on).
  let pagesWatched = false;
  const watchPages = () => {
    if (pagesWatched) return;
    pagesWatched = true;
    getContext().then((ctx) => {
      const watch = (p) => {
        p.on("framenavigated", (f) => { if (f === p.mainFrame()) { loading.add(p); push.changed(); } });
        p.on("load", () => { loading.delete(p); push.changed(); });
        p.on("close", () => { loading.delete(p); push.changed(); });
      };
      ctx.pages().forEach(watch);
      ctx.on("page", (p) => { watch(p); push.changed(); });
    }).catch(() => {});
  };
  async function applyTabs(body, j, heardAt = Date.now()) {
    const ctx = await getContext();
    const known = new Map(ctx.pages().map((p) => [idOf(p), p]));
    const { ops, problem } = readOps(body, new Set((await tabsFor(j)).tabs.map((t) => t.id)));
    if (problem) return { problem };
    const who = personLabel(j.name);
    const opened = {};
    await humanQueue(async () => {
      for (const o of ops) {
        if (o.op === "order") { await shared.arrange(o.ids.map((id) => known.get(id)).filter((p) => p && !p.isClosed())); continue; }
        const page = o.op === "open" ? await keepFocus(() => ctx.newPage()) : known.get(o.id);
        if (!page || page.isClosed()) continue;
        if (o.op === "person") { onJoinerPerson(page, j.name, o.did, o.acting, false, o.ago, heardAt); continue; }
        // Named by who the host knows them as (their join's name), never by what they send: a
        // joiner can't write lines as "Claude" or as someone else. Paced per joiner.
        if (o.op === "activity") {
          j.activityOk ??= activityBudget();
          if (j.activityOk()) onJoinerActivity(page, o.text, o.who ? `${cleanName(j.name)}'s agent` : who, joinerKey(j));
          continue;
        }
        if (o.op === "agent") { shared.onJoinerAgent(page, o.who, o.color, o.left, joinerKey(j), cleanName(j.name)); continue; }
        if (o.op === "form") {
          // Only on the same page; the host's own form reading then carries it to other joiners.
          const here = shareableUrl(devUrl(page.url()) || page.url());
          // was: the value both sides last had, so a card typed over it there clears it here.
          const fields = o.fields.map((x) => (x.m && x.filled ? { ...x, was: push.sharedValue(page, x.f, x.k) } : x));
          if (here === o.url && !onSecretDomain(page.url(), secretDomains())) await shared.applyForm(page, fields, cleanName(j.name));
          push.dirty(page); // on to the other joiners
          continue;
        }
        onJoinerPerson(page, j.name, [], true, true, 0, heardAt);
        if (o.op === "close") {
          // The last tab is emptied instead of closed, so the browser window stays open.
          if (ctx.pages().length > 1) await page.close().catch(() => {}); else await page.goto("about:blank").catch(() => {});
          continue;
        }
        if (o.op === "open") opened[o.ref] = idOf(page);
        // A shared dev server's address goes back to the dev server's own here.
        await page.goto(devShare?.toLocal(o.url) || o.url, { waitUntil: "commit", timeout: JOINER_NAV_MS }).catch((e) => log("joiner tab", e?.message || e));
      }
    });
    return { ok: true, opened };
  }

  const stopApprovals = approvals.onChange(() => broadcast("join", approvals.open()));
  // A revoked or expired link stops at once, including a page already open with it.
  const stopEnded = invites.onEnd((ids) => {
    let changed = false;
    for (const [res, invite] of linkGuests) {
      if (!ids.includes(invite.id)) continue;
      linkGuests.delete(res);
      clients.delete(res);
      viewers.delete(res);
      res.end();
      changed = true;
    }
    for (const [k, j] of joiners) {
      if (!ids.includes(j.invite.id)) continue;
      joiners.delete(k);
      push.end(k);
      stopJoinerKey(k).catch(() => {}); // their agent here (its tab turns) and pictures too
      changed = true;
    }
    approvals.forget(ids);
    if (changed) collaborationChanged();
    broadcast("invites", { items: inviteItems(invites.list()) });
  });

  // Light frames while the page moves (scrolling, animations), then one sharp still at the viewer's
  // real pixel size once it settles, like a remote desktop. Smooth in motion, crisp at rest.
  let settleTimer = null;
  let frameSeq = 0;
  function sharpenSoon(cdp) {
    clearTimeout(settleTimer);
    const seq = frameSeq;
    settleTimer = setTimeout(async () => {
      if (!viewers.size || shown?.cdp !== cdp) return; // the sharp still is for the owner's viewers
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: SHARP_QUALITY });
        if (seq !== frameSeq || shown?.cdp !== cdp || !lastFrame) return; // the page moved again meanwhile
        lastFrame = { img: data, w: lastFrame.w, h: lastFrame.h };
        broadcast("frame", lastFrame);
      } catch {}
    }, SETTLE_MS);
  }

  // Shows a tab: its own CDP session and screencast. One switch at a time, so two callers (the
  // follow tick and a tab click) never leave a session behind.
  const wired = new WeakSet(); // tabs whose closing is watched
  // Switches in progress: while one runs no tab is shown for a moment, which isn't "nothing shown"
  // (follow() would otherwise pull the viewer back to Claude's tab mid-switch).
  let switching = 0;
  let casting = null; // the CDP session whose frames are taken (set before its cast starts)
  const show = (page) => { switching++; return showQueue(() => showNow(page)).finally(() => { switching--; }); };
  async function showNow(page) {
    if (closed || shown?.page === page || hiddenFromLiveView(page.url())) return;
    if (shown) {
      const old = shown.cdp;
      // Switching away from a person's own tab: its last picture goes with it.
      if (personTab(shown.page)) { lastFrame = null; lastFrameFrom = null; }
      shown = null;
      casting = null;
      await release(old);
    }
    const cdp = await page.context().newCDPSession(page);
    casting = cdp;
    try {
      let lastAt = 0;
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        // The next frame comes once this one is acknowledged: paced to FRAME_EVERY_MS.
        const wait = Math.max(0, FRAME_EVERY_MS - (Date.now() - lastAt));
        lastAt = Date.now() + wait;
        const ack = () => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        if (wait) setTimeout(ack, wait).unref(); else ack();
        // A frame still in flight from a session already released (a switch away): dropped.
        if (casting !== cdp) return;
        frameSeq++;
        lastFrame = { img: data, w: metadata.deviceWidth, h: metadata.deviceHeight };
        lastFrameFrom = page;
        broadcast("frame", lastFrame);
        sharpenSoon(cdp);
      });
      await bringTabForward(page);
      // A clean, browser-like view: no classic scrollbars (scroll with the wheel or trackpad).
      await cdp.send("Emulation.setScrollbarsHidden", { hidden: true }).catch(() => {});
      await replayer.attach(cdp);
      await replayer.startCast(cdp);
    } catch (e) {
      if (casting === cdp) casting = null;
      await release(cdp);
      throw e;
    }
    if (closed) { casting = null; return release(cdp); }
    shown = { page, cdp };
    if (!wired.has(page)) {
      wired.add(page);
      page.once("close", () => { if (lastFrameFrom === page) { lastFrame = null; lastFrameFrom = null; } if (shown?.page === page) { shown = null; casting = null; } if (watching()) follow(); });
    }
    broadcast("tabs", await tabsInfo());
  }

  // Follow the tab Claude is working in, whenever that changes. Between changes, the tab you
  // picked in the viewer stays put.
  async function follow() {
    try {
      const ctx = await getContext();
      const url = await currentUrl();
      if ((shown || switching) && url === followed) return;
      followed = url;
      // The browser's own pages are never shown; followedPage stays the agents' page (a chrome
      // page is never listed, so no tab is marked as Claude's).
      const at = ctx.pages().find((p) => p.url() === url);
      const page = (at && !hiddenFromLiveView(at.url()) ? at : null) || shown?.page || ctx.pages().filter((p) => !hiddenFromLiveView(p.url()) && !personTab(p)).at(-1);
      if (url) followedPage = at || page;
      if (page) await show(page);
    } catch (e) {
      log("liveview follow", e?.message || e);
    }
  }

  // Nobody watching: stop the page streams and give the real window its normal size back.
  function stopIfIdle() {
    if (watching() || !shown) return;
    showQueue(async () => {
      if (watching() || !shown) return;
      const { cdp } = shown;
      shown = null;
      casting = null;
      followed = undefined;
      replayer.resetFit();
      await release(cdp);
    });
  }

  // A person's clicks, typing and tab changes, from a viewer. who: their name for the others
  // (null: the owner). Only the owner may resize the shared page ("Fit to pane").
  const guestBudgets = new Map(); // invite id -> its input budget (inputBudget)
  async function humanPost(route, ev, role, who, inviteKey = null) {
    if (route === "input") {
      // Each event checked (kinds, places inside the picture, modifiers, no clipboard for an invited
      // viewer); an invited viewer's input paced per invite.
      const frame = lastFrame ? { w: lastFrame.w, h: lastFrame.h } : null;
      let batch = (Array.isArray(ev) ? ev : [ev]).slice(0, INPUT_BATCH_MAX).map((one) => readViewerInput(one, { frame, role })).filter(Boolean);
      if (role !== "owner" && inviteKey) {
        if (!guestBudgets.has(inviteKey)) guestBudgets.set(inviteKey, inputBudget());
        if (!guestBudgets.get(inviteKey)(batch.length)) batch = [];
      }
      if (!batch.length) return;
      return humanQueue(async () => {
        if (role !== "owner" && personTab(shown?.page)) return; // a person's own tab: never a guest's input
        // Only moving the pointer (or the wheel) changes nothing an agent's refs point at.
        if (batch.some((one) => one?.type !== "viewport")) await onHumanInput(shown?.page || null, who, batch.some((one) => !["viewport", "wheel"].includes(one?.type) && !(one?.type === "mouse" && one.action === "mouseMoved")));
        const done = onReplay(who);
        try { for (const one of batch) await replayer.replay(shown, one, role).catch((e) => log("liveview input", e?.message || e)); } finally { done(); }
      });
    }
    return humanQueue(async () => {
      await onHumanInput(shown?.page || null, who);
      const ctx = await getContext();
      if (ev.new) await show(await keepFocus(() => ctx.newPage()));
      else if (ev.close !== undefined) {
        const found = ctx.pages()[Number(ev.close)];
        // never the browser's own pages, and never a guest closing a person's own tab
        const page = found && !hiddenFromLiveView(found.url()) && !(role !== "owner" && personTab(found)) ? found : null;
        // The last tab is emptied instead of closed, so the browser window stays open.
        if (page && ctx.pages().length > 1) await page.close().catch(() => {});
        else if (page) await page.goto("about:blank").catch(() => {});
        broadcast("tabs", await tabsInfo());
      } else if (Array.isArray(ev.order)) {
        // The strip's order (the owner's tab strip page): today's arrange, ids as tabs.json gives them.
        const known = new Map(ctx.pages().map((p) => [idOf(p), p]));
        await shared.arrange(ev.order.slice(0, 100).map((id) => known.get(String(id))).filter((p) => p && !p.isClosed()));
      } else {
        const page = ctx.pages()[Number(ev.i)];
        if (page && !hiddenFromLiveView(page.url()) && !(role !== "owner" && personTab(page))) await show(page);
      }
    });
  }

  // ---- the owner's port: your own link, the side panel, and invite links -------------------
  // Each route names the right it needs (invites.mjs); a route that isn't listed is refused.
  // needs(): the part of the helper a route works with; falsy, the route answers 404 (a string: 404
  // with that sentence), checked after the right, as each route did first thing.
  const ROUTES = [
    { method: "GET", path: "", right: "page", handler: ({ req, res, role }) => serveViewer(req, res, { role }) },
    { method: "GET", path: "assets", right: "page", handler: ({ res, rest }) => serveAsset(res, rest) },
    { method: "GET", path: "events", right: "events", handler: events },
    // A small still of the page and a status summary, for panes that can't hold a live stream
    // (the Claude app's plugin panes). Same key, same checks.
    { method: "GET", path: "thumb.jpg", right: "thumb", handler: thumb },
    { method: "GET", path: "state.json", right: "state", handler: async ({ res, invite }) => {
      const tabs = withoutIcons(await tabsInfo());
      const recent = activity.slice(-STATE_ACTIVITY);
      json(res, 200, { status, session: sessionInfo, collaboration: collaborationNow(), tabs: invite ? guestList(tabs) : tabs, activity: invite ? guestActivity(recent) : recent, frame: lastFrame ? { w: lastFrame.w, h: lastFrame.h } : null });
    } },
    // The session's activity log, newest first, a page at a time (the Activity page's history; the
    // activity event has the latest 30): ?before=<epoch ms> (lines strictly older) &limit=<1..200>
    // -> { items, more, kept: { lines, days, saved } }. The owner's alone (either owner key).
    { method: "GET", path: "activity.json", right: "activity", handler: ({ req, res, rest }) => {
      if (rest.length) return plain(res, 404);
      const q = readPageQuery(new URL(req.url, "http://x").searchParams);
      if (q.error) return json(res, 400, { error: q.error });
      json(res, 200, history.page(q));
    } },
    // People asking to join with a code, for the owner to let in or not.
    { method: "GET", path: "joins.json", right: "approve", handler: ({ res }) => json(res, 200, approvals.pending()) },
    // Named final clicks waiting for an answer (daemon/approvals.mjs), for the owner only: the
    // browser's own pages list them and answer with POST approve { id, answer }.
    { method: "GET", path: "approvals.json", right: "approve", needs: () => clickApprovals, handler: ({ res }) => json(res, 200, { pending: clickApprovals.pending() }) },
    { method: "POST", path: "approve", right: "approve", handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, BODY_MAX.approve);
      if (given === undefined) return;
      if (given && typeof given === "object" && typeof given.answer === "string") {
        if (!(typeof given.id === "string" && APPROVAL_ID.test(given.id) && ANSWERS.has(given.answer))) return json(res, 400, { error: "An approval answer is { id, answer: allow, deny, terminal or site }." });
        if (!clickApprovals) return plain(res, 404);
        const ok = clickApprovals.answer(given.id, given.answer, "the live view");
        return json(res, ok ? 200 : 404, { ok });
      }
      const op = given;
      if (!op || typeof op !== "object" || Array.isArray(op)) return json(res, 400, { error: NOT_JSON });
      if (op.remove === true) {
        // Remove, after a yes: out at once (their channel, pictures and agent), and not back in.
        const gone = approvals.remove(op.id);
        if (!gone) return json(res, 404, { ok: false });
        joiners.delete(gone.key);
        push.end(gone.key);
        // By key: their agent may still be at work here after their own entry went.
        await stopJoinerKey(gone.key).catch(() => {});
        collaborationChanged();
        const { key: _k, ...request } = gone;
        return json(res, 200, { ok: true, request });
      }
      const done = op.allow === true ? approvals.approve(op.id) : approvals.deny(op.id);
      log(`join request ${String(op.id).slice(0, 12)}: ${op.allow === true ? "Allow" : "Deny"} from the side panel or a notification${done ? "" : ", but it wasn't waiting any more"}`);
      json(res, done ? 200 : 404, { ok: !!done, request: done });
    } },
    // Dev servers (devshare.mjs), for the owner only: what's open on localhost and shared, an
    // agent's question to share one; and the owner's answer, Share or Stop (a real click).
    { method: "POST", path: "dev", right: "approve", needs: () => devPanel, handler: async ({ req, res }) => {
      const v = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (v === undefined) return;
      const r = await devPanel.act(v);
      json(res, r.error ? 409 : 200, r);
    } },
    // A join code whose address this person hasn't allowed (daemon/follow.mjs): their Allow once,
    // Always allow or Cancel, and Remove for an allowed address. The owner only (the side panel,
    // the session picker), with a real click; agents have no tool for it.
    { method: "POST", path: "joinhost", right: "approve", needs: () => joinHost, handler: async ({ req, res }) => {
      const v = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (v === undefined) return;
      const r = await joinHost.act(v);
      json(res, r.error ? 409 : 200, r);
    } },
    // The Profile panel: remembered details in full, passwords by name and sites only.
    { method: "GET", path: "profile.json", right: "profile", needs: () => profile, handler: ({ res }) => json(res, 200, profile.get()) },
    { method: "POST", path: "profile", right: "profile", needs: () => profile, handler: changeProfile },
    // The Timeline: the goal log's lines (journal.mjs read, masked again there), read when the
    // owner opens it or presses Refresh; null while no run is open.
    { method: "GET", path: "journal.json", right: "journal", needs: () => journal, handler: ({ res }) => json(res, 200, journal() ?? null) },
    // The Share card (the side panel, the live view toolbar): the owner makes a join code or a
    // watch link with a real click, through the helper's own invite code. The code or link is in
    // this answer only: never broadcast, logged or kept in state.json.
    // { op: "revoke", id } (Settings' Invites, Revoke): that invite stops at once, as with
    // pairbrowse_invite revoke (anyone using it is out; a join code's tunnel goes with the last code).
    { method: "POST", path: "invite", right: "invite", handler: async ({ req, res }) => {
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (op && typeof op === "object" && !Array.isArray(op) && op.op !== undefined) {
        if (op.op !== "revoke" || Object.keys(op).some((k) => k !== "op" && k !== "id")) return json(res, 409, { error: 'An invite change is { op: "revoke", id }.' });
        if (typeof op.id !== "string" || !INVITE_ID.test(op.id)) return json(res, 409, { error: "id is an invite's id, as invites.json lists it." });
        if (!invites.revoke(op.id)) return json(res, 404, { error: "No such invite (it may have expired or been revoked already)." });
        log(`invite ${op.id} revoked from PairBrowse's settings`);
        return json(res, 200, { ok: true, id: op.id });
      }
      if (!makeInvite) return plain(res, 404);
      if (!op || typeof op !== "object" || Array.isArray(op)) return json(res, 409, { error: "Choose a join code or a watch link." });
      const { share, role, name, label, hours } = op;
      const r = await makeInvite({ share, role, name, label, hours });
      json(res, r?.error ? 409 : 200, r);
      if (!r?.error) broadcast("invites", { items: inviteItems(invites.list()) });
    } },
    // The invites out now, for Settings (Sharing, Invites): id, role, label, link or code, when it
    // ends (epoch ms). Never a key, a code or a link.
    { method: "GET", path: "invites.json", right: "invite", handler: ({ res }) => json(res, 200, { items: inviteItems(invites.list()) }) },
    // The session picker (an extension page, with the owner's key from the side panel's memory):
    // the saved sessions, and the person's pick. picker: { state(), pick(op) } from the helper.
    { method: "GET", path: "sessions.json", right: "session", needs: () => picker, handler: ({ res }) => json(res, 200, picker.state()) },
    // While a session is open too (the switcher, the new tab page's chips, the sessions page): the
    // helper decides (daemon/pick.mjs). 428 { confirm, agents } while other agents are at work and
    // the body has no confirm: true; 409 { text, error } for a refusal; the open pages hear the
    // sessions event after a change.
    { method: "POST", path: "pick", right: "session", needs: () => picker, handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, BODY_MAX.approve);
      if (given === undefined) return;
      const { op, error } = readPick(given);
      if (error) return json(res, 409, { text: error, error: true });
      const r = (await picker.pick(op)) || { text: "That didn't work.", error: true };
      json(res, r.confirm ? 428 : r.error ? 409 : 200, r);
      if (!r.error) { try { broadcast("sessions", picker.state()); } catch {} }
    } },
    // "End session" in the side panel (the right dock in the browser): the picker again, in a new tab (the owner only).
    { method: "POST", path: "picker", right: "session", needs: () => picker?.open, handler: async ({ res }) => {
      json(res, 200, await picker.open());
    } },
    // The browser's own pages (the owner only): the docks' layout, the tab strip's list, and the
    // session's timeline of pictures already sent to agents (daemon/timeline.mjs).
    { method: "GET", path: "layout.json", right: "layout", handler: ({ res }) => json(res, 200, layoutNow()) },
    { method: "POST", path: "layout", right: "layout", handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, BODY_MAX.approve);
      if (given === undefined) return;
      // tab: the right dock's tab to open on, relayed in this answer and its event only (never kept).
      const t = readDockTab(given);
      if (t.error) return json(res, 409, { error: t.error });
      const plainObject = given && typeof given === "object" && !Array.isArray(given);
      const next = readLayout(plainObject ? Object.fromEntries(Object.entries(given).filter(([k]) => k !== "tab")) : given, layoutNow());
      if (next.error) return json(res, 409, { error: next.error });
      layouts.set(sessionInfo.name, next);
      const out = t.tab ? { ...next, tab: t.tab } : next;
      broadcast("layout", out);
      json(res, 200, out);
    } },
    // The browser's Settings page (the owner only): which browser runs, the timeline on/off and
    // cap, the docks' default layout, and nothing else (liveview/settings.mjs has the body shape).
    // GET: { browser: "pairbrowse" | "chromium" | "<absolute path>", timeline: { on, cap },
    // layout: { left, right, strip }, native: boolean (a build is pinned for this computer),
    // chosen: boolean (a person recorded the choice) }. POST: any subset of browser / timeline /
    // layout; answers the GET body plus restart: true while "browser" differs from the browser in
    // use (it takes effect at the next start); written into config.json, broadcast as "config".
    { method: "GET", path: "config.json", right: "config", needs: () => settings, handler: ({ res }) => json(res, 200, settings.read()) },
    { method: "POST", path: "config", right: "config", needs: () => settings, handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, BODY_MAX.approve);
      if (given === undefined) return;
      const r = await settings.write(given);
      if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work." });
      broadcast("config", r);
      json(res, 200, r);
    } },
    // Report a problem (Settings, on the person's click after they saw the JSON): relayed over
    // HTTPS to config.json's reportUrl (liveview/report.mjs: checked, scrubbed again, 5 an hour).
    // 404 without a report address; the address itself is never in an answer.
    { method: "POST", path: "report", right: "config", needs: () => reporter?.enabled(), handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, REPORT_BODY_MAX);
      if (given === undefined) return;
      const r = await reporter.relay(given);
      if (r.status === 404) return plain(res, 404);
      json(res, r.status, r.body);
    } },
    // The session card (the owner only): { op: "rename", name } restarts the browser on the renamed
    // session ({ op: "rename", name, from }: a saved one that isn't open, renamed without a
    // restart; the sessions page), { op: "save" } writes its tabs now. sessionOps from the helper (daemon.mjs).
    { method: "POST", path: "session", right: "session", needs: () => sessionOps, handler: async ({ req, res }) => {
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (!op || typeof op !== "object" || Array.isArray(op) || (op.op !== "rename" && op.op !== "save")) return json(res, 409, { error: SESSION_OP });
      if (op.op === "save") {
        const r = await sessionOps.save();
        if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work." });
        json(res, 200, { ok: true, savedAt: r.savedAt || "" });
        broadcast("session", ownerSession());
        return;
      }
      // from: a saved session that isn't open (the sessions page): renamed in place, nothing
      // restarts, so who is in this session, a recording or an approval don't hold it up.
      if (op.from !== undefined && (typeof op.from !== "string" || !op.from.trim() || op.from.length > 40)) return json(res, 409, { error: "from is a saved session's name." });
      const from = op.from === undefined ? undefined : op.from.trim();
      const saved = from !== undefined && from !== sessionOps.current?.();
      if (!saved) {
        if (linkGuests.size || joinersNow().length) return json(res, 409, { error: "People are in this session; rename it once they have left." });
        if (recordState()?.recording) return json(res, 409, { error: "Stop the recording first." });
        if (clickApprovals?.pending().length) return json(res, 409, { error: "An approval is waiting; answer it first." });
      }
      const name = String(op.name ?? "").trim();
      const r = await (saved ? sessionOps.rename(name, from) : sessionOps.rename(name));
      if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work." });
      if (r.from && r.from !== r.name && layouts.has(r.from)) { layouts.set(r.name, layouts.get(r.from)); layouts.delete(r.from); }
      // Answered before the browser restarts: the dock that asked closes with the window.
      json(res, 200, { ok: true, name: r.name, restarting: !!r.restarting });
      broadcast("session", ownerSession());
      if (saved && picker) { try { broadcast("sessions", picker.state()); } catch {} }
    } },
    // The Page tab: the whole-page snapshot an agent last got for a tab (?tab=<id>, else the
    // latest), its text masked again here; { outline: null } when there is none.
    { method: "GET", path: "outline.json", right: "outline", needs: () => outlines, handler: async ({ req, res }) => {
      const want = new URL(req.url, "http://x").searchParams.get("tab");
      const page = want ? webPages((await getContext()).pages()).map(([p]) => p).find((p) => !p.isClosed() && idOf(p) === want) || null : outlines.latest();
      const o = page ? outlines.get(page) : null;
      json(res, 200, { outline: o ? { tab: idOf(page), host: hostOf(page.url()), who: o.who, at: o.at, cut: o.cut, text: mask(o.text) } : null });
    } },
    { method: "GET", path: "tabs.json", right: "strip", handler: async ({ res }) => { watchPages(); json(res, 200, await tabsStrip()); } },
    { method: "GET", path: "agent-tabs.json", right: "strip", handler: async ({ res }) => json(res, 200, await agentTabs()) },
    { method: "GET", path: "timeline.json", right: "timeline", needs: timelineOn, handler: ({ res }) => {
      json(res, 200, { cards: (timeline.cards() || []).map(maskedCard) });
    } },
    { method: "GET", path: "timeline", right: "timeline", needs: timelineOn, handler: async ({ res, rest }) => {
      const m = rest.length === 1 ? /^([0-9a-f]{12})\.jpg$/.exec(rest[0]) : null;
      const bytes = m ? await timeline.picture(m[1]) : null;
      if (!bytes) return plain(res, 404);
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/jpeg" });
      res.end(bytes);
    } },
    { method: "DELETE", path: "timeline", right: "timeline", needs: timelineOn, handler: async ({ res, rest }) => {
      if (rest.length !== 1 || !TIMELINE_ID.test(rest[0])) return plain(res, 404);
      return (await timeline.remove(rest[0])) === true ? json(res, 200, { ok: true }) : plain(res, 404);
    } },
    // note, <id>/pin, and <id>/show: the Pictures tab shows that card (an event to the owner's
    // streams with the card; nothing new kept).
    { method: "POST", path: "timeline", right: "timeline", needs: timelineOn, handler: async ({ req, res, rest }) => {
      const isNote = rest.length === 1 && rest[0] === "note";
      const isPin = rest.length === 2 && TIMELINE_ID.test(rest[0]) && rest[1] === "pin";
      const isShow = rest.length === 2 && TIMELINE_ID.test(rest[0]) && rest[1] === "show";
      if (!isNote && !isPin && !isShow) return plain(res, 404);
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (isShow) {
        const card = (timeline.cards() || []).find((c) => c.id === rest[0]);
        if (!card) return plain(res, 404);
        if (card.note === true) return json(res, 409, { error: "That card is a note; it has no picture to show." });
        broadcast("timeline", { op: "show", id: card.id, card: maskedCard(card) });
        return json(res, 200, { ok: true });
      }
      const r = isNote ? await timeline.note(typeof op?.text === "string" ? op.text : "") : await timeline.pin(rest[0], op?.on !== false);
      if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work." });
      json(res, 200, maskedCard(r));
    } },
    // The Tools tab (the owner only): this session's downloads, the recordings this helper saved,
    // the hand-offs waiting for the person, and diagnostics. Files go by id (daemon/toolstab.mjs);
    // request bodies are capped and otherwise ignored (but a download's Open reads { confirm: true }),
    // so nothing in them names a file.
    { method: "GET", path: "downloads.json", right: "tools", needs: toolsOn, handler: ({ res }) => json(res, 200, { items: tools.downloads.list().map(maskedDownload) }) },
    { method: "POST", path: "downloads", right: "tools", needs: toolsOn, handler: (ctx) => fileAction(ctx, tools?.downloads, true) },
    { method: "GET", path: "recordings.json", right: "tools", needs: toolsOn, handler: ({ res }) => {
      const st = recordState() || {};
      json(res, 200, { recording: { on: !!st.recording, since: st.since || 0 }, items: tools.recordings.list() });
    } },
    { method: "POST", path: "recordings", right: "tools", needs: toolsOn, handler: (ctx) => fileAction(ctx, tools?.recordings, false) },
    { method: "DELETE", path: "recordings", right: "tools", needs: toolsOn, handler: async ({ req, res, rest }) => {
      if (rest.length !== 1 || !TOOL_ID.test(rest[0])) return plain(res, 404);
      if ((await readCapped(req, res, BODY_MAX.approve)) === null) return;
      const r = tools.recordings.remove(rest[0]);
      if (r?.ok) return json(res, 200, { ok: true });
      return r?.status === 410 ? json(res, 410, { error: FILE_CHANGED }) : plain(res, 404);
    } },
    { method: "GET", path: "handoffs.json", right: "tools", needs: toolsOn, handler: async ({ res }) => {
      json(res, 200, { items: await Promise.all(tools.handoffs.list().map(handoffItem)) });
    } },
    { method: "POST", path: "handoffs", right: "tools", needs: toolsOn, handler: async ({ req, res, rest }) => {
      if (rest.length !== 2 || !TOOL_ID.test(rest[0]) || rest[1] !== "show") return plain(res, 404);
      if ((await readCapped(req, res, BODY_MAX.approve)) === null) return;
      const h = tools.handoffs.entry(rest[0]);
      if (!h) return plain(res, 404);
      if (!h.page) return json(res, 409, { error: "This hand-off isn't about a tab, so there is nothing to show." });
      if (h.page.isClosed()) return json(res, 409, { error: "That tab is closed." });
      await within(3000, bringTabForward(h.page));
      json(res, 200, { ok: true });
    } },
    { method: "GET", path: "diagnostics.json", right: "tools", needs: toolsOn, handler: async ({ res }) => json(res, 200, await diagnosticsNow()) },
    { method: "POST", path: "diagnostics", right: "tools", needs: toolsOn, handler: async ({ req, res, rest }) => {
      if (rest.length !== 1 || rest[0] !== "report") return plain(res, 404);
      if ((await readCapped(req, res, BODY_MAX.approve)) === null) return;
      json(res, 200, { text: tools.diagnostics.reportText(await diagnosticsNow()) });
    } },
    { method: "POST", path: "input", right: "input", handler: human },
    { method: "POST", path: "tab", right: "tab", handler: human },
    // "Pause agents" and "Resume" (the side panel, a drive guest's viewer): people only, anyone
    // who may drive. who: the guest's name (null: the owner). With `who` in the body: "Pause this
    // agent" / "Resume this agent" for the agent of that name, the owner's only.
    // Record (the side panel): the browser as a video, saved in Downloads. The owner only.
    // The tab strip's report of every window's tabs by CDP target (the browser's own pages): kept
    // for the helper's tab order (daemon/taborder.mjs), the last one only.
    { method: "POST", path: "tab-order", right: "strip", handler: async ({ req, res }) => {
      const body = await readCapped(req, res, BODY_MAX.tabOrder);
      if (body === null) return;
      const order = readTabOrder(parseJson(body));
      if (!order) return json(res, 400, { error: "Not a tab order." });
      const sig = JSON.stringify(order);
      if (sig !== stripOrder.sig) stripOrder = { sig, order };
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
    } },
    // The browser's own capture page answering the helper (liveview/capture.mjs): an offer, an
    // answer, a recording's piece, or its hello.
    { method: "POST", path: "capture", right: "capture", needs: () => capture, handler: async ({ req, res, rest, byPages }) => {
      if (rest.length !== 1 || rest[0] !== "reply") return plain(res, 404);
      if (!captureOk(req, byPages)) return plain(res, 403);
      const body = await readCapped(req, res, BODY_MAX.capture);
      if (body === null) return;
      if (!capture.reply(parseJson(body))) return json(res, 400, { error: "Not a capture reply." });
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
    } },
    { method: "POST", path: "record", right: "record", handler: async ({ req, res }) => {
      const v = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (v === undefined) return;
      const r = await onRecord(v.on === true);
      // The file's name, never its folder or path (the Recordings list opens it by id).
      const item = r?.path ? tools?.recordings?.itemFor?.(r.path) || null : null;
      // The recorder's own sentence (no page text in it): masked, its folders hidden, its quotes kept.
      const text = r?.error ? scrub(r?.text || "", { mask, quotes: false }) : r?.path ? `Saved the recording as "${basename(r.path)}" in your downloads folder.` : "Recording the browser.";
      json(res, r?.error ? 409 : 200, { ...recordState(), text, ...(item ? { item } : {}) });
    } },
    { method: "POST", path: "pause", right: "input", handler: async ({ req, res, invite, role }) => {
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (op && typeof op === "object" && op.who !== undefined) {
        if (role !== "owner") return plain(res, 403);
        if (typeof op.who !== "string" || !op.who.trim() || op.who.length > 80) return json(res, 409, { error: "who is an agent's name as the session list shows it." });
        const r = onPause(op.paused === true, null, op.who) || {};
        return json(res, r.problem ? 409 : 200, r);
      }
      const r = onPause(op?.paused === true, invite ? invite.label : null) || {};
      json(res, r.problem ? 409 : 200, r);
    } },
  ];

  async function events({ req, res, invite, byPages }) {
    // ?panel: status, activity and profile only (the PairBrowse side panel): no page stream.
    // ?page=<kind>: one of the browser's own pages, with the owner's key (a guest's is ignored):
    // no page stream either. The capture page's stream: the pages' key and its own (captureOk).
    const q = new URL(req.url, "http://x").searchParams;
    const kind = !invite && PAGE_KINDS.has(q.get("page")) ? q.get("page") : null;
    if (kind === "capture" && !captureOk(req, byPages)) return plain(res, 403);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
    const viewer = !q.has("panel") && !kind;
    clients.add(res);
    if (viewer) viewers.add(res);
    if (kind) kinds.set(res, kind);
    if (invite) {
      linkGuests.set(res, invite);
      clickApprovals?.cover?.(); // an approval card in the page comes down at once
    } else owners.add(res);
    if (invite) collaborationChanged();
    req.on("close", () => {
      clients.delete(res);
      viewers.delete(res);
      owners.delete(res);
      kinds.delete(res);
      if (linkGuests.delete(res)) collaborationChanged();
      stopIfIdle();
    });
    if (viewer) await follow();
    const tabs = await tabsInfo();
    res.write(sse("tabs", invite ? guestList(tabs) : tabs));
    res.write(sse("status", status));
    res.write(sse("session", invite ? sessionInfo : ownerSession()));
    res.write(sse("collaboration", collaborationNow()));
    res.write(sse("activity", invite ? guestActivity(activity) : activity));
    if (!invite) res.write(sse("join", approvals.open()));
    if (!invite && devState) res.write(sse("dev", devState));
    if (!invite && joinHost) res.write(sse("joinhost", joinHost.state()));
    if (!invite && board) res.write(sse("board", board));
    if (!invite) res.write(sse("layout", layoutNow()));
    if (kind) { watchPages(); res.write(sse("agent-tabs", await agentTabs())); }
    if (!invite && clickApprovals?.pending().length) res.write(sse("driving", { on: driving }));
    const paused = pauseState();
    if (paused) res.write(sse("pause", invite ? guestPause(paused) : paused));
    if (!invite && recordState()) res.write(sse("record", recordState()));
    if (viewer && lastFrame && !(invite && personTab(lastFrameFrom))) res.write(sse("frame", lastFrame));
  }

  // A still of the tab on screen. With viewers it comes from the shown tab's session; without,
  // from a session of its own, let go at once: a thumbnail polled by a pane never starts (or
  // leaves running) the screencast that only viewers need.
  async function thumb({ req, res, invite }) {
    const q = Number(new URL(req.url, "http://x").searchParams.get("q")) || THUMB_QUALITY.default;
    const quality = Math.min(THUMB_QUALITY.max, Math.max(THUMB_QUALITY.min, q));
    // What's on screen, unscaled: a clip or scale makes Chromium re-lay out the page (it flickers).
    const still = (cdp) => cdp.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true, captureBeyondViewport: false });
    let data;
    if (invite && personTab(shown?.page)) return plain(res, 404); // a person's own tab: never to guests
    if (shown) ({ data } = await still(shown.cdp));
    else {
      const ctx = await getContext();
      const url = await currentUrl();
      if (hiddenFromLiveView(url)) return plain(res, 404); // never the browser's own pages
      const web = ctx.pages().filter((p) => !hiddenFromLiveView(p.url()));
      const page = web.find((p) => p.url() === url && !(invite && personTab(p))) || web.filter((p) => !personTab(p)).at(-1);
      if (!page) return plain(res, 404);
      const cdp = await page.context().newCDPSession(page);
      try { ({ data } = await still(cdp)); } finally { cdp.detach().catch(() => {}); }
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/jpeg" });
    res.end(Buffer.from(data, "base64"));
  }

  async function changeProfile({ req, res }) {
    const op = await readJsonBody(req, res, BODY_MAX.profile, { object: true });
    if (op === undefined) return;
    let error = null;
    if (op.op === "setDetail") error = profile.setDetail(op.label, op.value);
    else if (op.op === "forgetDetail") profile.forgetDetail(String(op.label || ""));
    else if (op.op === "setSecret") error = profile.setSecret({ name: op.name, value: op.value, domains: op.domains });
    else if (op.op === "deleteSecret") profile.deleteSecret(String(op.name || ""));
    else error = "Unknown change.";
    const summary = profile.get();
    if (!error) broadcast("profile", summary);
    json(res, 200, { error, profile: summary });
  }

  // The timeline's routes: 404 without a store, 404 with a plain sentence when it's switched off.
  function timelineOn() { return !timeline ? false : timeline.enabled ? true : TIMELINE_OFF; }
  const maskedCard = (c) => ({ ...c, caption: mask(String(c.caption || "")) });
  // The Tools tab's routes: 404 without the helper's tools.
  function toolsOn() { return !!tools; }
  const FILE_CHANGED = "That file was moved, replaced or deleted since it was saved.";
  const maskedDownload = (d) => ({ ...d, from: { host: d.from?.host || "", title: mask(String(d.from?.title || "")) } });
  const tabTitle = async (page) => mask(String((await within(1000, Promise.resolve(ownTitle(page)).catch(() => ""))) ?? ""));
  const handoffItem = async (h) => {
    const page = h.page && !h.page.isClosed() ? h.page : null;
    return { id: h.id, kind: h.kind, text: mask(h.text), tab: page ? { id: idOf(page), host: hostOf(page.url()), title: await tabTitle(page) } : null, by: h.by, at: h.at };
  };
  // POST downloads|recordings/<id>/open|reveal (and downloads/<id>/open-app): the stored file,
  // checked. A download opens in a person's own tab where the browser renders it (daemon/toolstab.mjs
  // openWay), as a read-only preview there (daemon/preview.mjs), or with the OS opener; open-app
  // opens a document with its app. Recordings: the OS opener only.
  async function fileAction({ req, res, rest }, store, isDownload) {
    const verbs = isDownload ? ["open", "reveal", "open-app"] : ["open", "reveal"];
    if (rest.length !== 2 || !TOOL_ID.test(rest[0]) || !verbs.includes(rest[1])) return plain(res, 404);
    const body = await readCapped(req, res, BODY_MAX.approve);
    if (body === null) return;
    const e = store.entry(rest[0]);
    if (!e) return plain(res, 404);
    if (isDownload && e.state !== "done") return json(res, 409, { error: e.state === "failed" ? "That download failed; there is no file to show." : "That download hasn't finished yet." });
    if (!fileStill(e)) return json(res, 410, { error: FILE_CHANGED });
    if (rest[1] === "open" && !isDownload && !openable(e.path)) return json(res, 409, { error: "This kind of file isn't opened from here: it could run as a program. Use Reveal to show it in its folder." });
    if (isDownload && rest[1] !== "reveal") {
      // A download opens only while macOS's download mark is still on it.
      if (!(await (tools.marked || downloadMarked)(e.path))) return json(res, 409, { error: "This file lost the download mark macOS uses to protect you; show it in Finder instead." });
      if (rest[1] === "open-app") {
        if (!isDocument(e.path)) return json(res, 409, { error: "Open in Word is for documents (.doc, .docx, .rtf, .odt). Use Open." });
        const r = await tools.open(e.path, "open");
        return r?.ok ? json(res, 200, { ok: true, opened: "app" }) : json(res, 409, { error: "The file couldn't be shown: the system's opener didn't start." });
      }
      const way = openWay(e.path, { platform: tools.platform ?? process.platform, engine: tools.engine?.() ?? null, size: e.size,
        tab: typeof tools.openTab === "function", preview: typeof tools.preview === "function" });
      if (way === "tab") {
        const r = await tools.openTab(pathToFileURL(e.path).href);
        return r?.ok ? json(res, 200, { opened: "tab" }) : json(res, 409, { error: r?.error || "The file couldn't be shown in a tab." });
      }
      if (way === "text" || way === "document") {
        const p = await tools.preview(e, way);
        if (!p || p.error) return json(res, 409, { error: p?.error || "PairBrowse couldn't make a preview of this file." });
        const r = await tools.openTab(pathToFileURL(p.path).href, p.drop);
        if (!r?.ok) { try { p.drop(); } catch {} return json(res, 409, { error: r?.error || "The file couldn't be shown in a tab." }); }
        if (way === "document" && r.page && typeof r.page === "object") previewOf.set(r.page, e.id);
        return json(res, 200, { opened: "preview" });
      }
      // With its app: a program, script or web page only after the person confirms ({ confirm: true },
      // the only field read).
      const confirm = confirmFor(e.path);
      if (confirm && parseJson(body)?.confirm !== true) return json(res, 428, { confirm });
    }
    // A download opened with its app says so ({ ok: true, opened: "app" }); Reveal and recordings: { ok: true }.
    const r = await tools.open(e.path, rest[1]);
    return r?.ok ? json(res, 200, isDownload && rest[1] === "open" ? { ok: true, opened: "app" } : { ok: true }) : json(res, 409, { error: "The file couldn't be shown: the system's opener didn't start." });
  }
  // What diagnostics.json answers: the helper's parts plus who is connected here.
  async function diagnosticsNow() {
    const { agents, ...d } = await tools.diagnostics.read();
    return { helper: d.helper, browser: d.browser, connections: { agents: agents || 0, viewers: viewers.size, joiners: joinersNow().length, streams: clients.size },
      joined: guests().map(({ label, role }) => ({ label, role })), errors: d.errors };
  }

  async function human({ req, res, route, role, invite }) {
    const ev = await readJsonBody(req, res, BODY_MAX.input);
    if (ev === undefined) return;
    if (ev === null || typeof ev !== "object") return json(res, 400, { error: NOT_JSON });
    // Moving tabs around the strip is the owner's (a drive guest switches, opens and closes them).
    if (route === "tab" && ev?.order !== undefined && role !== "owner") return plain(res, 403);
    await humanPost(route, ev, role, invite ? `${invite.label} (by hand)` : null, invite?.id || null);
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
  }

  const chromeOrigin = (o) => !!o && CHROME_PAGE_ORIGINS.includes(o) && extraOrigins.includes(o);
  const server = http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host, hosts)) return plain(res, 403); // blocks DNS-rebinding
    const { key: given, route, rest } = pathParts(req);
    // The owner's key works only under a loopback name (this computer, or an SSH tunnel); the
    // extra host names take invite links only. Unknown, expired and revoked keys look the same.
    const mine = keyOk(given, key);
    const byPages = !mine && keyOk(given, pagesKey);
    const ownerKey = mine || byPages;
    // Join code keys work only through the sharing tunnel's port (joiner-server.mjs), after approval.
    const matched = ownerKey ? null : invites.match(given);
    const invite = matched?.share === "code" ? null : matched;
    const role = ownerKey ? (hostOk(req.headers.host) ? "owner" : null) : invite?.role || null;
    if (!role) return plain(res, 404);
    // The browser's pages used their key: its file has done its job (the browser read it at start).
    if (byPages && role === "owner") try { onPagesKey(); } catch {}
    const origin = req.headers.origin;
    // CORS for the browser's own pages alone (chrome://pairbrowse, allowed only when the daemon
    // runs a build that has them): never "*", never a web or extension origin.
    if (role === "owner" && chromeOrigin(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
    if (req.method === "OPTIONS") {
      if (role !== "owner" || !chromeOrigin(origin)) return plain(res, 404);
      res.writeHead(204, { ...SECURITY_HEADERS, "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      return res.end();
    }
    if (req.method !== "GET" && !originOk(origin) && !(role === "owner" && extraOrigins.includes(origin)) && !(role === "drive" && inviteOrigin && origin === inviteOrigin)) return plain(res, 403);
    const r = ROUTES.find((x) => x.method === req.method && x.path === route);
    if (!r) return plain(res, 404);
    if (!roleMay(role, r.right)) return plain(res, 403);
    try {
      const has = r.needs ? r.needs() : true;
      if (!has) return plain(res, 404);
      if (typeof has === "string") return plain(res, 404, has);
      await r.handler({ req, res, route, rest, role, invite, byPages });
    } catch (e) {
      log("liveview", e?.message || e);
      if (!res.headersSent) plain(res, 500);
    }
  });

  // A joiner gone (left or removed): their agent here and their pictures stop.
  // What they said about their side's agents goes too.
  async function stopJoinerKey(key) { agentOutbox.delete(key); remoteAgents?.stop(key); shared.onJoinerGone(key); await screens?.stopAll(`${key}|`); }
  const stopJoiner = (j) => stopJoinerKey(joinerKey(j));
  // Their helper died or lost the network (no pong, no reconnect): out like one who left, their
  // agent's tab turns released; a rejoin asks nothing new (the approval stands).
  function lostJoiner(j) {
    const k = joinerKey(j);
    if (joiners.get(k) !== j) return;
    joiners.delete(k);
    log(`joiner ${j.name} lost the connection`);
    stopJoinerKey(k).catch(() => {});
    try { shared.onJoinerLost(j); } catch {}
    collaborationChanged();
    push.changed();
  }
  const joinerServer = createJoinerServer({
    key, invites, approvals, joiners, tunnelHost, onJoinRequest, log,
    live: { tabsFor, applyTabs, screen, agent: remoteAgent, file: remoteFile,
      stopScreens: stopJoiner, openStream: (j, conn) => { watchPages(); return push.open(j, conn).then(() => resendAgent(joinerKey(j))).catch((e) => log("push", e?.message || e)); }, pointersFor: (body, j) => push.fromJoiner(body, j), say: (body, j) => shared.onJoinerSay(body, j, joinerKey(j)), changed: () => { collaborationChanged(); push.changed(); } },
  });

  try {
    await listen(server, wantPort);
    await joinerServer.listen(wantGuestPort);
  } catch (e) {
    stopEnded(); stopApprovals(); server.close();
    throw e;
  }

  // Named final clicks asked in the browser (daemon/approvals.mjs): the owner's streams only. While
  // one waits, they also hear whether an agent is acting (driving), so a card can say so.
  const stopClickApprovals = clickApprovals?.onChange ? clickApprovals.onChange((change) => {
    broadcast("approval", change);
    if (change?.op === "add" && clickApprovals.pending().length === 1) broadcast("driving", { on: driving });
  }) : () => {};
  // The timeline changed (a picture kept, a card removed or pinned, a note): the owner's pages.
  const stopTimeline = timeline?.onChange ? timeline.onChange((change) => broadcast("timeline", { op: change.op, card: maskedCard(change.card) })) : () => {};
  // An outline kept or dropped (daemon/outline.mjs): the owner's pages hear which tab, never the text.
  const stopOutlines = outlines?.onChange ? outlines.onChange((c) => {
    if (!c?.page) return;
    broadcast("outline", { op: c.op, tab: idOf(c.page), ...(c.op === "set" ? { host: hostOf(c.page.url()), who: c.who, at: c.at, cut: c.cut } : {}) });
  }) : () => {};

  // The Tools tab's lists changed: the owner's streams hear it (downloads and hand-offs are
  // owner-only events; a recording saved or deleted goes on "record", to the owner's streams only).
  const toolEvents = serially(); // in order: a hand-off's title is read before its removal goes out
  const stopTools = tools ? [
    tools.downloads?.onChange?.((c) => broadcast("downloads", { op: c.op, item: maskedDownload(c.item) })),
    tools.handoffs?.onChange?.((c) => toolEvents(async () => broadcast("handoffs", c.op === "remove" ? { op: "remove", id: c.id, item: { id: c.id } } : { op: c.op, item: await handoffItem(c.item) })).catch(() => {})),
    tools.recordings?.onChange?.((c) => { const msg = sse("record", { ...(recordState() || {}), op: c.op, ...(c.op === "removed" ? { id: c.id } : { item: c.item }) }); for (const r of owners) r.write(msg); }),
  ].filter((f) => typeof f === "function") : [];

  async function tick() {
    invites.sweep();
    if (watching()) { await follow(); broadcast("tabs", await tabsInfo()); }
  }
  const timer = setInterval(() => tick().catch((e) => log("liveview", e?.message || e)), TICK_MS);
  timer.unref();
  log("live view started");
  return {
    url: `http://127.0.0.1:${server.address().port}/${key}/`,
    // The tab strip's last report of every window's tabs ({ tabs, focused, last }), or null.
    stripTabs: () => stripOrder.order,
    // An event for the browser's own pages alone: capture (the capture page's streams only),
    // tab-order (every page stream).
    sendToPages: (name, data) => { if (PAGES_ONLY.has(name)) broadcast(name, data); },
    // The browser's own pages' key (written to an owner-only key file, never the command line):
    // never printed, logged or sent in an event.
    pagesKey,
    // A new key for the capture page of the browser launching now (its file: context.mjs), or
    // null for a build whose capture page reads none. Returns the key.
    newCaptureKey(on = true) { captureKey = on ? randomBytes(32).toString("base64url") : null; return captureKey; },
    follow,
    reconnecting: (except) => push.reconnecting(except),
    // The badge state, mirrored in the viewer's own chrome (pages can't fake it there).
    setStatus(next) {
      status = { text: String(next.text || "").slice(0, 140), kind: next.kind || "clear" };
      broadcast("status", status);
    },
    // Dev servers for the owner's side panel (devshare.mjs): { asks, shared, open }.
    setDev(state) {
      devState = state;
      broadcast("dev", state);
    },
    // Join code addresses for the owner's side panel (daemon/follow.mjs): { asks, hosts }.
    setJoinHost(state) { broadcast("joinhost", state); },
    // Which browser session is shown, and where it runs (Local or Server).
    setSession(info) {
      sessionInfo = info;
      broadcast("session", ownerSession()); // guests get sessionInfo alone (broadcast)
      broadcast("layout", layoutNow());
    },
    setCollaboration(next) {
      collaboration = {
        participants: Array.isArray(next?.participants) ? next.participants : [],
        owner: next?.owner || null,
        active: next?.active || null,
        humanUntil: Number(next?.humanUntil) || 0,
      };
      collaborationChanged();
    },
    // What the Profile panel shows changed (Claude remembered something, a form was filled).
    setProfile(summary) {
      broadcast("profile", summary);
    },
    // One plain-English line per browser action, whose Claude took it, and in which tab.
    addActivity(text, who = "", tab = "", page = null, from = "") {
      if (!text) return;
      const entry = { t: Date.now(), text: String(text).slice(0, 200), who: String(who || "").slice(0, 60), tab: String(tab || "").slice(0, 80), ...(page ? { tabId: idOf(page) } : {}), ...(from ? { from } : {}) };
      // The session's log keeps it too; the stream sends the line as kept there (its time made
      // unique, masked as the log is), so the Activity page's two sources agree.
      let kept = null;
      try { kept = history.add(entry); } catch (e) { log("activity log", e?.message || e); }
      activity.push(kept ? { ...entry, t: kept.t, text: kept.text, tab: kept.tab } : entry);
      if (activity.length > ACTIVITY_MAX) activity.shift();
      broadcast("activity", activity);
      push.changed();
    },
    port: server.address().port,
    // The port the sharing tunnel forwards to (join codes only).
    guestPort: joinerServer.server.address().port,
    approvals,
    joinersNow,
    // Whether this joiner (joinerKey) is still in the session: a joiner gone holds no tab.
    joinerHere: (key) => { const j = joiners.get(key); return !!j && recentlySeen(j); },
    // Who is in the session the user joined (labels and roles), for the participant list.
    setRemote(list) { remote = Array.isArray(list) ? list.slice(0, 20) : []; collaborationChanged(); },
    // Tabs changed hands (claims, a person pausing an agent): show it now.
    refreshTabs: async () => { push.changed(); agentTabsChanged(); if (watching()) broadcast("tabs", await tabsInfo()); },
    // The page script says a field changed in a tab, or a pointer moved (daemon/cobrowse.mjs).
    fieldsChanged: (page) => push.dirty(page),
    pointed: (page, value) => push.pointed(page, value),
    agentPointed: (page, agent) => push.agentPointed(page, agent),
    sharing: () => push.active(),
    // Something for the joiners' streams: who is doing what, a message.
    pushToJoiners: (event, data, opts) => push.broadcast(event, data, opts),
    // Agents paused or resumed by a person (daemon/pause.mjs), with whether the owner may press it.
    setPause: () => broadcast("pause", pauseState()),
    // A recording started or stopped (daemon/recorder.mjs): the owner's side panels show it.
    setRecord: (state) => { for (const r of owners) r.write(sse("record", state)); },
    // Who is doing what across the session, and its messages: the side panel's Session section.
    setBoard: (next) => { board = next; broadcast("board", board); },
    // The browser's pages with a stream open, counted by kind; the docks' layout now (tests).
    pageClients: () => Object.fromEntries([...kinds.values()].reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map())),
    // An agent is acting, or the last one stopped (presence onActing): said only while an approval waits.
    setDriving(on) {
      driving = !!on;
      if (clickApprovals?.pending().length) broadcast("driving", { on: driving });
    },
    // People watching through an invite link right now (an approval card isn't drawn in the page then).
    guestViewers: () => linkGuests.size,
    // A tab's number, as the browser's own pages and browser_tabs count them.
    tabIndex: async (page) => (await getContext()).pages().indexOf(page),
    layout: layoutNow,
    close: () => {
      closed = true;
      clearInterval(timer);
      clearTimeout(settleTimer);
      stopEnded(); stopApprovals(); stopTimeline(); stopOutlines(); stopClickApprovals();
      for (const stop of stopTools) stop();
      server.close();
      for (const r of clients) r.end();
      joinerServer.close();
      push.close();
      if (shown) { release(shown.cdp); shown = null; }
    },
  };
}
