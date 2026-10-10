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
import { rmSync, existsSync, appendFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { paths, loadConfig, ensureDirs } from "./paths.mjs";
import { secretStore } from "./secrets.mjs";
import { createFollow } from "./daemon/follow.mjs";
import { createFacts } from "./facts.mjs";
import { BrowserCoordinator, TabClaims } from "./collaboration.mjs";
import { cleanName, displayName } from "./join.mjs";
import { currentAccount } from "./util.mjs";
import { createPopups, CHALLENGE_TURN } from "./popups.mjs";
import { chooseBrowserDriver, patchrightNodeMinimum } from "./driver.mjs";
import { createContext } from "./daemon/context.mjs";
import { createHud } from "./daemon/hud.mjs";
import { createPresence } from "./daemon/presence.mjs";
import { createPause } from "./daemon/pause.mjs";
import { fieldOwner } from "./daemon/fields.mjs";
import { createPanel } from "./daemon/panel.mjs";
import { forgetPanelBuild } from "./browser.mjs";
import { createScreenShare } from "./daemon/screenshare.mjs";
import { createRecorder } from "./daemon/recorder.mjs";
import { createTabLabels } from "./daemon/tablabels.mjs";
import { createRemoteAgents } from "./daemon/remote-agents.mjs";
import { createSharing } from "./daemon/sharing.mjs";
import { createOutput } from "./daemon/output.mjs";
import { createScreenshots } from "./daemon/screenshot.mjs";
import { createServe } from "./daemon/serve.mjs";
import { createJournal } from "./daemon/journal.mjs";
import { readFields, applyFields } from "./daemon/forms.mjs";
import { createTabOrder } from "./daemon/taborder.mjs";
import { createCobrowse } from "./daemon/cobrowse.mjs";
import { shareFields, shareableUrl, crossingText, onSecretDomain, personColor } from "./tabsync.mjs";
import { createSession, readEntries, readMessage } from "./daemon/session.mjs";
import { createJoinPrompt } from "./daemon/joinprompt.mjs";

const require = createRequire(join(paths.runtime, "package.json"));
const { createConnection } = require("@playwright/mcp");
const { chromium: playwrightChromium } = require("playwright");

// How long a stopping helper waits for the browser to close cleanly before killing it (shutdown).
const SHUTDOWN_GRACE_MS = 5000;
const log = (...a) => appendFileSync(paths.daemonLog, `${new Date().toISOString()} ${a.join(" ")}\n`);
const config = loadConfig();
// Patchright unless the config opts into Playwright, or this Node.js is too old for Patchright.
const driverChoice = chooseBrowserDriver(config, process.versions.node, patchrightNodeMinimum(paths.runtime));
const { chromium } = driverChoice.driver === "playwright" ? { chromium: playwrightChromium } : require("patchright");
ensureDirs();

// One helper at a time, settled before anything else starts: each Claude Code and Codex window
// starts one when there's none (after an update, a crash), often several at once, and a second
// one must never touch the browser, the sharing tunnel or its saved state before it finds out.
const lockFile = join(dirname(paths.daemonLog), "daemon.lock");
function claimHelper() {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  for (let i = 0; i < 3; i++) {
    try { writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 }); break; } catch (e) {
      if (e.code !== "EEXIST") return true; // no lock possible here: as before (the socket decides)
      let pid = 0, age = Infinity;
      try { pid = Number(readFileSync(lockFile, "utf8")); age = Date.now() - statSync(lockFile).mtimeMs; } catch {}
      // A live helper holds it (still starting, or with its socket up); otherwise it's left over.
      if (pid && pid !== process.pid && alive(pid) && (age < 30_000 || existsSync(paths.socket))) return false;
      rmSync(lockFile, { force: true });
    }
  }
  // Several that found the same leftover lock: the last one written holds it, the others leave.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  try { return Number(readFileSync(lockFile, "utf8")) === process.pid; } catch { return false; }
}
if (process.argv[1]?.endsWith("daemon.mjs")) {
  if (!claimHelper()) { log("another daemon is running; exiting"); process.exit(0); }
  process.on("exit", () => { try { if (Number(readFileSync(lockFile, "utf8")) === process.pid) rmSync(lockFile, { force: true }); } catch {} });
}
if (driverChoice.notice) log(driverChoice.notice);

// The host's name as joiners see it (pointers, presence, the join code): a person's, never "Host".
const HOST = displayName({ configured: config.participantName, env: process.env.PAIRBROWSE_PARTICIPANT, ...currentAccount() }) || "The host";
let shuttingDown = false;
let socketServer = null; // closed first on shutdown
// Goes up whenever a page may have changed under an agent's refs: per tab, so an agent's refs
// stay good while other agents work in other tabs. Without a tab, a bump concerns every tab.
const revisions = new WeakMap(); // page -> its own count
let everywhere = 0;
const revision = (page = null) => everywhere + ((page && revisions.get(page)) || 0);
const bumpRevision = (page = null) => { if (page && typeof page === "object") revisions.set(page, (revisions.get(page) || 0) + 1); else everywhere++; };
const hostNotes = []; // for the host's agent's next result: downloads, join requests, a session that ended
const hostNote = (text) => { hostNotes.push(text); if (hostNotes.length > 50) hostNotes.shift(); }; // kept while no host agent reads them
// Notes that no longer hold (a join request answered before the agent read about it) are dropped.
hostNote.drop = (keep) => { const left = hostNotes.filter((n) => keep(n)); hostNotes.splice(0, hostNotes.length, ...left); };
const clients = new Map(); // participant -> socket

// The parts below reach each other through these (each is called only once all exist).
const liveView = () => sharing.liveView();
const refreshTabs = () => liveView()?.refreshTabs().catch(() => {});

// Passwords are read live, so one added in the Profile panel works at once. PairBrowse swaps
// them in itself and masks them in everything Claude reads back.
const secrets = secretStore(paths.secrets, log);
const collaboration = new BrowserCoordinator({ onChange: (state) => { liveView()?.setCollaboration(state); labelsChanged(); } });
// An agent's name changed (identify): its tab's label follows (tabLabels, below).
function labelsChanged() { try { tabLabels.changed(); } catch {} }
// Per-tab turns (the default); the whole-browser lease above stays for pairbrowse_collaboration.
const tabClaims = new TabClaims({ onChange: refreshTabs });

const panel = createPanel({ context: () => context.current(), liveViewUrl: async () => (await sharing.ensureLiveView()).url, log, onStale: () => forgetPanelBuild(context.profile()) });
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
  onUsed: (page) => context.touch(page), onStale: bumpRevision, applyBar: hud.applyBar, refreshTabs, restoring: () => context.isRestoring(),
  onPauseButton: (kind) => pressPause(kind === "pause"),
});
const popups = createPopups({
  log,
  quiet: () => context.isRestoring(), // tabs reopened at startup aren't new
  cookieChoice: config.cookieChoice, // "accept" (default) or "reject"
  agentActing: () => presence.agentActing(), // a tab an agent closes itself needs no note
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
    recorder.browserClosed();
    sharing.closeLiveView();
    // The agents' connections end a moment later: each session's browser server was bound to the
    // browser that closed (a fresh connection gets the next one), and the answer to a call that
    // was in flight ("the browser closed while this ran") goes out first.
    if (clients.size) { const gone = [...clients.values()]; setTimeout(() => { for (const sock of gone) sock.destroy(); }, 150); } // the ones there now, never a connection made meanwhile
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
// Recording the browser to a video (pairbrowse_record, the side panel's Record button).
const recorder = createRecorder({
  call: (fn, arg, ms) => panel.call(fn, arg, ms), log,
  owners: () => hud.sparkList().map((s) => ({ page: s.page, who: collaboration.participants.get(s.id)?.label || "Agent", color: s.color })),
  dir: () => config.downloadsDir || join(homedir(), "Downloads"),
  scale: async () => (await Promise.resolve(context.openPages()))[0]?.evaluate(() => devicePixelRatio) ?? 1,
  changed: () => liveView()?.setRecord(recorder.state()),
  onActivity: (fn) => hud.onActivity((text, who, page, from) => { if (who && page) fn(text, who, page, from); }),
});
// Who works in which tab, named on the tab strip (the agent's name in front of the tab's title).
const tabLabels = createTabLabels({ sparks: () => hud.sparkList(), labelOf: (id) => collaboration.participants.get(id)?.label || "Agent", lastIn: (page) => hud.lastIn(page), name: (page, text) => hud.call(page, text, "tab-name").catch(() => {}), log });
hud.onSparks(() => tabLabels.changed());
hud.onActivity((_text, who, page) => { if (who && page) tabLabels.changed(); });
// ...and a joiner's own agent works here as a participant (serve, below), files only from its side.
const remoteAgents = createRemoteAgents({ serve: (sock, opts) => serve(sock, opts), dir: join(paths.uploads, "remote"), log });
const sharing = createSharing({
  config, log, host: HOST, notify: panel.notify, hostNote, joinAlert: (entry) => joinPrompt.alert(entry),
  view: {
    secretDomains, screens, remoteAgents,
    // Refs go stale when a person there did something (elsewhere() says so) or a tab changed there;
    // their pointer alone, or just being in the tab, leaves the page as it was.
    // Their mark (a dot in their pointer's color) shows on the tab's icon here while they're in it.
    onJoinerPerson: (page, who, did, acting, changed = false, ago = 0) => { presence.elsewhere(page, who, did, acting, ago); hud.setPersonMark(page, personColor(who)); if (changed) bumpRevision(page); },
    onPause: (paused, who) => pressPause(paused, who || HOST), pauseState,
    onRecord: (on) => (on ? recorder.start() : recorder.stop()), recordState: () => recorder.state(),
    // A joiner's agent at work in their copy of a tab: in use, so the tab cap here keeps it (closing
    // it would close their copy too).
    onJoinerActivity: (page, text, who, from) => { context.touch(page); hud.addActivity(text, who, page, from); },
    extraOrigins: panel.origins, getContext: () => context.getContext(), currentUrl: () => context.currentUrl(), profile: facts.profile, tabMeta,
    onHumanInput: (page, who, changes = true) => { presence.humanIn(page, who || HOST); if (changes) bumpRevision(page); },
    onReplay: () => presence.replayStart(), // the live view's input never answers a join prompt
    shared: {
      host: HOST, readForm: forms.read, arrange: (pages) => tabOrder.arrange(pages), order: (pages) => tabOrder.strip(pages), showPointers: hud.showPointers,
      // The host's person typing in that tab wins: the joiner gets the host's value instead.
      applyForm: async (page, fields, who) => { if (!presence.sharedPerson(page)?.local) await forms.apply(page, fields, who); },
      sessionFor: (j) => ({ where: HOST, entries: session.entries(`${j.invite.id}:${j.joinerId}`), pause: pause.view() }),
      // From a joiner's side (text only, any role): who does what there, or a message for the
      // agents here and the other joiners. Shown and handed on, nothing more.
      onJoinerGone: (key) => session.dropRemote(key),
      onJoinerLost: (j) => hostNote(`${cleanName(j.name)}'s helper lost the connection; they're out of the session (their agent's turns here ended). They can join again with the same code.`),
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
    // A join code's address the person hasn't allowed: their answer from the side panel or picker.
    joinHost: { state: () => follow.hostState(), act: (op) => hostDecision(op) },
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
  note: hostNote,
  onMessage: (data) => session.receive(readMessage(data)),
  onHostChange: (state) => liveView()?.setJoinHost(state),
});
// The person allowed (or not) a code's address in the side panel or the picker. A yes starts
// the join; one that came from the picker is its pick (the saved tabs come back behind it).
async function hostDecision(op) {
  const r = await follow.decideHost(op);
  if (r.joined && r.owner === "picker") context.pickedJoin(`The person joined a shared session from the browser's session picker, after allowing its address ${r.host}: ${r.text.split(". Then")[0]}. Check with pairbrowse_join status.`);
  return r;
}
// A join request: the bottom bar in the host's tab in front asks (Allow / Deny) while the browser
// has the focus, else a notification with Allow / Deny (daemon/joinprompt.mjs).
let testFocus = null; // tests only (PAIRBROWSE_TEST_JOIN_PROMPT=1): true or false in place of the browser's own
const joinPrompt = createJoinPrompt({
  approvals: sharing.approvals, log, show: hud.call, byPerson: presence.byPerson,
  notify: panel.notifyJoin, clear: panel.clearJoin,
  focused: async () => (testFocus !== null ? testFocus : tabOrder.focused()),
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
  if (!lastActions.has(who) && lastActions.size >= 200) lastActions.delete(lastActions.keys().next().value); // the longest-known name goes
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
hud.onCursor((page, at) => { liveView()?.agentPointed?.(page, at); presence.agentPointed(page, at); });
// The goal log the helper keeps by itself (a run file per session; daemon/journal.mjs).
const journal = createJournal({ session: () => context.sessionName(), openPages: () => context.openPages(), mask: output.mask, strip: (t) => tabLabels.strip(`Page Title: ${t}`).replace(/^Page Title: /, ""), onActivity: (fn) => hud.onActivity(fn), log });
const serve = createServe({
  config, log, host: HOST, createConnection, clients, collaboration, tabClaims, context, hud, presence, popups, output, screenshots,
  secrets, facts, sharing, follow, pause, remoteHolder, reconnecting: (except) => liveView()?.reconnecting?.(except) || null, front: () => tabOrder.front(4000), drainHostNotes: () => hostNotes.splice(0), revision: () => revision, bumpRevision, session, shareMessage, recorder, tabNames: tabLabels, journal,
  // Tests only (PAIRBROWSE_TEST_TAB_ORDER=1): read and move tabs in the strip, as a person would
  // by dragging them; no app gets this tool otherwise.
  testTools: {
    // Tests only (PAIRBROWSE_TEST_MEMORY=1): how many listeners the browser has for its own end,
    // which grows with every session that came and went if their servers' listeners are kept.
    ...(process.env.PAIRBROWSE_TEST_MEMORY === "1" ? { pairbrowse_test_memory: async () => {
      const ctx = await context.current();
      return { text: JSON.stringify({ close: ctx?.listenerCount("close") ?? -1, disconnected: ctx?.browser?.()?.listenerCount("disconnected") ?? -1 }) };
    } } : {}),
    ...(process.env.PAIRBROWSE_TEST_TAB_ORDER === "1" ? { pairbrowse_test_tab_order: (args) => tabOrder.testCommand(args) } : {}),
    // Tests only (PAIRBROWSE_TEST_JOIN_PROMPT=1): the join request in each tab's bottom bar, and
    // clicks on it as a person would (a trusted click), as an agent's or a joiner's input would,
    // or as a page script would (synthetic events); the browser's focus set (focus: true, false,
    // or "real"); the requests with a notification up (notes).
    ...(process.env.PAIRBROWSE_TEST_JOIN_PROMPT === "1" ? { pairbrowse_test_join_prompt: async (args = {}) => {
      const pages = (await context.openPages()).filter((p) => !p.isClosed());
      if (args.focus !== undefined) { testFocus = typeof args.focus === "boolean" ? args.focus : null; joinPrompt.refresh(); return { text: `focus ${testFocus}` }; }
      if (args.notes) return { text: JSON.stringify(await panel.call(() => globalThis.pbJoinNotes?.() ?? null, null, 5000).catch(() => null)) };
      if (args.press) return { text: JSON.stringify(await panel.call((a) => globalThis.pbJoinPress?.(a.r, a.i) ?? "none", { r: String(args.request || ""), i: args.press === "allow" ? 0 : 1 }, 8000).catch((e) => `failed: ${e?.message || e}`)) };
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
      return { text: JSON.stringify({ index, value: expr ? await page.evaluate(String(expr), undefined, undefined, false) : null }) };
    } } : {}),
    // Tests only (PAIRBROWSE_TEST_PANEL=1): the side panel's worker state, the running worker made
    // to look like an earlier version's (stale: no build, no join notification buttons) and
    // checked again, and a join notification sent through it (notifyJoin: a request id).
    ...(process.env.PAIRBROWSE_TEST_PANEL === "1" ? { pairbrowse_test_panel: async (args = {}) => {
      if (args.stale) {
        await panel.call(() => { delete globalThis.pbBuild; delete globalThis.pbNotifyJoin; return true; }, null, 10_000);
        return { text: await panel.recheck() };
      }
      if (args.notifyJoin) { panel.notifyJoin({ who: "Sam (Claude Code)", role: "watch", request: String(args.notifyJoin) }); return { text: "sent" }; }
      const state = await panel.call(async () => ({ build: globalThis.pbBuild ?? null, notifyJoin: typeof globalThis.pbNotifyJoin, view: !!(await globalThis.chrome.storage.session.get("view")).view }), null, 20_000);
      const pages = (await context.getContext()).pages().filter((p) => !p.isClosed()).map((p) => p.url());
      return { text: JSON.stringify({ ...state, pages }) };
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
  journal.flushNow().catch(() => {}); // the goal log's last lines
  // Join codes outlive a restart: their tunnels keep running for the next run (sharing.mjs).
  sharing.suspend();
  // Joiners' channels end before the browser closes: its tabs closing isn't the host closing them,
  // and joiners keep their copies.
  sharing.closeLiveView();
  follow.stop().catch(() => {});
  cobrowse.stop();
  // The browser gets a clean close (Chromium writes its cookies and logins on the way out; it
  // writes them only every ~30 s otherwise), at most SHUTDOWN_GRACE_MS: then the helper exits
  // and Playwright's exit handler kills what's left of it.
  const started = Date.now();
  setTimeout(() => { log(`shutdown: the browser didn't close within ${SHUTDOWN_GRACE_MS} ms; killing it`); process.exit(code); }, SHUTDOWN_GRACE_MS).unref();
  await context.close();
  log(`shutdown: browser closed cleanly in ${Date.now() - started} ms`);
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
