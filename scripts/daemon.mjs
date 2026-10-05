#!/usr/bin/env node
// The PairBrowse daemon. It owns the Chrome window and outlives Claude Code sessions, so tabs and
// logins stay put between sessions.
//
// Security model:
// - Chrome is driven over a private pipe (Playwright's default). There's no remote-debugging port.
// - The only way in is a socket file in ~/.pairbrowse/run (mode 0700), so only your user account
//   can connect. Shared clients coordinate through a daemon-wide queue and control leases.
// - Secrets are typed only on the HTTPS domains listed for them in secrets.env.
// - Arbitrary-code and non-web navigation tools are refused here as well as in the hook.
//
// This file wires the parts in scripts/daemon/ together and runs the socket server:
//   context.mjs   the browser, its tabs, downloads and sessions
//   hud.mjs       the badge, bar, spark and cursor inside the pages
//   presence.mjs  you, using the browser by hand
//   pause.mjs     "Pause agents": people stop every agent in the session until someone resumes
//   fields.mjs    fields people fill are theirs: agents leave them alone
//   panel.mjs     the side panel and notifications
//   screenshare.mjs  shared browser mode: joiners see the tabs live and work in them
//   sharing.mjs   the live view, invites and joiners
//   output.mjs    password masking and long snapshots in results
//   screenshot.mjs  the screenshots in results, and clicking on them
//   serve.mjs     one connected agent: the rules before each call, the notes after
import net from "node:net";
import { createRequire } from "node:module";
import { rmSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { paths, loadConfig, ensureDirs } from "./paths.mjs";
import { secretStore } from "./secrets.mjs";
import { createFollow } from "./daemon/follow.mjs";
import { createFacts } from "./facts.mjs";
import { BrowserCoordinator, TabClaims } from "./collaboration.mjs";
import { cleanName, displayName } from "./join.mjs";
import { currentAccount } from "./util.mjs";
import { createPopups, CHALLENGE_TURN } from "./popups.mjs";
import { loadBrowserDriver } from "./driver.mjs";
import { createContext } from "./daemon/context.mjs";
import { createHud } from "./daemon/hud.mjs";
import { createPresence } from "./daemon/presence.mjs";
import { createPause } from "./daemon/pause.mjs";
import { fieldOwner } from "./daemon/fields.mjs";
import { createPanel } from "./daemon/panel.mjs";
import { createScreenShare } from "./daemon/screenshare.mjs";
import { createRemoteAgents } from "./daemon/remote-agents.mjs";
import { createSharing } from "./daemon/sharing.mjs";
import { createOutput } from "./daemon/output.mjs";
import { createScreenshots } from "./daemon/screenshot.mjs";
import { createServe } from "./daemon/serve.mjs";
import { readFields, applyFields } from "./daemon/forms.mjs";
import { createTabOrder } from "./daemon/taborder.mjs";
import { createCobrowse } from "./daemon/cobrowse.mjs";
import { shareFields, shareableUrl, crossingText, onSecretDomain, personColor } from "./tabsync.mjs";
import { createSession, readEntries, readMessage } from "./daemon/session.mjs";
import { createJoinPrompt } from "./daemon/joinprompt.mjs";

const require = createRequire(join(paths.runtime, "package.json"));
const { createConnection } = require("@playwright/mcp");
const { chromium: playwrightChromium } = require("playwright");

const SHUTDOWN_GRACE_MS = 8000;
const log = (...a) => appendFileSync(paths.daemonLog, `${new Date().toISOString()} ${a.join(" ")}\n`);
const config = loadConfig();
const { chromium } = loadBrowserDriver((name) => name === "playwright" ? { chromium: playwrightChromium } : require(name), config);
ensureDirs();

// The host's name as joiners see it (pointers, presence, the join code): a person's, never "Host".
const HOST = displayName({ configured: config.participantName, env: process.env.PAIRBROWSE_PARTICIPANT, ...currentAccount() }) || "The host";
let shuttingDown = false;
let socketServer = null; // closed first on shutdown
let revision = 0; // goes up whenever a page may have changed under an agent's refs
const bumpRevision = () => ++revision;
const hostNotes = []; // for the host's agent's next result: downloads, join requests, a session that ended
const hostNote = (text) => hostNotes.push(text);
const clients = new Map(); // participant -> socket

// The parts below reach each other through these (each is called only once all exist).
const liveView = () => sharing.liveView();
const refreshTabs = () => liveView()?.refreshTabs().catch(() => {});

// Passwords are read live, so one added in the Profile panel works at once. PairBrowse swaps
// them in itself and masks them in everything Claude reads back.
const secrets = secretStore(paths.secrets, log);
const collaboration = new BrowserCoordinator({ onChange: (state) => liveView()?.setCollaboration(state) });
// Per-tab turns (the default); the whole-browser lease above stays for pairbrowse_collaboration.
const tabClaims = new TabClaims({ onChange: refreshTabs });

const panel = createPanel({ context: () => context.current(), liveViewUrl: async () => (await sharing.ensureLiveView()).url, log });
// "Pause agents", session-wide: held here, or mirrored from the host of a session joined from
// here (only a drive participant may press it there; a watcher sees it but can't).
const canPause = () => !follow.joined() || follow.role() === "drive";
const pause = createPause({
  onChange: () => {
    hud.refreshBars();
    liveView()?.setPause();
    refreshTabs(); // on to the joiners, with the session
  },
});
const pauseState = () => ({ ...pause.view(), can: canPause() });
// A person pressed "Pause agents" or "Resume" here (the bar in a page, the side panel, a drive
// guest's viewer). In a session joined from here the host decides, and its state comes back.
function pressPause(paused, who = HOST) {
  if (follow.joined()) {
    if (!canPause()) return { problem: "You joined to watch: only drive participants can pause agents." };
    follow.say({ op: "pause", paused });
    return { ok: true };
  }
  if (paused) pause.pause(who); else pause.resume(who);
  return { ok: true };
}
const hud = createHud({
  pages: () => context.openPages(), participants: () => [...collaboration.participants.keys()],
  waiting: (page) => presence.waiting(page), liveView, notify: panel.notify,
  pause: () => ({ by: pause.view().by, can: canPause() }),
});
const presence = createPresence({
  host: HOST, readEvents: (frame) => hud.call(frame, "", "user"), pages: () => context.openPages(), paused: () => context.isSwitching(),
  onUsed: (page) => context.touch(page), onStale: bumpRevision, applyBar: hud.applyBar, refreshTabs,
  onPauseButton: (kind) => pressPause(kind === "pause"),
});
const popups = createPopups({
  log,
  quiet: () => context.isRestoring(), // tabs reopened at startup aren't new
  cookieChoice: config.cookieChoice, // "accept" (default) or "reject"
  onYourTurn: (text) => hud.setBadge(text, "you").catch(() => {}),
  // The check is done: take "Your turn" down again if it was this one.
  onCleared: () => { if (hud.badge().text === CHALLENGE_TURN) hud.setBadge("", "clear").catch(() => {}); },
});
const context = createContext({
  config, log, chromium, hud, presence, popups, hostNote, notify: (text) => panel.notify(text),
  liveOthers: () => liveView()?.joinersNow() || [], // people who joined this session, there now
  onTabClosed: (page) => tabClaims.drop(page), // a closed tab's turn ends with it
  status: (badge) => liveView()?.setStatus(badge),
  shuttingDown: () => shuttingDown,
  onStarted: () => {
    liveView()?.setSession(context.sessionInfo());
    setTimeout(() => panel.connect().catch((e) => log("side panel", e?.message || e)), 0);
  },
  // The window is gone: end the sessions (the bridge reconnects and reopens Chrome on the next
  // action), or shut down if nobody is connected.
  onClosed: () => {
    // The host closed the window: sharing ends with it (codes, yeses, tunnels). A restart of the
    // helper closes it too, but keeps them.
    if (!shuttingDown) sharing.endAll();
    sharing.closeLiveView();
    if (clients.size) for (const sock of clients.values()) sock.destroy();
    else shutdown(0);
  },
});
const output = createOutput({ dir: paths.files, secretValues: () => secrets.get().values });
const screenshots = createScreenshots({ secrets: () => secrets.get(), log, hidePeers: (page, hidden) => hud.call(page, hidden ? "1" : "", "peers-hidden").catch(() => {}) });
const facts = createFacts({ secrets, log, onChange: () => liveView()?.setProfile(facts.summary()) });

// Who is in a tab, for the live view's tab overview: the agent holding it (with its spark color),
// a person using it by hand, and the last thing done there.
// The agent here holding a tab ({ label, color, until }: until, when its turn there ends, only
// while it holds the turn), or null.
function localAgent(page) {
  const claim = tabClaims.holder(page);
  const agentId = claim?.id || hud.sparkOwner(page)?.id;
  return agentId ? { label: claim?.label || collaboration.participants.get(agentId)?.label || "Agent", color: hud.sparkColor(agentId), until: claim?.until || 0 } : null;
}
// Agents in the other browser of a shared tab: a drive joiner's in their copy (until it's no
// longer said), or the host's in a session joined from here. joined: not this browser's own.
const joinedAgents = new WeakMap(); // tab -> { label, color, until, turnUntil, from }
const JOINED_AGENT_MS = 30_000;
// An agent on another computer of a shared session holding this tab's turn there ({ label,
// until, yields }), or null: the agents here wait for it (serve.mjs takeTurn) instead of acting
// in this copy. yields: a drive joiner's agent, which gives way to an agent here that already
// holds the tab (both started at once).
function remoteHolder(page) {
  const there = follow.agentIn(page); // the host's agent, in a session joined from here
  if (there?.held) return { label: `${there.label} (in ${follow.host() || "the host"}'s browser)`, until: there.until, yields: false };
  const theirs = joinedAgents.get(page);
  return theirs?.turnUntil && Date.now() < theirs.until && liveView()?.joinerHere(theirs.from) ? { label: `${theirs.label} (in ${theirs.where || "a guest"}'s browser)`, until: theirs.turnUntil, yields: true } : null;
}
function tabMeta(page) {
  const remote = follow.agentIn(page); // an agent in the other browser of a joined session
  const theirs = joinedAgents.get(page);
  const agent = localAgent(page) || (remote ? { label: remote.label, color: remote.color || hud.sparkColor(`joined:${remote.label}`), joined: true } :
    theirs && Date.now() < theirs.until ? { label: theirs.label, color: theirs.color || "#e9763f", joined: true, from: theirs.from, until: theirs.turnUntil } : null);
  return { agent, person: presence.recentPerson(page), waiting: !!presence.waiting(page), last: hud.lastIn(page),
    sharedPerson: presence.sharedPerson(page), did: presence.feedAfter(page) };
}

// Who is doing what, for a shared session's side panels and agents: this helper's agents with
// their spark color, tab, status and task (pairbrowse_status) and last action.
const lastActions = new Map(); // label -> text
const STATUS_OF = { you: "you", done: "done", clear: "idle" };
// The other side's participants, checked, and their last actions and tasks as they may cross on
// (to other joiners): an older helper there may send them unredacted.
const crossingEntries = (list) => readEntries(list).map((e) => ({ ...e, task: crossingText(e.task), last: crossingText(e.last) }));
function localEntries() {
  const out = [];
  for (const [id, p] of collaboration.participants) {
    const page = hud.sparkPage(id);
    const st = session.statusOf(id);
    out.push({ who: p.label, kind: "agent", color: hud.sparkColor(id), tab: page && !page.isClosed() ? (shareableUrl(page.url()) || "").replace(/^https?:\/\//, "") : "",
      task: st?.text || "", status: st?.text ? STATUS_OF[st.kind] || "working" : "idle", last: lastActions.get(p.label) || "" });
  }
  return out;
}
const session = createSession({
  locals: localEntries,
  secrets: () => secrets.get().values || {},
  labelOf: (p) => collaboration.participants.get(p)?.label || "Agent",
  onChange: () => sessionChanged(),
  // What an agent on the other side took up shows in the bottom bar and activity here too.
  onRemoteTask: (source, who, task) => hud.addActivity(`Now: ${task}`, who, null, source === "host" ? "joined" : source),
});
let boardTimer = null;
function sessionChanged() {
  if (boardTimer) return;
  boardTimer = setTimeout(() => {
    boardTimer = null;
    liveView()?.setBoard({ people: session.entries(), messages: session.recent() });
    refreshTabs(); // and on to the joiners' streams
  }, 50);
}
// A message from an agent here: to the joiners here, and to the host of a session joined from here.
function shareMessage(msg) {
  liveView()?.pushToJoiners("message", msg);
  follow.say({ op: "message", ...msg });
}

// Sites with saved passwords: their tabs cross to joiners (and back from the sessions joined
// here) as origin + path only.
const secretDomains = () => Object.values(secrets.get().domains || {}).flat();
// Form values in shared tabs: read here as they may cross (sensitive ones, saved passwords
// included, only as filled), and filled in from the other side.
// A field a person filled carries their name (o) across, so agents on both sides leave it be.
const forms = {
  read: async (page) => {
    const r = await readFields(page, secretDomains(), hud.key);
    if (!r) return null;
    const owned = r.fields.map(({ own, ...x }) => {
      const o = fieldOwner(own, { host: HOST, byAgent: presence.typedByAgent, byRemote: presence.byRemote });
      return o ? { ...x, o: o.who } : x;
    });
    return { url: r.url, fields: shareFields(owned, { secretValues: Object.values(secrets.get().values || {}) }) };
  },
  apply: (page, fields, who) => applyFields(page, fields, who, secretDomains(), hud.key),
};
const tabOrder = createTabOrder({ call: (fn, arg, ms) => panel.call(fn, arg, ms), getContext: () => context.getContext(), log });

// Shared browser mode: joiners see this browser's tabs live and work in them (daemon/screenshare.mjs).
const screens = createScreenShare({ call: (fn, arg, ms) => panel.call(fn, arg, ms), getContext: () => context.getContext(), log, during: (who) => presence.remoteStart(who) });
// ...and a joiner's own agent works here as a participant (serve, below), files only from its side.
const remoteAgents = createRemoteAgents({ serve: (sock, opts) => serve(sock, opts), dir: join(paths.uploads, "remote"), log });
const sharing = createSharing({
  config, log, host: HOST, notify: panel.notify, hostNote,
  view: {
    secretDomains, screens, remoteAgents,
    // Refs go stale when a person there did something (elsewhere() says so) or a tab changed there;
    // their pointer alone, or just being in the tab, leaves the page as it was.
    // Their mark (a dot in their pointer's color) shows on the tab's icon here while they're in it.
    onJoinerPerson: (page, who, did, acting, changed = false) => { presence.elsewhere(page, who, did, acting); hud.setPersonMark(page, personColor(who)); if (changed) bumpRevision(); },
    onPause: (paused, who) => pressPause(paused, who || HOST), pauseState,
    // A joiner's agent at work in their copy of a tab: in use, so the tab cap here keeps it (closing
    // it would close their copy too).
    onJoinerActivity: (page, text, who, from) => { context.touch(page); hud.addActivity(text, who, page, from); },
    extraOrigins: panel.origins, getContext: () => context.getContext(), currentUrl: () => context.currentUrl(), profile: facts.profile, tabMeta,
    onHumanInput: (page, who, changes = true) => { presence.humanIn(page, who || HOST); if (changes) bumpRevision(); },
    onReplay: () => presence.replayStart(), // the live view's input never answers a join prompt
    shared: {
      host: HOST, readForm: forms.read, arrange: (pages) => tabOrder.arrange(pages), order: (pages) => tabOrder.strip(pages), showPointers: hud.showPointers,
      // The host's person typing in that tab wins: the joiner gets the host's value instead.
      applyForm: async (page, fields, who) => { if (!presence.sharedPerson(page)?.local) await forms.apply(page, fields, who); },
      sessionFor: (j) => ({ where: HOST, entries: session.entries(`${j.invite.id}:${j.joinerId}`), pause: pause.view() }),
      // From a joiner's side (text only, any role): who does what there, or a message for the
      // agents here and the other joiners. Shown and handed on, nothing more.
      onJoinerSay: (body, j, key) => {
        if (body?.op === "session") session.setRemote(key, crossingEntries(body.entries), cleanName(j.name));
        else if (body?.op === "pause") {
          // A person there pressed "Pause agents" or "Resume": drive joiners only.
          if (j.invite.role !== "drive") return { problem: "Only drive participants can pause agents." };
          if (body.paused === true) pause.pause(cleanName(j.name)); else pause.resume(cleanName(j.name));
        }
        else if (body?.op === "message") {
          const msg = readMessage(body);
          if (!msg) return { problem: "Not a message." };
          const t = Date.now();
          j.messages = (j.messages || []).filter((x) => x > t - 60_000);
          if (j.messages.length >= 10) return { problem: "At most 10 messages a minute." };
          j.messages.push(t);
          session.receive(msg);
          liveView()?.pushToJoiners("message", msg, { except: key });
        }
        return {};
      },
      onJoinerAgent: (page, who, color, left = 0, from = "", where = "") => {
        if (who) { joinedAgents.set(page, { label: who, color, until: Date.now() + JOINED_AGENT_MS, turnUntil: left > 0 ? Date.now() + left : 0, from, where }); context.touch(page); } else joinedAgents.delete(page);
        hud.setSharedSpark(page, who ? color || "#e9763f" : "");
        refreshTabs();
      },
    },
    status: () => hud.badge(), session: () => context.sessionInfo(), collaboration: () => collaboration.state(),
    picker: { state: () => context.pickerState(), pick: (op) => pickFromBrowser(op), open: () => context.reopenPicker() },
  },
});
// Sessions joined from here: their tabs, followed in this browser.
const follow = createFollow({
  config, log, context, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent,
  onSession: (data, join) => {
    session.setRemote("host", crossingEntries(data?.entries), String(data?.where || join.host));
    if (data?.pause && typeof data.pause === "object") pause.mirror({ paused: data.pause.paused === true, by: String(data.pause.by || ""), resumedBy: String(data.pause.resumedBy || "") });
  },
  // Out of the session: a pause from there no longer holds the agents here.
  onLeft: () => pause.mirror({ paused: false, resumedBy: HOST }),
  onMessage: (data) => session.receive(readMessage(data)),
});
// A join request's corner prompt (Allow / Deny), in the host's tab in front (daemon/joinprompt.mjs).
const joinPrompt = createJoinPrompt({
  approvals: sharing.approvals, log, show: hud.call, byPerson: presence.byPerson,
  front: async () => {
    const page = await tabOrder.front().catch(() => null);
    if (page) return page;
    const pages = (await context.openPages()).filter((p) => !p.isClosed());
    return pages.length === 1 ? pages[0] : null; // the side panel couldn't say: only when there's no doubt
  },
});
// Who used each session, for the session picker: joiners the host let in.
sharing.approvals.onChange(() => {
  for (const e of sharing.approvals.list()) if (e.state === "approved") context.recordPerson({ who: e.name, app: e.app, computer: e.computer, kind: "guest" });
});
// The person's pick in the session picker (the browser's first tab, see context.mjs). Joining
// takes the same code checks as pairbrowse_join, and the host still has to let them in.
async function pickFromBrowser(op) {
  if (op?.action !== "join") return context.pickSession({ action: op?.action, name: op?.name });
  if (!context.picking()) return { text: "A session is already chosen.", error: true };
  const r = await follow.command({ action: "join", code: String(op.code || "").trim().slice(0, 4000), name: String(op.joinName || "").slice(0, 40) }, { owner: "picker", app: "PairBrowse" });
  if (r.needsName) return { text: "Type your name too: the host sees it before letting you in. It's remembered for next time.", error: true };
  if (r.error) return r;
  const asked = `${r.text.split(". Then")[0]}.`; // "Asked Bob to let Alice in (drive). They have to approve first."
  context.pickedJoin(`The person joined a shared session from the browser's session picker: ${asked} Check with pairbrowse_join status.`);
  return { text: asked };
}
// This side's agents, for the host of a session joined from here (when it changes, and every 10 s).
let sentSession = { sig: "", at: 0 };
setInterval(() => {
  if (!follow.pages().length && !follow.joined()) return;
  const entries = localEntries();
  const sig = JSON.stringify(entries);
  if (sig === sentSession.sig && Date.now() - sentSession.at < 10_000) return;
  sentSession = { sig, at: Date.now() };
  follow.say({ op: "session", entries });
}, 500).unref();
// An agent's last action, as it shows to the other participants (and crosses to a joined session):
// nothing from a tab that doesn't cross, or crosses as its address only (a site with saved passwords).
hud.onActivity((text, who, page, from) => {
  if (from || !who || !text) return;
  const quiet = page && !page.isClosed() && (!shareableUrl(page.url()) || onSecretDomain(page.url(), secretDomains()));
  lastActions.set(who, quiet ? "" : crossingText(text, secrets.get().values || {}).slice(0, 140));
  sessionChanged();
});
// Shared tabs, live: pointers and field changes from the page script, handed on as they happen
// (only tabs that are shared: with joiners here, or copies of a session joined from here).
const cobrowse = createCobrowse({
  call: hud.call, log,
  pages: async () => {
    const lv = liveView();
    const hosted = lv?.sharing() ? await context.openPages() : [];
    return [...new Set([...hosted, ...follow.pages()])];
  },
  onPointer: (page, value) => {
    // An agent's clicks move the real mouse too: that's the agent's pointer, not the person's.
    const v = value.me && (presence.byAgent(Number(value.me.t)) || presence.byRemote(Number(value.me.t))) ? { ...value, me: null } : value; // an agent's or a joiner's moves (shared browser) are not the host's pointer
    liveView()?.pointed(page, v);
    follow.pointed(page, v);
  },
  onDirty: (page) => { liveView()?.fieldsChanged(page); follow.dirty(page); },
});
const serve = createServe({
  config, log, host: HOST, createConnection, clients, collaboration, tabClaims, context, hud, presence, popups, output, screenshots,
  secrets, facts, sharing, follow, pause, remoteHolder, drainHostNotes: () => hostNotes.splice(0), revision: () => revision, bumpRevision, session, shareMessage,
  // Tests only (PAIRBROWSE_TEST_TAB_ORDER=1): read and move tabs in the strip, as a person would
  // by dragging them; no app gets this tool otherwise.
  testTools: {
    ...(process.env.PAIRBROWSE_TEST_TAB_ORDER === "1" ? { pairbrowse_test_tab_order: (args) => tabOrder.testCommand(args) } : {}),
    // Tests only (PAIRBROWSE_TEST_JOIN_PROMPT=1): the join prompt in each tab, and clicks on it as
    // a person would (a trusted click), as an agent's or a joiner's input would, or as a page
    // script would (synthetic events).
    ...(process.env.PAIRBROWSE_TEST_JOIN_PROMPT === "1" ? { pairbrowse_test_join_prompt: async (args = {}) => {
      const pages = (await context.openPages()).filter((p) => !p.isClosed());
      if (args.move) { const p = await joinPrompt.front(); await p?.mouse.move(5, 5); return { text: "moved" }; }
      if (!args.click) return { text: JSON.stringify(await Promise.all(pages.map(async (p) => ({ url: p.url(), rows: (await hud.call(p, "", "join-state").catch(() => null)) || [] })))) };
      const page = await joinPrompt.front();
      const row = page && ((await hud.call(page, "", "join-state").catch(() => null)) || [])[0];
      if (!row) return { text: "no prompt", error: true };
      const { x, y } = row[args.click];
      if (args.as === "page") {
        await page.evaluate(([cx, cy]) => { const el = document.elementFromPoint(cx, cy); for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el?.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, detail: 1, clientX: cx, clientY: cy })); }, [x, y]);
        return { text: "page clicked" };
      }
      const done = args.as === "agent" ? presence.busyStart() : args.as === "joiner" ? presence.remoteStart("Eve") : args.as === "liveview" ? presence.replayStart() : () => {};
      try { await page.mouse.click(x, y); } finally { done(); }
      return { text: "clicked" };
    } } : {}),
    // Tests only (PAIRBROWSE_TEST_SCREEN=1): the shared browser picture page here, as a person
    // would use it (its state, its place among the tabs, keys typed on it, its address bar).
    ...(process.env.PAIRBROWSE_TEST_SCREEN === "1" ? { pairbrowse_test_screen: async (args = {}) => { const { expr, type, choose } = args;
      // at: a picture page by its place among the tabs (list gives them); else the first one.
      const all = (await context.getContext()).pages();
      const page = follow.pages().find((p) => !p.isClosed() && p.url().includes("/screen.html") && (!Number.isInteger(args.at) || all.indexOf(p) === args.at));
      if (!page) return { text: "no picture page", error: true };
      if (Array.isArray(choose)) { page.once("filechooser", (fc) => fc.setFiles(choose.map(String)).catch(() => {})); return { text: "will choose" }; }
      if (args.shot) { await page.screenshot({ path: String(args.shot) }); return { text: "saved" }; }
      // goto: an address typed into this tab's address bar; url: the tab's own address.
      if (args.goto) { await page.goto(String(args.goto), { waitUntil: "commit" }).catch(() => {}); return { text: "went" }; }
      if (args.url) return { text: JSON.stringify({ url: page.url() }) };
      if (args.inSight) return { text: JSON.stringify({ id: follow.inSight() }) };
      if (args.list) { const ctx = await context.getContext(); return { text: JSON.stringify(await Promise.all(follow.pages().filter((p) => !p.isClosed()).map(async (p) => ({ index: ctx.pages().indexOf(p), title: await p.title().catch(() => "") })))) }; }
      if (type) { await page.keyboard.type(String(type), { delay: 20 }); return { text: "typed" }; }
      const index = (await context.getContext()).pages().indexOf(page);
      return { text: JSON.stringify({ index, value: expr ? await page.evaluate(String(expr)) : null }) };
    } } : {}),
  },
});
output.start();

async function shutdown(code) {
  if (shuttingDown) return;
  // No new connections and no new browser while closing: a client that reconnects at once
  // would otherwise start the browser again inside a helper that's on its way out.
  shuttingDown = true;
  socketServer?.close();
  // Join codes outlive a restart: their tunnels keep running for the next run (sharing.mjs).
  sharing.suspend();
  // Joiners' channels end before the browser closes: its tabs closing isn't the host closing them,
  // and joiners keep their copies.
  sharing.closeLiveView();
  follow.stop().catch(() => {});
  cobrowse.stop();
  setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
  await context.close();
  if (process.platform !== "win32") rmSync(paths.socket, { force: true });
  process.exit(code);
}

async function main() {
  if (process.platform !== "win32" && existsSync(paths.socket)) {
    const alive = await new Promise((r) => {
      const s = net.connect(paths.socket, () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (alive) return log("another daemon is running; exiting");
    rmSync(paths.socket, { force: true });
  }
  context.startUp();
  socketServer = net.createServer((sock) => shuttingDown ? sock.destroy() : serve(sock).catch((e) => { log("session error", e?.stack || e); sock.destroy(); }));
  socketServer.listen(paths.socket, () => log(`listening on ${paths.socket}`));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));
}

if (process.argv[1]?.endsWith("daemon.mjs")) main();
