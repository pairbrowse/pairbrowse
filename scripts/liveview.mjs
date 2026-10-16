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
import { resolve, sep } from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { keepFocus } from "./focus.mjs";
import { createCast, bringTabForward, serially } from "./liveview/cast.mjs";
import { createAgentRelay } from "./liveview/agent-relay.mjs";
import { createJoinerTabs } from "./liveview/joiner-tabs.mjs";
import { createApprovals, personLabel } from "./sharing/join.mjs";
import { stateForJoiner } from "./sharing/tabsync.mjs";
import { createPush } from "./liveview/push.mjs";
import { hostOk, originOk, keyOk, sse, SECURITY_HEADERS, plain, pathParts, listen } from "./liveview/http.mjs";
import { createInvites, roleMay, roleOf } from "./liveview/invites.mjs";
import { createInputReplayer, readViewerInput, inputBudget } from "./liveview/input.mjs";
import { createJoinerServer, recentlySeen, joinerKeyOf } from "./liveview/joiner-server.mjs";
import { createIcons, guestTabs, guestActivity, hostOf } from "./liveview/tabs.mjs";
import { layoutFrom } from "./liveview/layout.mjs";
import { hiddenFromLiveView, BROWSER_PAGE_ORIGINS } from "../ui/urls.js";
import { OWNER_EVENTS, PAGES_EVENTS, EVENT_KIND } from "../ui/events.js";
import { createToolsRoutes } from "./liveview/routes/tools.mjs";
import { createTimelineRoutes } from "./liveview/routes/timeline.mjs";
import { createSessionRoutes } from "./liveview/routes/sessions.mjs";
import { createPagesRoutes } from "./liveview/routes/pages.mjs";
import { createOwnerRoutes, inviteItems } from "./liveview/routes/owner.mjs";
import { createViewerRoutes } from "./liveview/routes/viewer.mjs";
import { NO_CAPTURE_SHARE, targetIdOf } from "./daemon/capture.mjs";
import { createActivityLog } from "./daemon/activitylog.mjs";
import { createApprovalShare } from "./liveview/approval-share.mjs";
import { FRAME_SKIP_BYTES, STALLED_BYTES } from "../ui/limits.js";

export { hostOk, originOk, keyOk } from "./liveview/http.mjs";
export { liveViewHostsFrom, inviteBaseFrom, inviteLabel, createInvites, roleMay } from "./liveview/invites.mjs";
export { addressToUrl } from "./liveview/input.mjs";
export { readTabOrder } from "./liveview/routes/pages.mjs";

const TICK_MS = 1500; // following Claude's tab, and the tab strip
const ACTIVITY_MAX = 30; // the activity event's lines; the session's log (activityLog) keeps more
const INPUT_BATCH_MAX = 500;
// A reader FRAME_SKIP_BYTES behind gets no new frames until it catches up; STALLED_BYTES behind,
// the connection is cut (the page reconnects). ui/limits.js.

// Who gets which event: ui/events.js, the one list the pages read too. OWNER_ONLY: only the
// owner's streams. PAGES_ONLY: only the browser's own pages' streams (?page=), never the live view
// page, a viewer or a guest. PAGE_EVENT_KIND: an event that goes only to the page streams of that
// one kind (least privilege: the SDPs and recording calls reach the capture page alone).
const OWNER_ONLY = new Set(OWNER_EVENTS);
const PAGES_ONLY = new Set(PAGES_EVENTS);
// The owner's POSTs that no person makes (onPersonInput): the tab strip's report of the tabs, the
// capture page's answers, and the live view's input (its pane size; a press is heard where replayed).
const OWN_REPORTS = new Set(["tab-order", "capture", "input"]);
const PAGE_EVENT_KIND = new Map(Object.entries(EVENT_KIND));
const SESSION_FIELDS = ["canRename", "canSave", "savedAt", "canRenameSaved"]; // the owner's streams only

// What the helper does for shared tabs beyond addresses (each a no-op until it's given).
// readForm(page): { url, fields } as they may cross, or null. applyForm(page, fields, who).
// onJoinerAgent(page, who, color, left, from, where): a drive joiner's agent works in their copy
// of the tab (left: ms its turn there still holds; from: that joiner; where: their name).
// arrange(pages): puts tabs in this order. order(pages): the pages as the tab strip shows them,
// or null. showPointers(page, list): draws the others' pointers
// there. sessionFor(j): who is doing what, for joiner j. onJoinerSay(body, j, key): who is doing
// what on a joiner's side, or a message from there (text only; any role).
const sharedDefaults = { readForm: async () => null, applyForm: async () => {}, onJoinerAgent: () => {}, arrange: async () => {}, order: async () => null, showPointers: () => {}, sessionFor: () => null, onJoinerSay: () => {}, onJoinerGone: () => {}, onJoinerLost: () => {} };


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
// onPersonInput(): a person pressed something the page script never sees (the browser's own pages,
// the side panel, the live view's own controls): every owner request that changes something and
// passed its checks, but the pages' own reports (OWN_REPORTS) and the live view's input (replayed
// into a tab, heard there through onHumanInput).
export async function startLiveView({ activityLog = null, reporter = null, tools = null, onPagesKey = () => {}, onPersonInput = () => {}, sessionOps = null, outlines = null, mask = (t) => t, timeline = null, layoutDefaults = null, settings = null, extraOrigins = [], getContext, currentUrl, log = () => {}, port: wantPort = 0, profile = null, onHumanInput = () => {}, hosts = [], inviteOrigin = null, invites = createInvites(),
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
  let devState = null; // dev servers, for the owner's side panel
  let status = { text: "", kind: "clear" };
  let sessionInfo = { name: "", where: "" };
  const activity = []; // newest last, at most ACTIVITY_MAX
  let collaboration = { participants: [], owner: null, active: null, humanUntil: 0 };
  let closed = false;
  let board = null; // who is doing what across a shared session, and its messages
  let driving = false; // an agent is acting (presence onActing), for the owner's pages while an approval waits
  const humanQueue = serially(); // people's input, in order
  const replayer = createInputReplayer();
  // The picture: the tab on screen, its screencast, following Claude's tab (liveview/cast.mjs).
  const cast = createCast({ getContext, currentUrl, personTab: (p) => personTab(p), replayer, broadcast: (e, d) => broadcast(e, d), tabsInfo: () => tabsInfo(), viewers, watching: () => watching(), isClosed: () => closed, log });
  const { show, follow, stopIfIdle } = cast;
  const iconFor = createIcons();
  const kinds = new Map(); // event stream -> the browser page's kind (?page=), owner streams only
  const tabOrder = { sig: "", order: null }; // the tab strip's last report (POST tab-order); gone with this live view
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
      return { i, title: (await ownTitle(p)) || p.url(), url: p.url(), icon: await iconFor(p), shown: p === cast.state.shown?.page, claude: p === cast.state.followedPage,
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
    for (const j of joiners.values()) if (recentlySeen(j)) seen.set(joinerKeyOf(j.invite.id, j.joinerId), { label: personLabel(j.name, j.app), role: roleOf(invites.get?.(j.invite.id) || j.invite) });
    for (const r of remote) seen.set(`remote:${r.label}`, r);
    return [...seen.values()];
  };
  const collaborationNow = () => ({ ...collaboration, guests: guests() });
  // Joiners connected right now (name, app, computer), for the session picker's "Live" badge.
  const joinersNow = () => [...joiners.values()].filter(recentlySeen).map((j) => ({ who: j.name, app: j.app || "", computer: j.computer || "" }));

  // The pause as guests get it: without who is paused on their own (the owner's only).
  const guestPause = (p) => { if (!p || typeof p !== "object") return p; const { perAgent, agents, ...rest } = p; return rest; };
  // An event as an invite link's guest gets it: addresses without query strings (like joiners),
  // never a person's own tab, the session without the owner's fields, the pause without "Pause
  // this agent". broadcast, the events stream's first writes and state.json all use it.
  const forGuest = (event, data) => event === "tabs" ? guestList(data) : event === "activity" ? guestActivity(data)
    : event === "session" ? guestSession() : event === "pause" ? guestPause(data) : data;
  // The session as a guest sees it: without this helper's instance name (the owner's own label).
  const guestSession = () => { const { instance: _instance, ...rest } = sessionInfo; return rest; };
  const broadcast = (event, data) => {
    const msg = sse(event, data);
    for (const res of event === "frame" ? viewers : OWNER_ONLY.has(event) ? owners : clients) {
      if (PAGES_ONLY.has(event) && !kinds.has(res)) continue;
      if (PAGE_EVENT_KIND.has(event) && kinds.get(res) !== PAGE_EVENT_KIND.get(event)) continue;
      // A reader that stopped reading (a laptop asleep with the connection still open) would
      // otherwise collect every frame in memory: frames wait for it, and one far behind is cut.
      if (res.writableLength > STALLED_BYTES) { res.destroy(); continue; }
      if (event === "frame" && res.writableLength > FRAME_SKIP_BYTES) continue;
      if (event === "frame" && linkGuests.has(res) && personTab(cast.state.lastFrameFrom)) continue; // a person's own tab: never to guests
      res.write(linkGuests.has(res) ? sse(event, forGuest(event, data)) : msg);
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
    // Every tunnel address to this session (sharing/join-client.mjs moves to another when one goes down).
    const urls = relays();
    return { ...state, ...(dev.length ? { dev } : {}), ...(urls.length > 1 ? { relays: urls } : {}) };
  }

  // A drive joiner's changes in the shared tabs: opened, moved to another address, closed, as if
  // by hand (presence pauses agents in that tab). Only addresses that may cross (never the host's
  // local network); ids the joiner can know.
  const joinerKey = (j) => joinerKeyOf(j.invite.id, j.joinerId);
  // A tab on a shared dev server, as its shared address (null: not one).
  const devUrl = (url) => devShare?.toPublic(url) || null;
  devShare?.members((key) => joiners.has(key));
  // Shared browser joiners' pointers for the PairBrowse browser's overlay over the page card
  // (push.mjs pushOverlay): to the browser's own pages only (its strip passes them on to the
  // browser), each tab by its CDP target id. One at a time, the latest wins. The owner's live view
  // gets the shown tab's (joiner-pointers) and draws them over its picture: in the open build,
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
        const here = (list.find((x) => x.page === cast.state.shown?.page)?.pointers || []).slice(0, 12);
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
  // The host's approval cards for joiners with the approve role (and a notice for the others).
  const approvalShare = clickApprovals ? createApprovalShare({ clickApprovals, invites, joinRequests: approvals, joiners, push, host: () => shared.host, log }) : null;

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
    if (!screens) return { problem: "Shared browser mode isn't available here. Ask the host for a shared browser invite." };
    const key = joinerKey(j);
    const op = String(body?.op || "");
    const peerOk = (peer) => typeof peer === "string" && peer.startsWith(`${key}|`) && peer.length < 200;
    if (op === "want") {
      // Nothing here captures a tab (a PairBrowse build without its capture page): the joiner's
      // side goes to the pictures through the channel at once.
      if (screens.available && !screens.available()) return { problem: NO_CAPTURE_SHARE, route: "frames" };
      const page = await pageById(String(body?.id || ""));
      if (!page || !crossesWhole(page) || personTab(page)) return { problem: "That tab isn't shared. Choose a shared tab." };
      const id = idOf(page);
      const peer = `${key}|${id}|${randomBytes(4).toString("hex")}`;
      const r = await screens.offer(page, peer, {
        role: j.invite.role, who: j.name, onInput: onScreenInput(page, j, id), onPick: onScreenPick(page, j, id),
        onState: (state) => push.broadcast("screen", { op: "state", id, peer, state }, { to: key }),
      });
      return { peer, id, sdp: r.sdp };
    }
    if (op === "answer") return peerOk(body.peer) && await screens.answer(body.peer, body.sdp) ? { ok: true } : { problem: "No such connection. Reload the picture to connect again." };
    if (op === "stop") { if (peerOk(body.peer)) await screens.stop(body.peer); return { ok: true }; }
    // The slower route: pictures of the tab through the channel, and input back.
    if (op === "frames") {
      const page = await pageById(String(body?.id || ""));
      if (!page || !crossesWhole(page) || personTab(page)) return { problem: "That tab isn't shared. Choose a shared tab." };
      const id = idOf(page);
      if (body.on) await screens.frames(page, key, (img) => push.broadcast("screen", { op: "frame", id, img }, { to: key }));
      else await screens.frames(page, key, null);
      return { ok: true };
    }
    if (op === "input") {
      const page = await pageById(String(body?.id || ""));
      if (!page || !crossesWhole(page) || personTab(page)) return { problem: "That tab isn't shared. Choose a shared tab." };
      if (j.invite.role !== "drive") return { problem: "This code is for watching only. Ask the host for one that can drive." };
      await screens.input(page, (Array.isArray(body.events) ? body.events : []).slice(0, 200), onScreenInput(page, j, idOf(page)), j.name, onScreenPick(page, j, idOf(page)));
      return { ok: true };
    }
    // The files they picked for that dialog: only from their own folder here (sent over just before).
    if (op === "picked") {
      const p = picks.get(String(body?.token || ""));
      if (!p || p.key !== key || p.page.isClosed()) return { problem: "That file request is over. Choose the files again when the page asks." };
      picks.delete(body.token);
      const mine = remoteAgents?.folder(key);
      const files = (Array.isArray(body.files) ? body.files : []).slice(0, 20).map(String);
      if (!mine || files.some((f) => !resolve(f).startsWith(resolve(mine) + sep))) return { problem: "Those files didn't come from you. Choose files on your own computer." };
      await screens.setFiles(p.chooser, files);
      return { ok: true };
    }
    return { problem: "Unknown request." };
  }
  // A joiner's own agent at work here and its answers back (liveview/agent-relay.mjs).
  const agentRelay = createAgentRelay({ push, remoteAgents, getContext, idOf, crossesWhole: (p) => crossesWhole(p), personTab, joinerKey });
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
  // A drive joiner's changes in the shared tabs (liveview/joiner-tabs.mjs).
  const applyTabs = createJoinerTabs({ getContext, idOf, tabsFor, humanQueue, shared, onJoinerPerson, onJoinerActivity, joinerKey, push, devUrl, devShare, secretDomains, log });

  const stopApprovals = approvals.onChange(() => { broadcast("join", approvals.open()); approvalShare?.changed(); });
  // An invite switched between drive and approve: Settings hears it, the joiners get their cards
  // (or lose them) at once.
  const stopRoles = invites.onRole ? invites.onRole(() => { approvalShare?.changed(); broadcast("invites", { items: inviteItems(invites.list()) }); }) : () => {};
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

  // A person's clicks, typing and tab changes, from a viewer. who: their name for the others
  // (null: the owner). Only the owner may resize the shared page ("Fit to pane").
  const guestBudgets = new Map(); // invite id -> its input budget (inputBudget)
  async function humanPost(route, ev, role, who, inviteKey = null) {
    if (route === "input") {
      // Each event checked (kinds, places inside the picture, modifiers, no clipboard for an invited
      // viewer); an invited viewer's input paced per invite.
      const frame = cast.state.lastFrame ? { w: cast.state.lastFrame.w, h: cast.state.lastFrame.h } : null;
      let batch = (Array.isArray(ev) ? ev : [ev]).slice(0, INPUT_BATCH_MAX).map((one) => readViewerInput(one, { frame, role })).filter(Boolean);
      if (role !== "owner" && inviteKey) {
        if (!guestBudgets.has(inviteKey)) guestBudgets.set(inviteKey, inputBudget());
        if (!guestBudgets.get(inviteKey)(batch.length)) batch = [];
      }
      if (!batch.length) return;
      return humanQueue(async () => {
        if (role !== "owner" && personTab(cast.state.shown?.page)) return; // a person's own tab: never a guest's input
        // Only moving the pointer (or the wheel) changes nothing an agent's refs point at.
        if (batch.some((one) => one?.type !== "viewport")) await onHumanInput(cast.state.shown?.page || null, who, batch.some((one) => !["viewport", "wheel"].includes(one?.type) && !(one?.type === "mouse" && one.action === "mouseMoved")));
        const done = onReplay(who);
        try { for (const one of batch) await replayer.replay(cast.state.shown, one, role).catch((e) => log("liveview input", e?.message || e)); } finally { done(); }
      });
    }
    return humanQueue(async () => {
      await onHumanInput(cast.state.shown?.page || null, who);
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
  const toolRoutes = createToolsRoutes({ tools, mask, recordState, idOf, bringTabForward, previewOf, viewers, clients, joinersNow, guests });
  const timelineRoutes = createTimelineRoutes({ timeline, mask, broadcast });
  // What the viewer's routes read, as each request comes (liveview/routes/viewer.mjs).
  const lv = {
    clients, viewers, owners, kinds, linkGuests, activity, approvals, joinHost, clickApprovals,
    get shown() { return cast.state.shown; }, get lastFrame() { return cast.state.lastFrame; }, get lastFrameFrom() { return cast.state.lastFrameFrom; },
    get status() { return status; }, get sessionInfo() { return sessionInfo; }, get devState() { return devState; },
    get board() { return board; }, get driving() { return driving; },
    captureOk, collaborationChanged, stopIfIdle, follow, tabsInfo, forGuest, ownerSession, collaborationNow, layoutNow,
    watchPages, agentTabs, pauseState, recordState, personTab, getContext, currentUrl, humanPost, onPause,
  };
  const ROUTES = [
    ...createViewerRoutes(lv),
    ...createOwnerRoutes({ approvals, clickApprovals, joiners, push, stopJoinerKey, collaborationChanged, log, devPanel, joinHost, profile, journal, invites, makeInvite, broadcast, onRecord, tools, mask, recordState }),
    ...createSessionRoutes({ picker, sessionOps, broadcast, ownerSession, linkGuests, layouts, joinersNow, recordState, clickApprovals }),
    ...createPagesRoutes({ history, layoutNow, layouts, sessionName: () => sessionInfo.name, broadcast, settings, reporter, outlines, webPages, getContext, idOf, mask, watchPages, tabsStrip, agentTabs, tabOrder, capture, captureOk }),
    ...timelineRoutes.routes,
    ...toolRoutes.routes,
  ];





  const browserPageOrigin = (o) => !!o && BROWSER_PAGE_ORIGINS.includes(o) && extraOrigins.includes(o);
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
    if (role === "owner" && browserPageOrigin(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
    if (req.method === "OPTIONS") {
      if (role !== "owner" || !browserPageOrigin(origin)) return plain(res, 404);
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
      if (role === "owner" && req.method !== "GET" && !OWN_REPORTS.has(route)) try { onPersonInput(); } catch {}
      await r.handler({ req, res, route, rest, role, invite, byPages });
    } catch (e) {
      log("liveview", e?.message || e);
      if (!res.headersSent) plain(res, 500);
    }
  });

  // A joiner gone (left or removed): their agent here and their pictures stop.
  // What they said about their side's agents goes too.
  async function stopJoinerKey(key) { agentRelay.forget(key); remoteAgents?.stop(key); shared.onJoinerGone(key); await screens?.stopAll(`${key}|`); }
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
    live: { tabsFor, applyTabs, screen, agent: agentRelay.remoteAgent, file: agentRelay.remoteFile,
      stopScreens: stopJoiner, openStream: (j, conn) => { watchPages(); return push.open(j, conn).then(() => { agentRelay.resend(joinerKey(j)); approvalShare?.opened(j); }).catch((e) => log("push", e?.message || e)); },
      approval: (body, j) => (approvalShare ? approvalShare.answer(body, j) : { code: 404, body: { error: "Unknown request." } }), pointersFor: (body, j) => push.fromJoiner(body, j), say: (body, j) => shared.onJoinerSay(body, j, joinerKey(j)), changed: () => { collaborationChanged(); push.changed(); } },
  });

  try {
    await listen(server, wantPort);
    await joinerServer.listen(wantGuestPort);
  } catch (e) {
    stopEnded(); stopApprovals(); stopRoles(); server.close();
    throw e;
  }

  // Named final clicks asked in the browser (daemon/approvals.mjs): the owner's streams only. While
  // one waits, they also hear whether an agent is acting (driving), so a card can say so.
  const stopClickApprovals = clickApprovals?.onChange ? clickApprovals.onChange((change) => {
    broadcast("approval", change);
    approvalShare?.changed();
    if (change?.op === "add" && clickApprovals.pending().length === 1) broadcast("driving", { on: driving });
  }) : () => {};
  // The timeline changed (a picture kept, a card removed or pinned, a note): the owner's pages.
  const stopTimeline = timeline?.onChange ? timeline.onChange((change) => broadcast("timeline", { op: change.op, card: timelineRoutes.maskedCard(change.card) })) : () => {};
  // An outline kept or dropped (daemon/outline.mjs): the owner's pages hear which tab, never the text.
  const stopOutlines = outlines?.onChange ? outlines.onChange((c) => {
    if (!c?.page) return;
    broadcast("outline", { op: c.op, tab: idOf(c.page), ...(c.op === "set" ? { host: hostOf(c.page.url()), who: c.who, at: c.at, cut: c.cut } : {}) });
  }) : () => {};

  // The Tools tab's lists changed: the owner's streams hear it (downloads and hand-offs are
  // owner-only events; a recording saved or deleted goes on "record", to the owner's streams only).
  const toolEvents = serially(); // in order: a hand-off's title is read before its removal goes out
  const stopTools = tools ? [
    tools.downloads?.onChange?.((c) => broadcast("downloads", { op: c.op, item: toolRoutes.maskedDownload(c.item) })),
    tools.handoffs?.onChange?.((c) => toolEvents(async () => broadcast("handoffs", c.op === "remove" ? { op: "remove", id: c.id, item: { id: c.id } } : { op: c.op, item: await toolRoutes.handoffItem(c.item) })).catch(() => {})),
    tools.recordings?.onChange?.((c) => broadcast("record", { ...(recordState() || {}), op: c.op, ...(c.op === "removed" ? { id: c.id } : { item: c.item }) })),
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
    stripTabs: () => tabOrder.order,
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
    // The badge state, mirrored in the viewer's own frame (pages can't fake it there).
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
    setRecord: (state) => broadcast("record", state),
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
    // Joiners with the approve role in a shared browser session now: they can answer an approval.
    approveJoiners: () => approvalShare?.approvers() || 0,
    // Anyone in a shared browser session now: they see "Waiting for <host> to approve" while the terminal asks.
    sharedJoiners: () => approvalShare?.inSession() || 0,
    // A tab's number, as the browser's own pages and browser_tabs count them.
    tabIndex: async (page) => (await getContext()).pages().indexOf(page),
    layout: layoutNow,
    close: () => {
      closed = true;
      clearInterval(timer);
      stopEnded(); stopApprovals(); stopRoles(); stopTimeline(); stopOutlines(); stopClickApprovals();
      for (const stop of stopTools) stop();
      server.close();
      for (const r of clients) r.end();
      joinerServer.close();
      push.close();
      cast.close();
    },
  };
}
