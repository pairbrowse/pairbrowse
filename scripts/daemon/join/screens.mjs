// Shared browser mode, on the joiner's side: each of the host's tabs is a picture page here
// (screen/index.html, or the browser's own pairbrowse://screen), connected directly to the host's
// tab when in sight, else through the join channel (the slower route); files a person picks there
// for the host's file dialog go over first.
// live: the session joined now (join/state.mjs newFollowState). context: the helper's browser.
// strict(): this browser runs a strict proxied session now (spec server-mode C11): a direct
// connection from its picture page would gather and send this computer's own addresses outside the
// proxy, so every picture page takes the slower route from its first round, never asking for one.
import { randomBytes } from "node:crypto";
import { within } from "../../util.mjs";
import { panelExtensionId } from "../../browser.mjs";
import { BROWSER_SCREEN, extensionUrl, isShownScreenPage } from "../../../ui/urls.js";
import { PICK_FILES_MAX } from "../../../ui/limits.js";
import { FILE_PART } from "./agents.mjs";
import { OPEN_MS } from "./state.mjs";
import { testOn } from "../../testenv.mjs";

// The shared browser's picture page (screen/index.html, PairBrowse's own extension page) is called in its
// own script world, where its script put window.pbScreen: Patchright's page.evaluate otherwise runs
// in a hidden world of its own (the extra arguments are Patchright's; Playwright ignores them).
// Bounded (a page whose scripts never pause answers nothing): null when the time is up.
const SCREEN_CALL_MS = 5000;
export const inScreen = (page, fn, arg, ms = SCREEN_CALL_MS) => within(ms, Promise.resolve().then(() => page.evaluate(fn, arg, undefined, false)));
const OFFER_MS = 20_000; // the picture page's answer to an offer (gathering its connection's routes)
const PICK_MS = 10 * 60_000; // a person choosing files for the host's file dialog
// Shared browser mode (codes with mode "shared"): each of the host's tabs is a page of the
// extension here (screen.js) showing it live; the tab you look at is connected directly.
const SCREEN_KEEP_MS = 60_000; // a tab out of sight stays connected this long (switching back is instant)
const SCREEN_CONNECT_MS = testOn("NO_DIRECT") ? 3000 : 12_000; // no direct connection by then: try again, then the slower route
const SCREEN_INPUT_MS = 30; // on the slower route, input goes to the host this often
// The picture page: the extension's screen/index.html, or in a PairBrowse build with its own pages
// its chrome://pairbrowse/screen/ tab (the same page, driven the same way through window.pbScreen).
const screenBaseFor = (ownPages) => (ownPages ? BROWSER_SCREEN : extensionUrl(panelExtensionId(), "screen/index.html"));
// Any of the picture page's addresses (the extension's, the browser's own, and the name the
// browser shows for it).
export const isScreenPage = (url) => {
  const u = String(url || "");
  return /^chrome-extension:\/\/[a-p]{32}\/screen\/index\.html(?:[#?]|$)/.test(u) || u.startsWith(BROWSER_SCREEN) || isShownScreenPage(u);
};

// The approve role: the host's approval card on a picture page (screen.js approval, approvalOff,
// approvalAnswers), as daemon/approvals.mjs calls the in-page card (hud.call's kinds). Bounded.
export function screenCard(page, arg, kind) {
  if (kind === "approval") return inScreen(page, (v) => window.pbScreen?.approval?.(v) === true, arg, 2000);
  if (kind === "approval-off") return inScreen(page, (id) => window.pbScreen?.approvalOff?.(id) === true, String(arg || ""), 2000);
  if (kind === "approval-answers") return inScreen(page, () => window.pbScreen?.approvalAnswers?.() ?? null, undefined, 2000);
  return Promise.resolve(null);
}

export function createJoinScreens(live, { context, log, presence = null, strict = () => false }) {
  const strictNow = () => { try { return strict() === true; } catch { return true; } };
  const screenBase = () => screenBaseFor(!!context.browserPages?.());

  // The tab id after # keeps the address short (screen/index.html#a1b2c3d4); the page itself shows the
  // host tab's real address and title (screen.js).
  const screenUrl = (id) => `${screenBase()}#${encodeURIComponent(id)}`;

  // The browser's own picture tab may show under its pairbrowse:// name too.
  const isScreen = (page) => page.url().startsWith(screenBase()) || (!!context.browserPages?.() && isShownScreenPage(page.url()));

  // Shared browser mode: a picture page's title and address (the host tab's), said again only
  // when they changed. Not taken yet (the page still loading, say after a typed address took it
  // away and back): tried again next round.
  function showInfo(cur, id) {
    const info = cur.infos.get(id);
    const page = cur.pages.get(id);
    if (!info || !page || page.isClosed() || !isScreen(page)) return;
    const sig = `${info.title}\u0001${info.url}`;
    if (cur.titles.get(id) === sig) return;
    cur.titles.set(id, sig);
    const unsaid = () => { if (cur.titles.get(id) === sig) cur.titles.delete(id); };
    inScreen(page, (i) => window.pbScreen?.info(i) === true, { ...info, who: cur.join.host }).then((ok) => { if (!ok) unsaid(); }, unsaid);
  }

  // Shared browser mode: who works in one of the host's tabs (a person by hand, an agent holding
  // it), on its picture page's tab here: their name before the title, their mark as its icon.
  // Said again only when it changed; a person who left goes after a few seconds (tabWho).
  function showWho(cur, id) {
    const w = cur.who.get(id);
    const page = cur.pages.get(id);
    if (!w || !page || page.isClosed() || !isScreen(page)) return;
    if (w.person && Date.now() >= w.until) Object.assign(w, { person: "", personColor: "", until: 0 });
    const shown = { person: w.person, personColor: w.personColor, agent: w.agent, agentColor: w.agentColor };
    const sig = JSON.stringify(shown);
    if (w.sig === sig) return;
    w.sig = sig;
    // Not taken yet (the page still loading): tried again next round.
    inScreen(page, (x) => window.pbScreen?.who(x) === true, shown).then((ok) => { if (!ok) w.sig = ""; }, () => { w.sig = ""; });
  }

  // The approve role's notice for the people who can't answer ("Waiting for Bob to approve: Pay:
  // Place order"), on every picture page; said again only when it changed (cur.notice).
  const noticeSaid = new WeakMap(); // page -> the notice it shows
  function showNotice(cur, page) {
    const text = String(cur.notice || "");
    if (!page || page.isClosed() || !isScreen(page) || noticeSaid.get(page) === text) return;
    noticeSaid.set(page, text);
    inScreen(page, (t) => window.pbScreen?.notice?.(t) === true, text).then((ok) => { if (!ok) noticeSaid.delete(page); }, () => noticeSaid.delete(page));
  }
  function setNotice(cur, text) {
    cur.notice = String(text || "");
    for (const page of cur.pages.values()) showNotice(cur, page);
  }

  // Shared browser mode, each round: a picture page that was sent somewhere else (an address typed
  // in its address bar: that already went to the host as the tab's new address) shows the picture
  // again; the tab in sight gets its direct connection (offer from the host, answer from the
  // page); one that can't connect directly moves to the slower route (pictures and input through
  // the join channel); one out of sight for a while lets its connection go.
  // tell(id, page): passes on a picture page's new address before it shows the picture again (it
  // can arrive after this round read the addresses, and would then never reach the host).
  async function screensRound(cur, tell = () => {}) {
    const now = Date.now();
    for (const [id, page] of cur.pages) {
      if (page.isClosed()) continue;
      if (!isScreen(page)) {
        if (/^https?:/.test(page.url())) { tell(id, page); cur.screens.delete(page); cur.titles.delete(id); if (cur.who.has(id)) cur.who.get(id).sig = ""; presence?.helperGoes?.(page, screenUrl(id)); await page.goto(screenUrl(id), { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {}); }
        continue;
      }
      const st = await within(800, inScreen(page, () => window.pbScreen?.state() || null).catch(() => null));
      if (!st) continue;
      showInfo(cur, id);
      showWho(cur, id);
      showNotice(cur, page);
      // One record per document: a picture page reloaded (or sent somewhere and back) starts afresh,
      // and the connection asked for the one before it is let go (the slower route, once found, stays).
      let sc = cur.screens.get(page), was = null;
      if (sc && sc.doc !== st.doc) { if (sc.peer) cur.join.screen({ op: "stop", peer: sc.peer }).catch(() => {}); was = sc; sc = null; }
      if (!sc) { sc = { doc: st.doc, peer: null, conn: "none", since: now, tries: was?.tries || 0, fallback: !!was?.fallback, framesOn: !!was?.framesOn, hiddenSince: 0, busy: false, rounds: 0, linkSaid: "" }; cur.screens.set(page, sc); }
      sc.rounds++;
      if (st.conn !== sc.conn) { sc.conn = st.conn; sc.since = now; }
      sc.hiddenSince = st.visible ? 0 : sc.hiddenSince || now;
      if (st.visible) sc.seenAt = now; // the last one looked at, for this side's agents
      const outOfSight = sc.hiddenSince && now - sc.hiddenSince > SCREEN_KEEP_MS;
      // The browser's own picture page that can't make a direct connection here (no helper word
      // for it, or it runs as the extension's page would): the slower route at once, without
      // two tries of SCREEN_CONNECT_MS first. Asked from its second round (the word comes async);
      // an offer asked for meanwhile is let go.
      // A strict proxied session here: pictures through the join channel only, and a direct
      // connection asked for before it became strict is let go (C11).
      if (!sc.fallback && strictNow()) {
        sc.fallback = true;
        if (sc.peer) { cur.join.screen({ op: "stop", peer: sc.peer }).catch(() => {}); sc.peer = null; }
        await inScreen(page, () => window.pbScreen?.close()).catch(() => {});
        log("shared browser: this session's strict proxy keeps direct connections off; using the slower route");
        startScreenInput(cur);
      }
      const ownPage = !!context.browserPages?.();
      if (!sc.fallback && ownPage && sc.rounds >= 2 && st.conn !== "connected" && (st.host === "extension" || st.helper === false)) {
        sc.fallback = true;
        if (sc.peer) { cur.join.screen({ op: "stop", peer: sc.peer }).catch(() => {}); sc.peer = null; await inScreen(page, () => window.pbScreen?.close()).catch(() => {}); }
        log("shared browser: this picture page can't connect directly; using the slower route");
        startScreenInput(cur);
      }
      if (sc.fallback) {
        sayLink(cur, page, sc);
        if (outOfSight && sc.framesOn) { sc.framesOn = false; cur.join.screen({ op: "frames", id, on: false }).catch(() => {}); }
        else if (st.visible && !sc.framesOn) { sc.framesOn = true; const r = await cur.join.screen({ op: "frames", id, on: true }); if (r?.error) sc.framesOn = false; }
        continue;
      }
      if (sc.busy) continue;
      if (st.conn === "connected") {
        if (outOfSight) { const peer = sc.peer; sc.peer = null; await inScreen(page, () => window.pbScreen?.close()).catch(() => {}); if (peer) cur.join.screen({ op: "stop", peer }).catch(() => {}); }
        continue;
      }
      const stuck = st.conn === "failed" || (st.conn === "connecting" && now - sc.since > SCREEN_CONNECT_MS) || (st.conn === "disconnected" && now - sc.since > 6000);
      if (stuck) {
        sc.tries++;
        if (sc.peer) cur.join.screen({ op: "stop", peer: sc.peer }).catch(() => {});
        sc.peer = null;
        await inScreen(page, () => window.pbScreen?.close()).catch(() => {});
        if (sc.tries >= 2) { sc.fallback = true; log("shared browser: no direct connection; using the slower route"); startScreenInput(cur); sayLink(cur, page, sc); continue; }
      }
      if (st.visible && (st.conn === "none" || stuck) && !(ownPage && sc.rounds < 2)) {
        sc.busy = true;
        sc.since = now;
        (async () => {
          try {
            const r = await cur.join.screen({ op: "want", id });
            // The host has nothing to capture a tab with (a PairBrowse build without its capture
            // page): its pictures come through the channel from now on, with no retries.
            if (r?.route === "frames") {
              if (cur.screens.get(page) === sc && !sc.fallback) {
                sc.fallback = true;
                log("shared browser: the host sends pictures through the join channel");
                startScreenInput(cur);
                sayLink(cur, page, sc);
              }
              return;
            }
            if (!r?.sdp) { log("shared browser", r?.error || "no offer"); return; }
            // The page went somewhere else while the host made the offer (an address typed in its
            // bar): its new document asks for its own; this one is let go, never offered to it.
            const stale = () => { cur.join.screen({ op: "stop", peer: r.peer }).catch(() => {}); };
            if (cur.screens.get(page) !== sc || page.isClosed() || sc.fallback) return stale();
            sc.peer = r.peer;
            // Tests only (PAIRBROWSE_TEST_NO_DIRECT=1): a network where no direct connection can be made.
            const answer = await inScreen(page, (o) => window.pbScreen?.offer(o) ?? null, { sdp: r.sdp, peer: r.peer, doc: sc.doc, noDirect: testOn("NO_DIRECT") }, OFFER_MS);
            if (!answer) { if (sc.peer === r.peer) sc.peer = null; return stale(); }
            const a = await cur.join.screen({ op: "answer", peer: r.peer, sdp: answer });
            if (a?.error) log("shared browser", a.error);
          } catch (e) {
            log("shared browser", e?.message || e);
          } finally {
            sc.busy = false;
          }
        })();
      }
    }
  }

  // The slower route: the join channel's state ("up" or "down"), said to a picture page when it
  // changed. On that route the host sends a picture only when its page changes, so the page's wait
  // ("Reconnecting to …") follows this word, never a quiet spell. Said again next round if the
  // page didn't take it (still loading).
  function sayLink(cur, page, sc) {
    const want = cur.join?.linked ? "up" : "down";
    if (sc.linkSaid === want || page.isClosed()) return;
    sc.linkSaid = want;
    const unsaid = () => { if (sc.linkSaid === want) sc.linkSaid = ""; };
    // A page without link() (a build's page from before it): said once, not again each round.
    within(800, inScreen(page, (v) => (window.pbScreen ? (typeof window.pbScreen.link === "function" ? window.pbScreen.link(v) === true : "none") : false), want)).then((ok) => { if (!ok) unsaid(); }, unsaid);
  }

  // The slower route's input: what the person does on a picture page goes to the host every few
  // tens of milliseconds (the direct connection carries it when there is one).
  function startScreenInput(cur) {
    if (cur.inputTimer) return;
    let busy = false;
    cur.inputTimer = setInterval(async () => {
      if (live.cur !== cur) { clearInterval(cur.inputTimer); cur.inputTimer = null; return; }
      if (busy) return;
      busy = true;
      try {
        for (const [id, page] of cur.pages) {
          if (page.isClosed() || !cur.screens.get(page)?.fallback) continue;
          const events = await within(500, inScreen(page, () => window.pbScreen?.takeInput() || []).catch(() => []));
          if (Array.isArray(events) && events.length && cur.join.role === "drive") await cur.join.screen({ op: "input", id, events });
        }
      } finally {
        busy = false;
      }
    }, SCREEN_INPUT_MS);
  }

  // From the host on the join channel: a picture of a tab (the slower route), a connection's state,
  // or a file dialog your click opened there: you pick the files here, they're sent over and go
  // into that field.
  function onScreen(data, cur) {
    if (live.cur !== cur || !data) return;
    if (data.op === "pick" && typeof data.token === "string") {
      const page = cur.pages.get(data.id);
      if (!page || page.isClosed() || cur.join.role !== "drive") return;
      (async () => {
        const picked = await inScreen(page, (o) => window.pbScreen?.pick(o), { multiple: !!data.multiple }, PICK_MS).catch(() => null);
        log(`shared browser: ${Array.isArray(picked) ? picked.length : 0} file(s) picked for the host's page`);
        if (!Array.isArray(picked) || !picked.length) return;
        const files = [];
        for (const f of picked.slice(0, PICK_FILES_MAX)) {
          const bytes = Buffer.from(String(f.b64 || ""), "base64");
          const token = randomBytes(8).toString("hex");
          const parts = Math.max(1, Math.ceil(bytes.length / FILE_PART));
          for (let part = 0; part < parts; part++) {
            const r = await cur.join.file({ token, name: String(f.name || "file"), part, data: bytes.subarray(part * FILE_PART, (part + 1) * FILE_PART).toString("base64"), last: part === parts - 1 });
            if (r?.error || r?.problem) { log("shared browser file", r.error || r.problem); return; }
            if (part === parts - 1) files.push(r.path);
          }
        }
        const r = await cur.join.screen({ op: "picked", token: data.token, files });
        log(r?.error ? `shared browser file: ${r.error}` : `shared browser: ${files.length} file(s) put into the host's page`);
      })().catch((e) => log("shared browser file", e?.message || e));
      return;
    }
    if (data.op === "frame" && typeof data.img === "string") {
      const page = cur.pages.get(data.id);
      if (!page || page.isClosed()) return;
      const sc = cur.screens.get(page);
      if (!sc) return;
      // Only the newest picture counts: one waiting replaces the one before.
      sc.nextFrame = data.img;
      if (sc.drawing) return;
      sc.drawing = true;
      (async () => {
        while (sc.nextFrame && live.cur === cur) {
          const img = sc.nextFrame;
          sc.nextFrame = null;
          await inScreen(page, (b) => window.pbScreen?.frame(b), img).catch(() => {});
        }
        sc.drawing = false;
      })();
    }
  }

  return { screenBase, screenUrl, isScreen, showInfo, showWho, screensRound, sayLink, startScreenInput, onScreen, setNotice };
}
