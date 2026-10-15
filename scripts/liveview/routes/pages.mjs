// The routes the browser's own pages use on the owner's port (the owner only): the session's
// activity log, the docks' layout, Settings (config) and Report a problem, the Page tab's outline,
// the tab strip's lists and its report of every window's tabs, and the capture page's replies.
// startLiveView (liveview.mjs) mounts them.
import { json, plain, readJsonBody, readCapped, parseJson, BODY_MAX, SECURITY_HEADERS } from "../http.mjs";
import { readLayout, readDockTab } from "../layout.mjs";
import { REPORT_BODY_MAX } from "../report.mjs";
import { readPageQuery } from "../../daemon/activitylog.mjs";
import { hostOf } from "../tabs.mjs";

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

// history: the activity log. layoutNow(), layouts, sessionName(): the docks' layout per session.
// broadcast(event, data). settings, reporter, outlines, capture: the helper's parts, or null.
// webPages(pages), getContext(), idOf(page), mask(text), watchPages(), tabsStrip(), agentTabs():
// the live view's tab lists. tabOrder: { sig, order }, the strip's last report (set here).
// captureOk(req, byPages): the capture page's own key.
export function createPagesRoutes({ history, layoutNow, layouts, sessionName, broadcast, settings, reporter, outlines, webPages, getContext, idOf, mask, watchPages, tabsStrip, agentTabs, tabOrder, capture, captureOk }) {
  return [
    // The session's activity log, newest first, a page at a time (the Activity page's history; the
    // activity event has the latest 30): ?before=<epoch ms> (lines strictly older) &limit=<1..200>
    // -> { items, more, kept: { lines, days, saved } }. The owner's alone (either owner key).
    { method: "GET", path: "activity.json", right: "activity", handler: ({ req, res, rest }) => {
      if (rest.length) return plain(res, 404);
      const q = readPageQuery(new URL(req.url, "http://x").searchParams);
      if (q.error) return json(res, 400, { error: q.error });
      json(res, 200, history.page(q));
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
      layouts.set(sessionName(), next);
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
    // The tab strip's report of every window's tabs by CDP target (the browser's own pages): kept
    // for the helper's tab order (daemon/taborder.mjs), the last one only.
    { method: "POST", path: "tab-order", right: "strip", handler: async ({ req, res }) => {
      const body = await readCapped(req, res, BODY_MAX.tabOrder);
      if (body === null) return;
      const order = readTabOrder(parseJson(body));
      if (!order) return json(res, 400, { error: "Not a tab order." });
      const sig = JSON.stringify(order);
      if (sig !== tabOrder.sig) Object.assign(tabOrder, { sig, order });
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
  ];
}
