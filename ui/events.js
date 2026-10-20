// Every event the helper sends on the live view's event stream (GET <key>/events), in one list:
// who gets it, and how the browser's own pages take it. The helper (scripts/liveview.mjs) and the
// pages (common.js) both read it, and a test checks every event the helper sends is here.
//
// to: who the helper sends it to.
//   "all"     every stream, invite link guests too (the helper trims what guests get: forGuest);
//   "owner"   the owner's streams only (either owner key: the live view page, the side panel, the
//             browser's own pages);
//   "pages"   the browser's own pages' streams only (?page=<kind>, the owner's key); with kind:
//             only that page kind's streams (least privilege: SDPs reach the capture page alone);
//   "viewers" the streams that show the picture (not ?panel, not ?page);
//   "turn"    a hand-off grant's own stream alone (liveview/grants.mjs), never broadcast.
// pages: how the browser's own pages listen (common.js helperStream).
//   "shared"  on the pages' one shared stream (STREAM_EVENTS); delta: never replayed to a page
//             that joins late (it fetches its snapshot instead);
//   "own"     on that kind's own stream only (OWN_STREAM_EVENTS), never relayed or replayed;
//   absent    no page of the browser listens (the live view page reads it on its own stream).
export const SERVER_EVENTS = Object.freeze({
  tabs: { to: "all", pages: "shared" },
  status: { to: "all", pages: "shared" },
  session: { to: "all", pages: "shared" },
  collaboration: { to: "all", pages: "shared" },
  activity: { to: "all", pages: "shared" },
  pause: { to: "all", pages: "shared" },
  frame: { to: "viewers" },
  record: { to: "owner", pages: "shared" },
  profile: { to: "owner", pages: "shared" },
  join: { to: "owner", pages: "shared" },
  board: { to: "owner", pages: "shared" },
  dev: { to: "owner", pages: "shared" },
  joinhost: { to: "owner", pages: "shared" },
  layout: { to: "owner", pages: "shared" },
  "agent-tabs": { to: "owner", pages: "shared" },
  timeline: { to: "owner", pages: "shared", delta: true },
  config: { to: "owner", pages: "shared" },
  approval: { to: "owner", pages: "shared", delta: true },
  driving: { to: "owner", pages: "shared" },
  outline: { to: "owner" },
  downloads: { to: "owner", pages: "shared", delta: true },
  handoffs: { to: "owner", pages: "shared", delta: true },
  sessions: { to: "owner", pages: "shared" },
  invites: { to: "owner", pages: "shared" },
  "joiner-pointers": { to: "owner" },
  capture: { to: "pages", kind: "capture", pages: "own" },
  "tab-order": { to: "pages", pages: "shared", delta: true },
  "overlay-pointers": { to: "pages", pages: "shared", delta: true },
  turn: { to: "turn" },
  "turn-ended": { to: "turn" },
});

const names = (keep) => Object.freeze(Object.keys(SERVER_EVENTS).filter((n) => keep(SERVER_EVENTS[n])));
// The helper's side: events only the owner's streams get (the pages' own among them), events only
// the browser's pages get, and the page kind an event is for alone.
export const OWNER_EVENTS = names((e) => e.to === "owner" || e.to === "pages");
export const PAGES_EVENTS = names((e) => e.to === "pages");
export const EVENT_KIND = Object.freeze(Object.fromEntries(Object.entries(SERVER_EVENTS).filter(([, e]) => e.kind).map(([n, e]) => [n, e.kind])));
// The pages' side: the shared stream's events, those of them never replayed, and each kind's own.
export const SHARED_STREAM_EVENTS = names((e) => e.pages === "shared");
export const DELTA_EVENTS = names((e) => e.pages === "shared" && e.delta === true);
export const OWN_EVENTS = Object.freeze(Object.fromEntries([...new Set(Object.values(SERVER_EVENTS).filter((e) => e.pages === "own").map((e) => e.kind))]
  .map((kind) => [kind, names((e) => e.pages === "own" && e.kind === kind)])));
