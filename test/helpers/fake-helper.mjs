// The pages' harness fake helper: the live view's owner routes and event stream, answered the way
// scripts/liveview.mjs answers them (its request dispatch, liveview.mjs 718-734 on this branch,
// and the browser pages' routes from the helper lane: layout, tabs, agent-tabs, timeline,
// ?page=<kind>), with the real checks from scripts/liveview/http.mjs: a Host that is not a
// loopback name is 403, an unknown key 404, a non-GET from a foreign Origin 403, an unknown route
// 404. It adds the CORS headers the helper gives the browser's own pages' origin (pageOrigin)
// and records every POST. Only the owner's key exists here, so no right is ever missing.
// Click approvals follow approve.js's data contract (its header): GET approvals.json gives the
// pending list (null fixture: 404, none pending), kept in step with the `approval` events pushed;
// POST approve { id, answer } is 400 for a malformed answer, 404 once the id is gone, else
// 200 { ok: true } and a withdraw event, as lane H's approvals.mjs end() sends. No timers.
// POST session { op: "save" | "rename", name } mirrors the contract the lead fixed for lane H (not
// yet in liveview.mjs): save is 200 { ok, savedAt }, rename 200 { ok, name } and a session event,
// anything else 400 { error }. Every GET route is recorded in `gets`, in order.
// POST layout relays `tab` as lane H's liveview/layout.mjs readDockTab does: a tab outside agent,
// page, pictures and tools is 409; one asked for goes out in that answer and its layout event only,
// never kept in fx.layout or layout.json.
// The Tools tab's routes (TOOLS-CONTRACT.md): GET handoffs.json, downloads.json, recordings.json
// and diagnostics.json (a null fixture: 404, a helper without the route); POST
// downloads/<id>/open|reveal, recordings/<id>/open|reveal and handoffs/<id>/show (404 { ok: false }
// for an id not in the fixture's items, another path shape plain 404, else 200 { ok: true });
// POST diagnostics/report answers the `report` fixture ({ text }); DELETE recordings/<id> drops
// the item and is recorded in `deletes` ({ route, rest }), 404 once it is gone; no event for it
// (the contract has none). The `downloads` and `handoffs` events are deltas the test pushes; none
// is in the initial burst. Readings of the contract's open points, for the lead to reconcile with
// lane H: size is in bytes; at is epoch ms (an ISO string is accepted too); duration and uptime
// are in seconds; an id is a string or number matching /^[A-Za-z0-9_-]{1,64}$/ (the page skips
// other items, and items whose state or kind is outside the contract's set).
import http from "node:http";
import { randomBytes } from "node:crypto";
import { hostOk, originOk, keyOk, pathParts, readBody, BODY_MAX, SECURITY_HEADERS, plain, listen } from "../../scripts/liveview/http.mjs";

const NOT_JSON = "The body is not JSON.";
const PAGE_KINDS = new Set(["strip", "left", "right", "timeline", "picker", "approve", "screen", "capture"]);
const LAYOUT_STATES = new Set(["open", "rail", "hidden"]);
const STRIP_MIN = 44, STRIP_MAX = 176;
const TIMELINE_ID = /^[0-9a-f]{12}$/;
const ANSWERS = new Set(["allow", "deny", "site", "terminal"]);
const BAD_ANSWER = "An approval answer is { id, answer: allow, deny, terminal or site }.";
const DOCK_TABS = new Set(["agent", "page", "pictures", "tools"]);
// The Tools tab's POST paths: route -> the actions after the item's id.
const TOOL_ACTS = { downloads: new Set(["open", "reveal"]), recordings: new Set(["open", "reveal"]), handoffs: new Set(["show"]) };

export const defaultFixtures = () => ({
  status: { text: "", kind: "clear" },
  session: { name: "", where: "Local" },
  collaboration: { participants: [], owner: null, active: null, guests: [] },
  activity: [],
  join: [],
  tabs: [],
  layout: { left: "open", right: "open", strip: 88 },
  agentTabs: [],
  journal: null,
  profile: { details: [], secrets: [] },
  sessions: { picking: true, sessions: [] },
  joins: [],
  timeline: { cards: [] },
  pictures: {},
  dev: null,
  joinhost: null,
  board: null,
  pause: null,
  record: null,
  approvals: { pending: [] },
  handoffs: { items: [] },
  downloads: { items: [] },
  recordings: { recording: { on: false, since: 0 }, items: [] },
  diagnostics: { helper: { version: "0.15.45", node: "22.11.0", uptime: 7500 }, browser: { engine: "pairbrowse", version: "142.0.7444.59", build: "3" },
    connections: { agents: 1, viewers: 0, joiners: 0, streams: 2 }, joined: [], errors: [] },
  report: { text: "PairBrowse diagnostics\nhelper 0.15.45\n" },
});

// The event each fixture goes out as (the names liveview.mjs broadcasts); null: none.
const EVENT = { status: "status", session: "session", collaboration: "collaboration", activity: "activity", join: "join", tabs: "tabs", layout: "layout",
  agentTabs: "agent-tabs", profile: "profile", dev: "dev", joinhost: "joinhost", board: "board", pause: "pause", record: "record", timeline: "timeline" };

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export function merge(base, over) {
  if (!plainObject(base) || !plainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

// given merged over base: a valid { left, right, strip }, or { error } (liveview.mjs readLayout).
function readLayout(given, base) {
  if (!plainObject(given)) return { error: "A layout is { left, right, strip }." };
  const next = { ...base };
  for (const side of ["left", "right"]) {
    if (given[side] === undefined) continue;
    if (!LAYOUT_STATES.has(given[side])) return { error: `${side} is "open", "rail" or "hidden".` };
    next[side] = given[side];
  }
  if (given.strip !== undefined) {
    if (!Number.isInteger(given.strip) || given.strip < STRIP_MIN || given.strip > STRIP_MAX) return { error: `strip is a whole number of pixels from ${STRIP_MIN} to ${STRIP_MAX}.` };
    next.strip = given.strip;
  }
  return next;
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
// undefined when the body is not JSON; an empty body is null (a route that takes none).
const parsed = (body) => { if (!body) return null; try { return JSON.parse(body); } catch { return undefined; } };

export async function startFakeHelper({ pageOrigin = null, fixtures = {}, replies = {} } = {}) {
  const key = randomBytes(32).toString("base64url");
  const fx = merge(defaultFixtures(), fixtures || {});
  const streams = new Set();
  const posts = [];
  const gets = [];
  const deletes = [];
  const allReplies = { ...replies };
  let origin = pageOrigin;

  const state = () => ({ status: fx.status, session: fx.session, collaboration: fx.collaboration, tabs: fx.tabs, activity: fx.activity.slice(-4), frame: null });
  const push = (event, data) => {
    // The pending click approvals follow what goes out on the stream.
    if (event === "approval" && fx.approvals && Array.isArray(fx.approvals.pending)) {
      const id = data?.item?.id;
      if (data?.op === "add" && data.item) fx.approvals.pending = [...fx.approvals.pending.filter((it) => it?.id !== id), data.item];
      else if (data?.op === "withdraw") fx.approvals.pending = fx.approvals.pending.filter((it) => it?.id !== id);
    }
    for (const s of streams) s.res.write(sse(event, data));
  };
  function set(name, data) {
    fx[name] = merge(fx[name], data);
    if (EVENT[name] && fx[name] !== null) push(EVENT[name], fx[name]);
    return fx[name];
  }

  function events(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    const q = new URL(req.url, "http://x").searchParams;
    const kind = PAGE_KINDS.has(q.get("page")) ? q.get("page") : null;
    const stream = { res, panel: q.has("panel"), kind };
    streams.add(stream);
    req.on("close", () => streams.delete(stream));
    res.write(": hi\n\n");
    res.write(sse("tabs", fx.tabs));
    res.write(sse("status", fx.status));
    res.write(sse("session", fx.session));
    res.write(sse("collaboration", fx.collaboration));
    res.write(sse("activity", fx.activity));
    res.write(sse("join", fx.join));
    if (fx.dev !== null) res.write(sse("dev", fx.dev));
    if (fx.joinhost !== null) res.write(sse("joinhost", fx.joinhost));
    if (fx.board !== null) res.write(sse("board", fx.board));
    res.write(sse("layout", fx.layout));
    if (kind) res.write(sse("agent-tabs", fx.agentTabs));
    if (fx.pause !== null) res.write(sse("pause", fx.pause));
    if (fx.record !== null) res.write(sse("record", fx.record));
  }

  const GETS = {
    "state.json": () => state(), "journal.json": () => fx.journal ?? null, "profile.json": () => fx.profile, "sessions.json": () => fx.sessions,
    "joins.json": () => fx.joins, "tabs.json": () => fx.tabs, "agent-tabs.json": () => fx.agentTabs, "timeline.json": () => fx.timeline, "layout.json": () => fx.layout,
    "approvals.json": () => fx.approvals,
    "handoffs.json": () => fx.handoffs, "downloads.json": () => fx.downloads, "recordings.json": () => fx.recordings, "diagnostics.json": () => fx.diagnostics,
  };
  const POSTS = new Set(["approve", "dev", "joinhost", "profile", "invite", "pick", "picker", "input", "tab", "record", "pause", "layout", "timeline", "session",
    "handoffs", "downloads", "recordings", "diagnostics"]);
  const hasItem = (name, id) => Array.isArray(fx[name]?.items) && fx[name].items.some((it) => it && String(it.id) === id);

  // The answer to a POST without a reply of the test's own.
  function defaultPost(route, body, rest = []) {
    if (route === "input" || route === "tab") return { status: 204 };
    if (TOOL_ACTS[route]) return hasItem(route, rest[0]) ? { status: 200, body: { ok: true } } : { status: 404, body: { ok: false } };
    if (route === "diagnostics") return fx.report === null ? { status: 404, body: { ok: false } } : { status: 200, body: fx.report };
    if (route === "invite") {
      if (typeof body?.name !== "string" || !body.name) return { status: 409, body: { error: "Not yet: ask the user what name the people they invite should see.", needName: true } };
      return { status: 200, body: { ok: true, id: "abcd1234", share: body.share, role: body.role, mode: "shared", code: "pb-join:FAKE", rights: "Shared browser: they can drive.", hint: "The person pastes it into their own PairBrowse." } };
    }
    if (route === "layout") {
      // tab: the right dock's tab to open on (liveview/layout.mjs readDockTab), relayed only.
      const tab = plainObject(body) ? body.tab : undefined;
      if (tab !== undefined && !DOCK_TABS.has(tab)) return { status: 409, body: { error: "tab is agent, page, pictures or tools." } };
      const next = readLayout(plainObject(body) ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "tab")) : body, fx.layout);
      if (next.error) return { status: 409, body: { error: next.error } };
      fx.layout = next;
      const out = tab ? { ...next, tab } : next;
      push("layout", out);
      return { status: 200, body: out };
    }
    if (route === "pause") return { status: 200, body: { paused: !!body?.paused, can: true } };
    if (route === "session") {
      if (body?.op === "save") return { status: 200, body: { ok: true, savedAt: new Date().toISOString() } };
      if (body?.op === "rename" && typeof body.name === "string" && body.name.trim() && body.name.length <= 60) {
        fx.session = { ...fx.session, name: body.name };
        push("session", fx.session);
        return { status: 200, body: { ok: true, name: body.name } };
      }
      return { status: 400, body: { error: "A session request is { op: save } or { op: rename, name }." } };
    }
    if (route === "record") return { status: 200, body: { recording: body?.on === true, since: Date.now() } };
    if (route === "approve" && typeof body?.answer === "string") {
      // A click approval (approve.js's contract); bodies without `answer` (join, removal) as before.
      if (typeof body.id !== "string" || !body.id || !ANSWERS.has(body.answer)) return { status: 400, body: { error: BAD_ANSWER } };
      if (!fx.approvals?.pending?.some((it) => it?.id === body.id)) return { status: 404, body: { ok: false } };
      push("approval", { op: "withdraw", item: { id: body.id } });
      return { status: 200, body: { ok: true } };
    }
    if (route === "approve") return { status: 200, body: { ok: true } };
    return { status: 200, body: {} };
  }

  async function post(req, res, route, rest) {
    const max = route === "profile" ? BODY_MAX.profile : route === "input" || route === "tab" ? BODY_MAX.input : BODY_MAX.approve;
    const raw = await readBody(req, max);
    if (raw === null) return plain(res, 413);
    const body = parsed(raw);
    if (body === undefined) return json(res, 400, { error: NOT_JSON });
    posts.push({ route, rest, body });
    const reply = Object.prototype.hasOwnProperty.call(allReplies, route) ? allReplies[route] : undefined;
    const r = typeof reply === "function" ? (await reply(body, rest)) || { status: 200, body: {} } : reply !== undefined ? { status: 200, body: reply } : defaultPost(route, body, rest);
    if (r.status === 204 || r.body === undefined) { res.writeHead(r.status || 204); return res.end(); }
    json(res, r.status || 200, r.body);
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE");
    }
    if (!hostOk(req.headers.host)) return plain(res, 403);
    const { key: given, route, rest } = pathParts(req);
    if (!keyOk(given, key)) return plain(res, 404);
    const from = req.headers.origin;
    if (req.method !== "GET" && !originOk(from) && !(origin && from === origin)) return plain(res, 403);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    try {
      if (req.method === "GET") {
        gets.push(route);
        if (route === "events") return events(req, res);
        if (Object.prototype.hasOwnProperty.call(GETS, route) && !rest.length) {
          const value = GETS[route]();
          if (value === null && route !== "journal.json") return plain(res, 404);
          return json(res, 200, value);
        }
        if (route === "timeline") {
          const m = rest.length === 1 ? /^([0-9a-f]{12})\.jpg$/.exec(rest[0]) : null;
          const picture = m ? fx.pictures[m[1]] : null;
          if (!picture) return plain(res, 404);
          res.writeHead(200, { "content-type": "image/jpeg" });
          return res.end(Buffer.isBuffer(picture) ? picture : Buffer.from(String(picture), "base64"));
        }
        return plain(res, 404);
      }
      if (req.method === "POST" && POSTS.has(route)) {
        if (route === "timeline" && !(rest.length === 1 && rest[0] === "note") && !(rest.length === 2 && TIMELINE_ID.test(rest[0]) && rest[1] === "pin")) return plain(res, 404);
        if (TOOL_ACTS[route] && !(rest.length === 2 && rest[0] && TOOL_ACTS[route].has(rest[1]))) return plain(res, 404);
        if (route === "diagnostics" && !(rest.length === 1 && rest[0] === "report")) return plain(res, 404);
        return await post(req, res, route, rest);
      }
      if (req.method === "DELETE" && route === "timeline") {
        const cards = fx.timeline?.cards || [];
        const card = rest.length === 1 ? cards.find((c) => c.id === rest[0]) : null;
        if (!card) return plain(res, 404);
        fx.timeline = { ...fx.timeline, cards: cards.filter((c) => c !== card) };
        push("timeline", { op: "remove", card });
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && route === "recordings") {
        const items = Array.isArray(fx.recordings?.items) ? fx.recordings.items : null;
        const item = items && rest.length === 1 ? items.find((it) => it && String(it.id) === rest[0]) : null;
        if (!item) return plain(res, 404);
        fx.recordings = { ...fx.recordings, items: items.filter((it) => it !== item) };
        deletes.push({ route, rest });
        return json(res, 200, { ok: true });
      }
      return plain(res, 404);
    } catch {
      if (!res.headersSent) plain(res, 500);
    }
  });
  await listen(server, 0);
  const helperOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin: helperOrigin,
    key,
    base: `${helperOrigin}/${key}/`,
    fixtures: fx,
    push,
    set,
    posts,
    gets,
    deletes,
    streams,
    replies: allReplies,
    setPageOrigin: (o) => { origin = o; },
    get pageOrigin() { return origin; },
    close: () => new Promise((resolve) => {
      for (const s of streams) s.res.destroy();
      streams.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
