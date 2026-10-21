// The viewer's routes on the owner's port (your own link, the side panel, invite links): the page
// and its files, the event stream, a still (thumb.jpg) and a summary (state.json) for panes that
// can't hold a stream, a person's input and tab changes, and Pause. startLiveView mounts them.
import { hiddenFromLiveView } from "../../../ui/urls.js";
import { PAGE_KINDS as PAGE_KIND_LIST } from "../../../ui/vocab.js";
import { serveViewer, serveAsset, json, plain, sse, readJsonBody, NOT_JSON, BODY_MAX, SECURITY_HEADERS } from "../http.mjs";
import { withoutIcons } from "../tabs.mjs";
import { publicCsp } from "../public-turn.mjs";

const THUMB_QUALITY = { min: 20, max: 80, default: 50 };
const STATE_ACTIVITY = 4; // activity lines in state.json
// The browser's own pages that open an events stream with ?page=<kind> (the owner's key only): a
// name for counting them, nothing more; they get no frame stream.
const PAGE_KINDS = new Set(PAGE_KIND_LIST);

// lv: the live view's state and parts (liveview.mjs), read as each request comes: its streams
// (clients, viewers, owners, kinds, linkGuests), shown, lastFrame, lastFrameFrom, status,
// sessionInfo, devState, board, driving, activity; and captureOk, clickApprovals,
// collaborationChanged, stopIfIdle, follow, tabsInfo, forGuest, ownerSession, collaborationNow,
// approvals, joinHost, layoutNow, watchPages, agentTabs, pauseState, recordState, personTab,
// getContext, currentUrl, humanPost, onPause; turn: the hand-off grant gate (liveview/grants.mjs),
// for a hand-off's guest (role turn: its one stream, its own tabs' pictures as they are; role
// redeem: the landing page alone).
export function createViewerRoutes(lv) {
  async function events({ req, res, invite, byPages }) {
    // ?panel: status, activity and profile only (the PairBrowse side panel): no page stream.
    // ?page=<kind>: one of the browser's own pages, with the owner's key (a guest's is ignored):
    // no page stream either. The capture page's stream: the pages' key and its own (captureOk).
    const q = new URL(req.url, "http://x").searchParams;
    const kind = !invite && PAGE_KINDS.has(q.get("page")) ? q.get("page") : null;
    if (kind === "capture" && !lv.captureOk(req, byPages)) return plain(res, 403);
    // A hand-off's view key holds one stream at a time (a dropped one may come back).
    const turn = invite?.role === "turn";
    if (turn && !lv.turn.openStream(res, invite)) return json(res, 409, { error: "This hand-off is open somewhere else. Close it there, or wait a moment and try again." });
    if (turn) await lv.turn.watch();
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
    const viewer = !q.has("panel") && !kind;
    lv.clients.add(res);
    if (viewer) lv.viewers.add(res);
    if (kind) lv.kinds.set(res, kind);
    if (invite) {
      lv.linkGuests.set(res, invite);
      lv.clickApprovals?.cover?.(); // an approval card in the page comes down at once
    } else lv.owners.add(res);
    if (invite) lv.collaborationChanged();
    req.on("close", () => {
      lv.clients.delete(res);
      lv.viewers.delete(res);
      lv.owners.delete(res);
      lv.kinds.delete(res);
      if (lv.linkGuests.delete(res)) lv.collaborationChanged();
      lv.stopIfIdle();
    });
    if (viewer) await lv.follow();
    const tabs = await lv.tabsInfo();
    res.write(sse("tabs", invite ? lv.forGuest("tabs", tabs, invite) : tabs));
    res.write(sse("status", lv.status));
    res.write(sse("session", invite ? lv.forGuest("session") : lv.ownerSession()));
    res.write(sse("collaboration", lv.collaborationNow()));
    res.write(sse("activity", invite ? lv.forGuest("activity", lv.activity, invite) : lv.activity));
    if (!invite) res.write(sse("join", lv.approvals.open()));
    if (!invite && lv.devState) res.write(sse("dev", lv.devState));
    if (!invite && lv.joinHost) res.write(sse("joinhost", lv.joinHost.state()));
    if (!invite && lv.board) res.write(sse("board", lv.board));
    if (!invite) res.write(sse("layout", lv.layoutNow()));
    if (kind) { lv.watchPages(); res.write(sse("agent-tabs", await lv.agentTabs())); }
    if (!invite && lv.clickApprovals?.pending().length) res.write(sse("driving", { on: lv.driving }));
    const paused = lv.pauseState();
    if (paused) res.write(sse("pause", invite ? lv.forGuest("pause", paused) : paused));
    if (!invite && lv.recordState()) res.write(sse("record", lv.recordState()));
    if (viewer && lv.lastFrame && !invite) res.write(sse("frame", lv.lastFrame));
    // A hand-off's first picture: its own tab's, as it is; then its turn event.
    if (turn) {
      const f = viewer ? lv.turn.frameFor(invite) : null;
      if (f && !lv.personTab(lv.lastFrameFrom)) res.write(sse("frame", f));
      return lv.turn.started(res, invite);
    }
    // A guest's first picture with card fields covered (covers.mjs), or none.
    if (viewer && lv.lastFrame && invite && !lv.personTab(lv.lastFrameFrom)) {
      const from = lv.lastFrameFrom;
      const f = await lv.coverFrame(lv.lastFrame, from);
      if (f && !res.destroyed && lv.lastFrameFrom === from) res.write(sse("frame", f));
    }
  }

  // A still of the tab on screen. With viewers it comes from the shown tab's session; without,
  // from a session of its own, let go at once: a thumbnail polled by a pane never starts (or
  // leaves running) the screencast that only viewers need.
  async function thumb({ req, res, invite }) {
    const q = Number(new URL(req.url, "http://x").searchParams.get("q")) || THUMB_QUALITY.default;
    const quality = Math.min(THUMB_QUALITY.max, Math.max(THUMB_QUALITY.min, q));
    // What's on screen, unscaled: a clip or scale makes the engine re-lay out the page (it flickers).
    const still = (cdp) => cdp.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true, captureBeyondViewport: false });
    let data, from;
    const shown = lv.shown;
    if (invite && lv.personTab(shown?.page)) return plain(res, 404); // a person's own tab: never to guests
    // A hand-off's still: only of its own tabs, as they are (the person sees the field they type into).
    const turn = invite?.role === "turn";
    const turnPage = turn ? lv.turn.stillOf(invite) : null;
    if (turn && !turnPage) return json(res, 409, { error: "That tab isn't on screen. Go back to the hand-off's tab." });
    if (shown && (!turn || shown.page === turnPage)) { ({ data } = await still(shown.cdp)); from = shown.page; }
    else if (turn) {
      const cdp = await turnPage.context().newCDPSession(turnPage);
      try { ({ data } = await still(cdp)); } finally { cdp.detach().catch(() => {}); }
      from = turnPage;
    } else {
      const ctx = await lv.getContext();
      const url = await lv.currentUrl();
      if (hiddenFromLiveView(url)) return plain(res, 404); // never the browser's own pages
      const web = ctx.pages().filter((p) => !hiddenFromLiveView(p.url()));
      const page = web.find((p) => p.url() === url && !(invite && lv.personTab(p))) || web.filter((p) => !lv.personTab(p)).at(-1);
      if (!page) return plain(res, 404);
      const cdp = await page.context().newCDPSession(page);
      try { ({ data } = await still(cdp)); } finally { cdp.detach().catch(() => {}); }
      from = page;
    }
    // A guest's still with card fields covered (covers.mjs); none when they can't be.
    if (invite && !turn) {
      data = await lv.coverImage(from, data);
      if (!data) return plain(res, 503);
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/jpeg" });
    res.end(Buffer.from(data, "base64"));
  }

  async function human({ req, res, route, role, invite }) {
    const ev = await readJsonBody(req, res, BODY_MAX.input);
    if (ev === undefined) return;
    if (ev === null || typeof ev !== "object") return json(res, 400, { error: NOT_JSON });
    // Moving tabs around the strip is the owner's (a drive guest switches, opens and closes them).
    if (route === "tab" && ev?.order !== undefined && role !== "owner") return plain(res, 403);
    // A hand-off's batch that came already (sent again after a lost answer): answered, not replayed;
    // one still being replayed: busy, sent again in a moment. It counts once replayed.
    const batch = role === "turn" && route === "input" ? lv.turn.batchOf(invite, req) : null;
    if (batch?.repeat) { res.writeHead(204, SECURITY_HEADERS); return res.end(); }
    if (batch?.busy) return json(res, 503, { error: "The last batch is still being typed. Wait a moment and send it again." });
    // A hand-off's input reaches only its own tabs: another one on screen is refused, said and audited.
    if (role === "turn" && !lv.turn.onScreen(invite)) { batch?.end(false); lv.turn.refused(invite, "input-refused", "out-of-scope"); return json(res, 409, { error: "That tab isn't on screen. Go back to the hand-off's tab." }); }
    try { await lv.humanPost(route, ev, role, invite ? `${invite.label} (by hand)` : null, invite?.id || null); } catch (e) { batch?.end(false); throw e; }
    batch?.end(true);
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
  }

  return [
    // The page; a hand-off link before its tap (role redeem) gets its landing page instead. On a
    // hand-off's public address (pub: its host, liveview/public-turn.mjs) the stream is a WebSocket.
    { method: "GET", path: "", right: "page", handler: ({ req, res, role, invite, pub }) => (role === "redeem" ? lv.turn.landing(req, res, invite)
      : pub ? serveViewer(req, res, { role, stream: "ws" }, { csp: publicCsp(pub) }) : serveViewer(req, res, { role })) },
    { method: "GET", path: "assets", right: "page", handler: ({ res, rest }) => serveAsset(res, rest) },
    { method: "GET", path: "events", right: "events", handler: events },
    // A small still of the page and a status summary, for panes that can't hold a live stream
    // (the Claude app's plugin panes). Same key, same checks.
    { method: "GET", path: "thumb.jpg", right: "thumb", handler: thumb },
    { method: "GET", path: "state.json", right: "state", handler: async ({ res, invite }) => {
      if (invite?.role === "turn") await lv.turn.watch(); // tabs it opens join its scope
      const tabs = withoutIcons(await lv.tabsInfo());
      const recent = lv.activity.slice(-STATE_ACTIVITY);
      const lastFrame = lv.lastFrame;
      json(res, 200, { status: lv.status, session: lv.sessionInfo, collaboration: lv.collaborationNow(), tabs: invite ? lv.forGuest("tabs", tabs, invite) : tabs, activity: invite ? lv.forGuest("activity", recent, invite) : recent, frame: lastFrame ? { w: lastFrame.w, h: lastFrame.h } : null });
    } },
    { method: "POST", path: "input", right: "input", handler: human },
    { method: "POST", path: "tab", right: "tab", handler: human },
    // "Pause agents" and "Resume" (the side panel, a drive guest's viewer): people only, anyone
    // who may drive. who: the guest's name (null: the owner). With `who` in the body: "Pause this
    // agent" / "Resume this agent" for the agent of that name, the owner's only. Never a hand-off's.
    { method: "POST", path: "pause", right: "input", handler: async ({ req, res, invite, role }) => {
      if (role === "turn") return plain(res, 403);
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (op && typeof op === "object" && op.who !== undefined) {
        if (role !== "owner") return plain(res, 403);
        if (typeof op.who !== "string" || !op.who.trim() || op.who.length > 80) return json(res, 409, { error: "who is an agent's name as the session list shows it." });
        const r = lv.onPause(op.paused === true, null, op.who) || {};
        return json(res, r.problem ? 409 : 200, r);
      }
      const r = lv.onPause(op?.paused === true, invite ? invite.label : null) || {};
      json(res, r.problem ? 409 : 200, r);
    } },
  ];
}
