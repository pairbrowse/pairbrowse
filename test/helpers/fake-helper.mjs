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
// downloads/<id>/open|open-app|reveal, recordings/<id>/open|reveal and handoffs/<id>/show (404
// { ok: false } for an id not in the fixture's items, another path shape plain 404, else 200
// { ok: true }); a download's open and open-app, in this order: 409 { error: UNMARKED } for an
// item with `marked: false`, 410 { error: FILE_CHANGED } for one with `gone: true`; then open: 428
// { confirm: item.confirm || CONFIRM_PROGRAM } for one with `program: true` until the body is
// { confirm: true }, else 200 { ok: true } plus `opened: item.opens` when the fixture sets `opens`;
// open-app: 409 { error: NO_APP } for one with `app: false`, else 200 { ok: true, opened: "app" };
// POST diagnostics/report answers the `report` fixture ({ text }); DELETE recordings/<id> drops
// the item and is recorded in `deletes` ({ route, rest }), 404 once it is gone; no event for it
// (the contract has none). The `downloads` and `handoffs` events are deltas the test pushes; none
// is in the initial burst. Readings of the contract's open points, for the lead to reconcile with
// lane H: size is in bytes; at is epoch ms (an ISO string is accepted too); duration and uptime
// are in seconds; an id is a string or number matching /^[A-Za-z0-9_-]{1,64}$/ (the page skips
// other items, and items whose state or kind is outside the contract's set).
// The routes of the helper lane's 19c2dc0 (daemon/pick.mjs, liveview/settings.mjs, liveview.mjs):
// POST pick { action: "use", name, confirm? } | { action: "new", confirm? } | { action: "join",
// code, joinName? } | { action: "delete", name }, each with only its own fields (else 409 { text,
// error: true }); with a session open and agents at work (the `agents` fixture: names) use and new
// answer 428 { text, error: true, confirm, agents } until the body has confirm: true; delete
// refuses the open session and "default" (409) and drops the row; every change pushes `sessions`
// (the sessions fixture). GET config.json / POST config: the fields settings.mjs reads and takes
// (name, downloads, pictures, cookies, maxTabs, askSession besides browser, timeline, layout; a
// downloads path with "missing" in it isn't a folder). GET invites.json { items: [{ id, role,
// label, share, expires }] } and POST invite { op: "revoke", id } (8-hex id: 200 { ok, id } and an
// `invites` event, 404 for an id not out, 409 for any other body with an op).
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
// The helper's own sentences for a download's Open (scripts/liveview.mjs).
export const UNMARKED = "This file lost the download mark macOS uses to protect you; show it in Finder instead.";
export const CONFIRM_PROGRAM = "This is a program or script. Open it anyway?";
// To reconcile with lane H's wording at G2: a web page's confirm and open-app's refusal.
export const CONFIRM_WEB = "This is a web page saved to your computer. It can run scripts when opened. Open it anyway?";
export const NO_APP = "No app on this computer opens this file.";
// As the helper's scripts/liveview.mjs says it (410).
export const FILE_CHANGED = "That file was moved, replaced or deleted since it was saved.";
const TOOL_ACTS = { downloads: new Set(["open", "open-app", "reveal"]), recordings: new Set(["open", "reveal"]), handoffs: new Set(["show"]) };

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
  // GET outline.json (the Page tab): { outline: null } or { outline: { tab, host, who, at, cut, text } }; null: 404.
  outline: { outline: null },
  handoffs: { items: [] },
  downloads: { items: [] },
  recordings: { recording: { on: false, since: 0 }, items: [] },
  diagnostics: { helper: { version: "0.15.45", node: "22.11.0", uptime: 7500 }, browser: { engine: "pairbrowse", version: "142.0.7444.59", build: "3" },
    connections: { agents: 1, viewers: 0, joiners: 0, streams: 2 }, joined: [], errors: [] },
  report: { text: "PairBrowse diagnostics\nhelper 0.15.45\n" },
  // GET config.json as liveview/settings.mjs answers it (null: 404, a helper without the route),
  // plus `report`: true when the helper relays problem reports (the follow-up route POST report;
  // not in liveview.mjs yet). running: the browser of the window open now (restart in the answer).
  config: { browser: "pairbrowse", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 },
    name: "", downloads: null, pictures: true, cookies: "accept", maxTabs: 20, askSession: true, native: true, chosen: true, report: false },
  // The agents at work in the browser now (their names): a switch asks first (428) while any are.
  agents: [],
  // GET invites.json: the invites out now, never a key, code or link (null: 404).
  invites: { items: [] },
  running: "pairbrowse",
  // POST report's answer while config.report is true: { status, body }.
  sent: { status: 200, body: { ok: true, id: "PB-1042" } },
});

// The event each fixture goes out as (the names liveview.mjs broadcasts); null: none.
const EVENT = { status: "status", session: "session", collaboration: "collaboration", activity: "activity", join: "join", tabs: "tabs", layout: "layout",
  agentTabs: "agent-tabs", config: "config", profile: "profile", dev: "dev", joinhost: "joinhost", board: "board", pause: "pause", record: "record", timeline: "timeline",
  sessions: "sessions", invites: "invites" };

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

// POST config checked as liveview/settings.mjs applySettings does: any subset of { browser,
// timeline: { on?, cap? }, layout: { left?, right?, strip? }, name, downloads, pictures, cookies,
// maxTabs, askSession }; anything else 409 { error }.
const SETTINGS_KEYS = ["browser", "timeline", "layout", "name", "downloads", "pictures", "cookies", "maxTabs", "askSession"];
function applyConfig(given, config) {
  if (!plainObject(given)) return { error: `Settings are { ${SETTINGS_KEYS.join(", ")} }.` };
  for (const k of Object.keys(given)) if (!SETTINGS_KEYS.includes(k)) return { error: `Unknown setting "${k}"` };
  const next = { ...config, timeline: { ...config.timeline }, layout: { ...config.layout } };
  if (given.name !== undefined) {
    const t = typeof given.name === "string" ? given.name.trim().replace(/\s+/g, " ") : null;
    if (t === null || t.length > 40 || /[<>"'`\u0000-\u001f\u007f]/.test(t)) return { error: 'name is up to 40 characters, without < > " \' ` or control characters ("" for none).' };
    next.name = t;
  }
  if (given.downloads !== undefined) {
    const d = given.downloads;
    if (d === null || d === "") next.downloads = null;
    else if (typeof d !== "string" || !d.startsWith("/") || d.length > 1024) return { error: "downloads is an absolute path to a folder, or null for your Downloads folder." };
    else if (d.includes("missing")) return { error: `${d} isn't a folder` };
    else if (d.includes("/.pairbrowse")) return { error: "Downloads can't go inside PairBrowse's own folder (~/.pairbrowse)." };
    else next.downloads = d;
  }
  if (given.pictures !== undefined) {
    if (typeof given.pictures !== "boolean") return { error: "pictures is true or false." };
    next.pictures = given.pictures;
  }
  if (given.cookies !== undefined) {
    if (given.cookies !== "accept" && given.cookies !== "reject") return { error: 'cookies is "accept" or "reject".' };
    next.cookies = given.cookies;
  }
  if (given.maxTabs !== undefined) {
    if (!Number.isInteger(given.maxTabs) || given.maxTabs < 2 || given.maxTabs > 50) return { error: "maxTabs is a whole number from 2 to 50." };
    next.maxTabs = given.maxTabs;
  }
  if (given.askSession !== undefined) {
    if (typeof given.askSession !== "boolean") return { error: "askSession is true or false." };
    next.askSession = given.askSession;
  }
  if (given.browser !== undefined) {
    const b = given.browser;
    if (b === "pairbrowse") { if (!config.native) return { error: "There's no PairBrowse browser build for this computer yet" }; }
    else if (b !== "chromium") {
      if (typeof b !== "string" || !b.startsWith("/") || b.length > 1024) return { error: 'browser is "pairbrowse", "chromium" or an absolute path.' };
      if (b.includes("missing")) return { error: `${b} isn't an executable file` };
    }
    next.browser = b;
    next.chosen = true;
  }
  if (given.timeline !== undefined) {
    const t = given.timeline;
    if (!plainObject(t)) return { error: "timeline is { on, cap }." };
    if (t.on !== undefined && typeof t.on !== "boolean") return { error: "timeline.on is true or false." };
    if (t.cap !== undefined && (!Number.isInteger(t.cap) || t.cap < 1 || t.cap > 200)) return { error: "timeline.cap is a whole number from 1 to 200." };
    Object.assign(next.timeline, t);
  }
  if (given.layout !== undefined) {
    const l = readLayout(given.layout, config.layout);
    if (l.error) return { error: l.error };
    next.layout = l;
  }
  return { config: next };
}

// POST pick as daemon/pick.mjs readPick and pick answer it (fx: the fixtures; push: the stream).
const PICK_KEYS = { use: ["action", "name", "confirm"], new: ["action", "confirm"], join: ["action", "code", "joinName"], delete: ["action", "name"] };
const PICK_SHAPE = 'A pick is { action: "use", name }, { action: "new" }, { action: "join", code, joinName } or { action: "delete", name }.';
const SESSION_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const listOf = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
function pickAnswer(body, fx, push) {
  const refuse = (text) => ({ status: 409, body: { text, error: true } });
  if (!plainObject(body) || !Object.hasOwn(PICK_KEYS, body.action)) return refuse(PICK_SHAPE);
  const extra = Object.keys(body).find((k) => !PICK_KEYS[body.action].includes(k));
  if (extra !== undefined) return refuse(`Unknown field "${extra}" for "${body.action}".`);
  if (PICK_KEYS[body.action].includes("name") && !SESSION_NAME.test(String(body.name ?? ""))) return refuse("name is a session's name (letters, numbers, - and _, up to 40).");
  if (body.confirm !== undefined && typeof body.confirm !== "boolean") return refuse("confirm is true or false.");
  const list = Array.isArray(fx.sessions?.sessions) ? fx.sessions.sessions : [];
  const open = list.find((s) => s?.current)?.name ?? null;
  const changed = () => { if (fx.sessions) push("sessions", fx.sessions); };
  if (body.action === "join") {
    if (typeof body.code !== "string" || !body.code.trim()) return refuse("code is the join code you were given (pb-join:...).");
    return { status: 200, body: { text: "Asked to join. They have to approve first." } };
  }
  if (body.action === "delete") {
    if (!list.some((s) => s?.name === body.name)) return refuse(`No session "${body.name}".`);
    if (body.name === open) return refuse("That session is in use. Switch to another one first.");
    if (body.name === "default") return refuse("The default session can't be deleted.");
    fx.sessions = { ...fx.sessions, sessions: list.filter((s) => s?.name !== body.name) };
    changed();
    return { status: 200, body: { text: `Deleted session "${body.name}" and its logins.` } };
  }
  const to = body.action === "new" ? "a fresh session" : `session "${body.name}"`;
  if (!fx.sessions?.picking) {
    if (body.action === "use" && body.name === open) return { status: 200, body: { text: `You're in session "${body.name}" already.` } };
    const agents = [...new Set(Array.isArray(fx.agents) ? fx.agents : [])];
    if (agents.length && body.confirm !== true) {
      const n = agents.length === 1 ? `${agents[0]} is` : `${listOf(agents)} are`;
      return { status: 428, body: { text: `${n} using the browser: switching closes its tabs for them.`, error: true, confirm: `${n} using the browser. Switching closes every tab for them. Switch anyway?`, agents } };
    }
  }
  changed();
  return { status: 200, body: { text: body.action === "new" ? "Starting a fresh session." : `Opening ${to}.` } };
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
    "approvals.json": () => fx.approvals, "config.json": () => fx.config, "outline.json": () => fx.outline,
    "handoffs.json": () => fx.handoffs, "downloads.json": () => fx.downloads, "recordings.json": () => fx.recordings, "diagnostics.json": () => fx.diagnostics,
    "invites.json": () => fx.invites,
  };
  const POSTS = new Set(["approve", "dev", "joinhost", "profile", "invite", "pick", "picker", "input", "tab", "record", "pause", "layout", "timeline", "session",
    "handoffs", "downloads", "recordings", "diagnostics", "tab-order", "config", "report"]);
  const hasItem = (name, id) => Array.isArray(fx[name]?.items) && fx[name].items.some((it) => it && String(it.id) === id);

  // The answer to a POST without a reply of the test's own.
  function defaultPost(route, body, rest = []) {
    if (route === "input" || route === "tab" || route === "tab-order") return { status: 204 };
    if (route === "downloads" && (rest[1] === "open" || rest[1] === "open-app") && rest.length === 2 && hasItem(route, rest[0])) {
      // The helper's Open and Open in Word: a download without macOS's mark answers 409 { error };
      // a file changed since it was saved 410; a program, script or web page (`program: true`) 428
      // { confirm } until the body is { confirm: true }; open-app with no app (`app: false`) 409.
      const item = fx.downloads.items.find((it) => it && String(it.id) === rest[0]);
      if (item.marked === false) return { status: 409, body: { error: UNMARKED } };
      if (item.gone === true) return { status: 410, body: { error: FILE_CHANGED } };
      if (rest[1] === "open") {
        if (item.program === true && body?.confirm !== true) return { status: 428, body: { confirm: typeof item.confirm === "string" && item.confirm ? item.confirm : CONFIRM_PROGRAM } };
        return { status: 200, body: typeof item.opens === "string" ? { ok: true, opened: item.opens } : { ok: true } };
      }
      if (item.app === false) return { status: 409, body: { error: NO_APP } };
      return { status: 200, body: { ok: true, opened: "app" } };
    }
    if (TOOL_ACTS[route]) return hasItem(route, rest[0]) ? { status: 200, body: { ok: true } } : { status: 404, body: { ok: false } };
    if (route === "diagnostics") return fx.report === null ? { status: 404, body: { ok: false } } : { status: 200, body: fx.report };
    if (route === "pick") return pickAnswer(body, fx, push);
    if (route === "invite" && plainObject(body) && body.op !== undefined) {
      // Settings' Revoke (liveview.mjs): { op: "revoke", id } and nothing else.
      if (body.op !== "revoke" || Object.keys(body).some((k) => k !== "op" && k !== "id")) return { status: 409, body: { error: 'An invite change is { op: "revoke", id }.' } };
      if (typeof body.id !== "string" || !/^[0-9a-f]{8}$/.test(body.id)) return { status: 409, body: { error: "id is an invite's id, as invites.json lists it." } };
      const items = Array.isArray(fx.invites?.items) ? fx.invites.items : [];
      if (!items.some((i) => i?.id === body.id)) return { status: 404, body: { error: "No such invite (it may have expired or been revoked already)." } };
      fx.invites = { ...fx.invites, items: items.filter((i) => i?.id !== body.id) };
      push("invites", fx.invites);
      return { status: 200, body: { ok: true, id: body.id } };
    }
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
    if (route === "config") {
      if (fx.config === null) return { status: 404 };
      const r = applyConfig(body, fx.config);
      if (r.error) return { status: 409, body: { error: r.error } };
      fx.config = r.config;
      const out = { ...fx.config, restart: fx.running !== null && fx.config.browser !== fx.running };
      push("config", out);
      return { status: 200, body: out };
    }
    if (route === "report") {
      if (fx.config?.report !== true) return { status: 404 };
      return fx.sent;
    }
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
    const max = route === "profile" ? BODY_MAX.profile : route === "input" || route === "tab" || route === "report" ? BODY_MAX.input : BODY_MAX.approve;
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
