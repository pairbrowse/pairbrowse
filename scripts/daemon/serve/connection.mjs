// One connection's state (one agent: Claude Code, Codex, any MCP client, or a joiner's agent): what
// the tool server's parts read and change for it, in one object instead of a closure's variables.
// participant: its id; remote: a joiner's agent working in this browser (serve.mjs), else null;
// pauseSeen: the pause count when it connected (pauses before that aren't news).
import { createRefNames } from "../output.mjs";

export function createConnectionState(participant, { remote = null, pauseSeen = 0 } = {}) {
  const conn = {
    participant,
    remote,
    initialized: false, // its MCP initialize came (the first one names the app for good)
    clientName: "", // the app on this connection, from its MCP initialize ("claude-code", "codex-mcp-client", ...)
    resumeKey: "", // the app session it belongs to (serve/departures.mjs): a later connection of it takes its place
    resumed: false, // it took a closed connection's label, color and tab
    disconnected: new AbortController(),
    actingIn: null, // the tab this participant's current call acts in
    // The tab this participant works in, as a page: other agents' new and closed tabs shift the
    // numbers, and two tabs can show the same URL. Its browser server's current tab follows it.
    mine: null,
    serverAt: null, // the page its browser server has current, when known
    lostTab: false, // it closed its tab and every other tab was another agent's
    // Why it has no tab, for the answer it then gets.
    closedByMe: false, // it closed its own tab itself (else a person or the page did)
    othersOpen: 0, // the web tabs open besides this agent's, as freeTab last counted them
    noTabWhy: "",
    used: [], // tabs it worked in before, latest last: where it goes back to
    homes: new Map(), // browser session -> this agent's tab there last (successorOf finds it again)
    // What this participant's last click in a tab committed ("delete", "pay"), for a minute: the
    // confirmation it opens counts as the same action (daemon/page.mjs clickRisk prev).
    risks: new WeakMap(), // tab -> { kind, t } | null
    // Calls whose named final action the user allowed in the browser (Codex and other apps: the
    // approval card, daemon/approvals.mjs): the hand-off doesn't apply to them.
    approvedArgs: new WeakSet(),
    approvedWhere: new WeakMap(), // args -> the tab and origin that Allow was for (approvals.mjs sameWhere)
    pauseSeen, // pauses before it connected aren't news
    fieldNotes: [], // fields left to the people filling them, for the next result
    refNames: createRefNames(), // the main frame's refs plain for Claude (output.mjs)
    submitAfter: new Set(), // browser_type calls whose Enter PairBrowse presses itself
    recorded: false, // in the session's list of who used it
    serverListeners: [], // its browser server's listeners on the browser (contextFor)
    pending: new Map(), // the helper's own calls to the server, by id
    completed: new Map(), // calls in flight: resolved once their result went out
    calls: new Map(), // request id -> tool name, for the result
    traces: new Map(), // request id -> its phase trace (PAIRBROWSE_TRACE)
    callArgs: new Map(), // request id -> the call's arguments (Claude's: secret names, never values)
    tabActions: new Map(), // request id -> browser_tabs action
    refused: new Set(), // calls the helper itself turned down: they changed nothing in the browser
    late: new Set(), // calls answered for running too long: a result that still comes is dropped
    observedRevision: -1, // the tab revision its refs are good for
    acted: false, // a call of this participant's got past the session picker
    tabsListed: false, // this session's browser server has seen the tab list
    snapshotReturned: false, // the current call's result carries a snapshot
    seq: 0, // the helper's own calls to its server, numbered
  };
  // Its own tab while open; the tab its current call acts in, else that.
  conn.openMine = () => (conn.mine && !conn.mine.isClosed() ? conn.mine : null);
  conn.ownTab = () => conn.actingIn || conn.openMine();
  conn.recentRisk = (page) => { const r = page && conn.risks.get(page); return r && Date.now() - r.t < 60_000 ? r.kind : ""; };
  conn.lostWhy = () => `${conn.closedByMe ? "you closed yours" : "your tab was closed (by a person, the page or the browser)"} and ${conn.othersOpen ? "the others are in use by other agents" : "no other tab is open"}`;
  conn.noTab = () => `You have no tab of your own: ${conn.noTabWhy}. Open one with browser_tabs new.`;
  conn.noTabWhy = conn.lostWhy();
  return conn;
}
