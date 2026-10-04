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
import http from "node:http";
import { randomBytes } from "node:crypto";
import { keepFocus } from "./focus.mjs";
import { createApprovals, personLabel, cleanName } from "./join.mjs";
import { stateForJoiner, readOps, shareableUrl, onSecretDomain } from "./tabsync.mjs";
import { createPush } from "./liveview/push.mjs";
import { hostOk, originOk, keyOk, readBody, BODY_MAX, SECURITY_HEADERS, serveViewer, serveAsset, plain, pathParts, listen } from "./liveview/http.mjs";
import { createInvites, roleMay } from "./liveview/invites.mjs";
import { createInputReplayer } from "./liveview/input.mjs";
import { createJoinerServer, recentlySeen } from "./liveview/joiner-server.mjs";
import { createIcons, guestTabs, guestActivity, withoutIcons } from "./liveview/tabs.mjs";

export { hostOk, originOk, keyOk } from "./liveview/http.mjs";
export { liveViewHostsFrom, inviteBaseFrom, inviteLabel, createInvites, roleMay } from "./liveview/invites.mjs";
export { addressToUrl } from "./liveview/input.mjs";

const TICK_MS = 1500; // following Claude's tab, and the tab strip
const SETTLE_MS = 180; // the page is still this long: send one sharp frame
const SHARP_QUALITY = 90;
const THUMB_QUALITY = { min: 20, max: 80, default: 50 };
const JOINER_NAV_MS = 15_000; // a joiner's change: until the host's tab starts loading it
const ACTIVITY_MAX = 30;
const STATE_ACTIVITY = 4; // activity lines in state.json
const INPUT_BATCH_MAX = 500;
const OWNER_ONLY = new Set(["profile", "join", "board", "dev"]); // events only the owner's streams get
// What the helper does for shared tabs beyond addresses (each a no-op until it's given).
// readForm(page): { url, fields } as they may cross, or null. applyForm(page, fields, who).
// onJoinerAgent(page, who, color, left, from, where): a drive joiner's agent works in their copy
// of the tab (left: ms its turn there still holds; from: that joiner; where: their name).
// arrange(pages): puts tabs in this order. order(pages): the pages as the tab strip shows them,
// or null. showPointers(page, list): draws the others' pointers
// there. sessionFor(j): who is doing what, for joiner j. onJoinerSay(body, j, key): who is doing
// what on a joiner's side, or a message from there (text only; any role).
const sharedDefaults = { readForm: async () => null, applyForm: async () => {}, onJoinerAgent: () => {}, arrange: async () => {}, order: async () => null, showPointers: () => {}, sessionFor: () => null, onJoinerSay: () => {} };

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
const json = (res, code, data) => { res.writeHead(code, { ...SECURITY_HEADERS, "content-type": "application/json" }); res.end(JSON.stringify(data)); };

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
// secretDomains(): sites with saved passwords, whose tabs reach joiners as origin + path only.
// onJoinerPerson(page, who, did, acting, changed): a drive joiner uses their copy of a tab by
// hand (agents here wait, as for a person here; changed: they navigated, opened or closed it).
// onJoinerActivity(page, text, who, from): their agent acted there.
// shared: the rest of what shared tabs carry (see sharedDefaults): form values, their agents'
// sparks, tab order and pointers.
export async function startLiveView({ extraOrigins = [], getContext, currentUrl, log = () => {}, port: wantPort = 0, profile = null, onHumanInput = () => {}, hosts = [], inviteOrigin = null, invites = createInvites(),
  guestPort: wantGuestPort = 0, tunnelHost = () => null, approvals = createApprovals(), onJoinRequest = () => {}, tabMeta = () => ({}), secretDomains = () => [], onJoinerPerson = () => {}, onJoinerActivity = () => {}, shared: sharedGiven = {},
  onPause = () => ({}), pauseState = () => null, picker = null, devShare = null, devPanel = null }) {
  const shared = { ...sharedDefaults, ...sharedGiven };
  const key = randomBytes(32).toString("base64url");
  const clients = new Set(); // every open event stream
  const linkGuests = new Map(); // event stream -> the invite link it was opened with
  const owners = new Set(); // event streams opened with the owner's key (the Profile panel's updates go only there)
  const viewers = new Set(); // the ones that show the page (the PairBrowse side panel doesn't)
  const joiners = new Map(); // `${inviteId}:${joinerId}` -> { invite, joinerId, name, app, seen, inflight, ops }
  let shown = null; // the tab on screen: { page, cdp }
  let lastFrame = null;
  let devState = null; // dev servers, for the owner's side panel
  let status = { text: "", kind: "clear" };
  let sessionInfo = { name: "", where: "" };
  let followed; // URL of the tab Claude is working in
  let followedPage = null;
  const activity = []; // newest last, at most ACTIVITY_MAX
  let collaboration = { participants: [], owner: null, active: null, humanUntil: 0 };
  let closed = false;
  let board = null; // who is doing what across a shared session, and its messages
  const humanQueue = serially(); // people's input, in order
  const showQueue = serially(); // switching the shown tab: one CDP session at a time
  const replayer = createInputReplayer();
  const iconFor = createIcons();

  const watching = () => viewers.size > 0;
  // People in the session the user joined (shared tabs), shown with everyone else here.
  let remote = [];
  // Tabs' ids for joiners: random, so they say nothing about the host's other tabs.
  const tabIds = new WeakMap();
  const idOf = (page) => { let id = tabIds.get(page); if (!id) tabIds.set(page, (id = randomBytes(4).toString("hex"))); return id; };

  // Every tab, with who is in it (the agent holding it, with its spark color; a person using it
  // by hand) and the last thing done there: the tab overview.
  const tabsInfo = async () => {
    const ctx = await getContext();
    return Promise.all(ctx.pages().map(async (p, i) => {
      let meta = {};
      try { meta = tabMeta(p) || {}; } catch {}
      return { i, title: (await p.title().catch(() => "")) || p.url(), url: p.url(), icon: await iconFor(p), shown: p === shown?.page, claude: p === followedPage,
        agent: meta.agent || null, person: meta.person || null, waiting: !!meta.waiting, last: meta.last || null };
    }));
  };

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

  const broadcast = (event, data) => {
    const msg = sse(event, data);
    for (const res of event === "frame" ? viewers : OWNER_ONLY.has(event) ? owners : clients) {
      // Link guests get addresses without query strings, like joiners.
      if (linkGuests.has(res) && event === "tabs") res.write(sse(event, guestTabs(data)));
      else if (linkGuests.has(res) && event === "activity") res.write(sse(event, guestActivity(data)));
      else res.write(msg);
    }
  };
  const collaborationChanged = () => broadcast("collaboration", collaborationNow());

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
    const tabs = await Promise.all(inStrip.map(async (p) => {
      let meta = {};
      try { meta = tabMeta(p) || {}; } catch {}
      // A joiner's own agent isn't sent back to them; another joiner's is (their agents wait for it).
      const agent = meta.agent && (!meta.agent.joined || (meta.agent.from && meta.agent.from !== joinerKey(j))) ? meta.agent : null;
      // left: how long its turn there still holds (the joiner's agents wait or hear "in use"), in
      // whole seconds so the state isn't news every round.
      const left = agent?.until > Date.now() ? Math.ceil((agent.until - Date.now()) / 1000) * 1000 : 0;
      return { id: idOf(p), url: p.url(), title: await p.title().catch(() => ""), agent: agent?.label || "", color: agent?.color || "", left, person: meta.sharedPerson?.who || "", acting: !!meta.sharedPerson?.acting, did: meta.did || [] };
    }));
    const people = [...collaboration.participants.map((x) => x?.label || ""), ...guests().map((g) => g.label)].filter((x) => x && x !== personLabel(j.name, j.app));
    const state = stateForJoiner({ tabs, activity, people }, { drive: j.invite.role === "drive", secretDomains: secretDomains(), name: j.name, from: joinerKey(j), mapUrl: devUrl });
    // Shared dev servers (devshare.mjs): their addresses and this joiner's own token for them.
    const dev = devShare?.forJoiner(joinerKey(j), j.invite.role) || [];
    return dev.length ? { ...state, dev } : state;
  }

  // A drive joiner's changes in the shared tabs: opened, moved to another address, closed, as if
  // by hand (presence pauses agents in that tab). Only addresses that may cross (never the host's
  // local network); ids the joiner can know.
  const joinerKey = (j) => `${j.invite.id}:${j.joinerId}`;
  // A tab on a shared dev server, as its shared address (null: not one).
  const devUrl = (url) => devShare?.toPublic(url) || null;
  devShare?.members((key) => joiners.has(key));
  const push = createPush({ getContext, idOf, tabsFor, joinerKey, secretDomains, shared, tabMeta, isIn: (key) => joiners.has(key), sessionFor: (j) => shared.sessionFor(j), mapUrl: devUrl, log });
  // Tabs opening, closing and going elsewhere reach joiners at once, not on the next round
  // (watched from the first joiner's stream on).
  let pagesWatched = false;
  const watchPages = () => {
    if (pagesWatched) return;
    pagesWatched = true;
    getContext().then((ctx) => {
      const watch = (p) => {
        p.on("framenavigated", (f) => { if (f === p.mainFrame()) push.changed(); });
        p.on("load", push.changed);
        p.on("close", push.changed);
      };
      ctx.pages().forEach(watch);
      ctx.on("page", (p) => { watch(p); push.changed(); });
    }).catch(() => {});
  };
  async function applyTabs(body, j) {
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
        if (o.op === "person") { onJoinerPerson(page, j.name, o.did, o.acting); continue; }
        if (o.op === "activity") { onJoinerActivity(page, o.text, o.who || who, joinerKey(j)); continue; }
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
        onJoinerPerson(page, j.name, [], true, true);
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

  const stopApprovals = approvals.onChange(() => broadcast("join", approvals.pending()));
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
      changed = true;
    }
    approvals.forget(ids);
    if (changed) collaborationChanged();
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
  const show = (page) => showQueue(() => showNow(page));
  async function showNow(page) {
    if (closed || shown?.page === page) return;
    if (shown) {
      const old = shown.cdp;
      shown = null;
      await release(old);
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        frameSeq++;
        lastFrame = { img: data, w: metadata.deviceWidth, h: metadata.deviceHeight };
        broadcast("frame", lastFrame);
        sharpenSoon(cdp);
      });
      await bringTabForward(page);
      // A clean, browser-like view: no classic scrollbars (scroll with the wheel or trackpad).
      await cdp.send("Emulation.setScrollbarsHidden", { hidden: true }).catch(() => {});
      await replayer.attach(cdp);
      await replayer.startCast(cdp);
    } catch (e) {
      await release(cdp);
      throw e;
    }
    if (closed) return release(cdp);
    shown = { page, cdp };
    if (!wired.has(page)) {
      wired.add(page);
      page.once("close", () => { if (shown?.page === page) shown = null; if (watching()) follow(); });
    }
    broadcast("tabs", await tabsInfo());
  }

  // Follow the tab Claude is working in, whenever that changes. Between changes, the tab you
  // picked in the viewer stays put.
  async function follow() {
    try {
      const ctx = await getContext();
      const url = await currentUrl();
      if (shown && url === followed) return;
      followed = url;
      const page = ctx.pages().find((p) => p.url() === url) || shown?.page || ctx.pages().at(-1);
      if (url) followedPage = page;
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
      followed = undefined;
      replayer.resetFit();
      await release(cdp);
    });
  }

  // A person's clicks, typing and tab changes, from a viewer. who: their name for the others
  // (null: the owner). Only the owner may resize the shared page ("Fit to pane").
  async function humanPost(route, ev, role, who) {
    if (route === "input") {
      const batch = (Array.isArray(ev) ? ev : [ev]).slice(0, INPUT_BATCH_MAX).filter((one) => role === "owner" || one?.type !== "viewport");
      return humanQueue(async () => {
        // Only moving the pointer (or the wheel) changes nothing an agent's refs point at.
        if (batch.some((one) => one?.type !== "viewport")) await onHumanInput(shown?.page || null, who, batch.some((one) => !["viewport", "wheel"].includes(one?.type) && !(one?.type === "mouse" && one.action === "mouseMoved")));
        for (const one of batch) await replayer.replay(shown, one, role).catch((e) => log("liveview input", e?.message || e));
      });
    }
    return humanQueue(async () => {
      await onHumanInput(shown?.page || null, who);
      const ctx = await getContext();
      if (ev.new) await show(await keepFocus(() => ctx.newPage()));
      else if (ev.close !== undefined) {
        const page = ctx.pages()[Number(ev.close)];
        // The last tab is emptied instead of closed, so the browser window stays open.
        if (page && ctx.pages().length > 1) await page.close().catch(() => {});
        else if (page) await page.goto("about:blank").catch(() => {});
        broadcast("tabs", await tabsInfo());
      } else {
        const page = ctx.pages()[Number(ev.i)];
        if (page) await show(page);
      }
    });
  }

  // ---- the owner's port: your own link, the side panel, and invite links -------------------
  // Each route names the right it needs (invites.mjs); a route that isn't listed is refused.
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
      json(res, 200, { status, session: sessionInfo, collaboration: collaborationNow(), tabs: invite ? guestTabs(tabs) : tabs, activity: invite ? guestActivity(recent) : recent, frame: lastFrame ? { w: lastFrame.w, h: lastFrame.h } : null });
    } },
    // People asking to join with a code, for the owner to let in or not.
    { method: "GET", path: "joins.json", right: "approve", handler: ({ res }) => json(res, 200, approvals.pending()) },
    { method: "POST", path: "approve", right: "approve", handler: async ({ req, res }) => {
      const body = await readBody(req, BODY_MAX.approve);
      if (body === null) return plain(res, 413);
      const op = JSON.parse(body);
      const done = op.allow === true ? approvals.approve(op.id) : approvals.deny(op.id);
      json(res, done ? 200 : 404, { ok: !!done, request: done });
    } },
    // Dev servers (devshare.mjs), for the owner only: what's open on localhost and shared, an
    // agent's question to share one; and the owner's answer, Share or Stop (a real click).
    { method: "POST", path: "dev", right: "approve", handler: async ({ req, res }) => {
      if (!devPanel) return plain(res, 404);
      const body = await readBody(req, BODY_MAX.approve);
      if (body === null) return plain(res, 413);
      const r = await devPanel.act(JSON.parse(body) || {});
      json(res, r.error ? 409 : 200, r);
    } },
    // The Profile panel: remembered details in full, passwords by name and sites only.
    { method: "GET", path: "profile.json", right: "profile", handler: ({ res }) => profile ? json(res, 200, profile.get()) : plain(res, 404) },
    { method: "POST", path: "profile", right: "profile", handler: changeProfile },
    // The session picker (an extension page, with the owner's key from the side panel's memory):
    // the saved sessions, and the person's pick. picker: { state(), pick(op) } from the helper.
    { method: "GET", path: "sessions.json", right: "session", handler: ({ res }) => picker ? json(res, 200, picker.state()) : plain(res, 404) },
    { method: "POST", path: "pick", right: "session", handler: async ({ req, res }) => {
      if (!picker) return plain(res, 404);
      const body = await readBody(req, BODY_MAX.approve);
      if (body === null) return plain(res, 413);
      const r = await picker.pick(JSON.parse(body) || {});
      json(res, r.error ? 409 : 200, r);
    } },
    { method: "POST", path: "input", right: "input", handler: human },
    { method: "POST", path: "tab", right: "tab", handler: human },
    // "Pause agents" and "Resume" (the side panel, a drive guest's viewer): people only, anyone
    // who may drive. who: the guest's name (null: the owner).
    { method: "POST", path: "pause", right: "input", handler: async ({ req, res, invite }) => {
      const body = await readBody(req, BODY_MAX.approve);
      if (body === null) return plain(res, 413);
      const r = onPause(JSON.parse(body)?.paused === true, invite ? invite.label : null) || {};
      json(res, r.problem ? 409 : 200, r);
    } },
  ];

  async function events({ req, res, invite }) {
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
    // ?panel: status, activity and profile only (the PairBrowse side panel): no page stream.
    const viewer = !new URL(req.url, "http://x").searchParams.has("panel");
    clients.add(res);
    if (viewer) viewers.add(res);
    if (invite) linkGuests.set(res, invite);
    else owners.add(res);
    if (invite) collaborationChanged();
    req.on("close", () => {
      clients.delete(res);
      viewers.delete(res);
      owners.delete(res);
      if (linkGuests.delete(res)) collaborationChanged();
      stopIfIdle();
    });
    if (viewer) await follow();
    const tabs = await tabsInfo();
    res.write(sse("tabs", invite ? guestTabs(tabs) : tabs));
    res.write(sse("status", status));
    res.write(sse("session", sessionInfo));
    res.write(sse("collaboration", collaborationNow()));
    res.write(sse("activity", invite ? guestActivity(activity) : activity));
    if (!invite) res.write(sse("join", approvals.pending()));
    if (!invite && devState) res.write(sse("dev", devState));
    if (!invite && board) res.write(sse("board", board));
    const paused = pauseState();
    if (paused) res.write(sse("pause", paused));
    if (viewer && lastFrame) res.write(sse("frame", lastFrame));
  }

  async function thumb({ req, res }) {
    if (!shown) await follow();
    if (!shown) return plain(res, 404);
    const q = Number(new URL(req.url, "http://x").searchParams.get("q")) || THUMB_QUALITY.default;
    // What's on screen, unscaled: a clip or scale makes Chromium re-lay out the page (it flickers).
    const { data } = await shown.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: Math.min(THUMB_QUALITY.max, Math.max(THUMB_QUALITY.min, q)), optimizeForSpeed: true, captureBeyondViewport: false });
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/jpeg" });
    res.end(Buffer.from(data, "base64"));
  }

  async function changeProfile({ req, res }) {
    if (!profile) return plain(res, 404);
    const body = await readBody(req, BODY_MAX.profile);
    if (body === null) return plain(res, 413);
    const op = JSON.parse(body);
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

  async function human({ req, res, route, role, invite }) {
    const body = await readBody(req, BODY_MAX.input);
    if (body === null) return plain(res, 413);
    await humanPost(route, JSON.parse(body), role, invite ? `${invite.label} (by hand)` : null);
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host, hosts)) return plain(res, 403); // blocks DNS-rebinding
    const { key: given, route, rest } = pathParts(req);
    // The owner's key works only under a loopback name (this computer, or an SSH tunnel); the
    // extra host names take invite links only. Unknown, expired and revoked keys look the same.
    const ownerKey = keyOk(given, key);
    // Join code keys work only through the sharing tunnel's port (joiner-server.mjs), after approval.
    const matched = ownerKey ? null : invites.match(given);
    const invite = matched?.share === "code" ? null : matched;
    const role = ownerKey ? (hostOk(req.headers.host) ? "owner" : null) : invite?.role || null;
    if (!role) return plain(res, 404);
    const origin = req.headers.origin;
    if (req.method === "POST" && !originOk(origin) && !(role === "owner" && extraOrigins.includes(origin)) && !(role === "drive" && inviteOrigin && origin === inviteOrigin)) return plain(res, 403);
    const r = ROUTES.find((x) => x.method === req.method && x.path === route);
    if (!r) return plain(res, 404);
    if (!roleMay(role, r.right)) return plain(res, 403);
    try {
      await r.handler({ req, res, route, rest, role, invite });
    } catch (e) {
      log("liveview", e?.message || e);
      if (!res.headersSent) plain(res, 500);
    }
  });

  const joinerServer = createJoinerServer({
    key, invites, approvals, joiners, tunnelHost, onJoinRequest, log,
    live: { tabsFor, applyTabs, openStream: (j, conn) => { watchPages(); return push.open(j, conn).catch((e) => log("push", e?.message || e)); }, pointersFor: (body, j) => push.fromJoiner(body, j), say: (body, j) => shared.onJoinerSay(body, j, joinerKey(j)), changed: () => { collaborationChanged(); push.changed(); } },
  });

  try {
    await listen(server, wantPort);
    await joinerServer.listen(wantGuestPort);
  } catch (e) {
    stopEnded(); stopApprovals(); server.close();
    throw e;
  }

  async function tick() {
    invites.sweep();
    if (watching()) { await follow(); broadcast("tabs", await tabsInfo()); }
  }
  const timer = setInterval(() => tick().catch((e) => log("liveview", e?.message || e)), TICK_MS);
  timer.unref();
  log("live view started");
  return {
    url: `http://127.0.0.1:${server.address().port}/${key}/`,
    follow,
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
    // Which browser session is shown, and where it runs (Local or Server).
    setSession(info) {
      sessionInfo = info;
      broadcast("session", info);
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
      activity.push({ t: Date.now(), text: String(text).slice(0, 200), who: String(who || "").slice(0, 60), tab: String(tab || "").slice(0, 80), ...(page ? { tabId: idOf(page) } : {}), ...(from ? { from } : {}) });
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
    refreshTabs: async () => { push.changed(); if (watching()) broadcast("tabs", await tabsInfo()); },
    // The page script says a field changed in a tab, or a pointer moved (daemon/cobrowse.mjs).
    fieldsChanged: (page) => push.dirty(page),
    pointed: (page, value) => push.pointed(page, value),
    sharing: () => push.active(),
    // Something for the joiners' streams: who is doing what, a message.
    pushToJoiners: (event, data, opts) => push.broadcast(event, data, opts),
    // Agents paused or resumed by a person (daemon/pause.mjs), with whether the owner may press it.
    setPause: () => broadcast("pause", pauseState()),
    // Who is doing what across the session, and its messages: the side panel's Session section.
    setBoard: (next) => { board = next; broadcast("board", board); },
    close: () => {
      closed = true;
      clearInterval(timer);
      clearTimeout(settleTimer);
      stopEnded(); stopApprovals();
      server.close();
      for (const r of clients) r.end();
      joinerServer.close();
      push.close();
      if (shown) { release(shown.cdp); shown = null; }
    },
  };
}
