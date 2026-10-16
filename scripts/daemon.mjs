#!/usr/bin/env node
// The PairBrowse daemon. It owns the browser window and outlives Claude Code sessions, so tabs and
// logins stay put between sessions.
//
// Security model:
// - The browser is driven over a private pipe (Playwright's default). There's no remote-debugging port.
// - The only way in is a socket file in ~/.pairbrowse/run (mode 0700), so only your user account
//   can connect. Shared clients coordinate through a daemon-wide queue and control leases.
// - Secrets are typed only on the HTTPS domains listed for them in secrets.env.
// - Arbitrary-code and non-web navigation tools are refused here as well as in the hook.
//
// This file wires the parts in scripts/daemon/ together and runs the socket server:
//   context.mjs   the browser, its tabs, downloads and sessions (browser/, sessions/)
//   hud.mjs       the badge, bar, spark and cursor inside the pages
//   presence.mjs  you, using the browser by hand
//   pause.mjs     "Pause agents": people stop every agent in the session until someone resumes
//   fields.mjs    fields people fill are theirs: agents leave them alone
//   panel.mjs     the side panel and notifications
//   screenshare.mjs  shared browser mode: joiners see the tabs live and work in them
//   sharing.mjs   the live view, invites and joiners (tunnel-pool.mjs: the sharing tunnels)
//   follow.mjs    joining someone else's session (join/: hosts, agents, picture pages, the mirror)
//   board.mjs     who does what across a shared session, and messages
//   output.mjs    password masking and long snapshots in results
//   screenshot.mjs  the screenshots in results, and clicking on them
//   serve.mjs     one connected agent: the rules before each call, the notes after
//   approvals.mjs a named final click asked in the browser as well (the card, the hook's line)
//   timeline.mjs  the pictures already sent to agents, kept per session
//   outline.mjs   the last whole-page snapshot an agent got per tab, in memory (the Page tab)
//   toolstab.mjs  the Tools tab: downloads, recordings, hand-offs, the OS opener (files by id), the person's own tabs
//   preview.mjs   read-only previews of downloads (text; Word-type documents on macOS) for the person's tab
//   diagnostics.mjs  the Tools tab's diagnostics and its scrubbed report (nothing is sent)
// First: the test switches go unless the test harness started this helper (test-gate.mjs).
import "./test-gate.mjs";
import net from "node:net";
import { createRequire } from "node:module";
import { rmSync, existsSync, appendFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, loadConfig, ensureDirs } from "./paths.mjs";
import { secretStore } from "./rules/secrets.mjs";
import { createFollow, isScreenPage, screenCard } from "./daemon/follow.mjs";
import { createCaptureBackend, targetIdOf } from "./daemon/capture.mjs";
import { createCaptureChannel } from "./liveview/capture.mjs";
import { createFacts } from "./facts.mjs";
import { BrowserCoordinator, TabClaims } from "./collaboration.mjs";
import { cleanName, displayName } from "./sharing/join.mjs";
import { currentAccount, within, readJson, spend, pidAlive, urlHost } from "./util.mjs";
import { createPopups, CHALLENGE_TURN } from "./popups.mjs";
import { chooseBrowserDriver, patchrightNodeMinimum } from "./driver.mjs";
import { createContext } from "./daemon/context.mjs";
import { contextCount } from "./daemon/exec-contexts.mjs";
import { createHud, appColor, APP_COLORS } from "./daemon/hud.mjs";
import { createPresence } from "./daemon/presence.mjs";
import { createPause, pressPause as pressPauseIn } from "./daemon/pause.mjs";
import { fieldOwner } from "./daemon/fields.mjs";
import { createPanel } from "./daemon/panel.mjs";
import { BROWSER_PAGE_ORIGINS } from "../ui/urls.js";
import { forgetPanelBuild, UNGOOGLED } from "./browser.mjs";
import { createScreenShare } from "./daemon/screenshare.mjs";
import { createRecorder, pixelRatio } from "./daemon/recorder.mjs";
import { createTabLabels } from "./daemon/tablabels.mjs";
import { createRemoteAgents } from "./daemon/remote-agents.mjs";
import { createSharing } from "./daemon/sharing.mjs";
import { createOutput } from "./daemon/output.mjs";
import { createScreenshots } from "./daemon/screenshot.mjs";
import { createServe } from "./daemon/serve.mjs";
import { createJournal } from "./daemon/journal.mjs";
import { createTimeline } from "./daemon/timeline.mjs";
import { createOutlines } from "./daemon/outline.mjs";
import { createSettings } from "./liveview/settings.mjs";
import { createReporter } from "./liveview/report.mjs";
import { createPick } from "./daemon/pick.mjs";
import { nativeDirs, pinnedAsset } from "./native/install.mjs";
import { timelineDir, activityFile, isTemporary } from "./sessions.mjs";
import { createActivityLog } from "./daemon/activitylog.mjs";
import { readFields, applyFields } from "./daemon/forms.mjs";
import { createTabOrder } from "./daemon/taborder.mjs";
import { createCobrowse } from "./daemon/cobrowse.mjs";
import { shareFields, shareableUrl, crossingText, onSecretDomain, personColor } from "./sharing/tabsync.mjs";
import { createBoard, readEntries, readMessage } from "./daemon/board.mjs";
import { createJoinPrompt } from "./daemon/joinprompt.mjs";
import { createClickApprovals, routeConnection } from "./daemon/approvals.mjs";
import { saveFolder } from "./daemon/browser/downloads.mjs";
import { createDownloads, createRecordings, createHandoffs, openFile, createPersonTabs } from "./daemon/toolstab.mjs";
import { createPreviews } from "./daemon/preview.mjs";
import { createDiagnostics, pinnedBrowserVersion } from "./daemon/diagnostics.mjs";
import { engineDir } from "./native/pack.mjs";
import { answerOpen, writeOpener, claimOpener, releaseOpener, registryDir } from "./opener.mjs";
import { bundleIdOfApp } from "./openers.mjs";
import { createVersionHandoff, readUse } from "./handoff.mjs";
import { chooseBrowser, isOpenBrowser } from "./browser/choice.mjs";
import { AGENT_COLOR } from "../ui/vocab.js";
import { testOn, harnessStarted } from "./testenv.mjs";

const require = createRequire(join(paths.runtime, "package.json"));

// How long a stopping helper waits for the browser to close cleanly before killing it (shutdown).
const SHUTDOWN_GRACE_MS = 5000;
const log = (...a) => appendFileSync(paths.daemonLog, `${new Date().toISOString()} ${a.join(" ")}\n`);
const config = loadConfig(paths.config, log); // unknown keys and refused values: logged, and in pairbrowse_status
// Patchright unless the config opts into Playwright, or this Node.js is too old for Patchright.
const driverChoice = chooseBrowserDriver(config, process.versions.node, patchrightNodeMinimum(paths.runtime));
// The runtime (@playwright/mcp and the driver) takes seconds to load on a busy machine: it loads
// right after the socket listens (main), so a bridge that connects meanwhile finds the helper up.
// The first call that needs it before then loads it there and then.
let loadedRuntime = null;
function runtime() {
  if (!loadedRuntime) {
    const { createConnection } = require("@playwright/mcp");
    const { chromium } = require(driverChoice.driver === "playwright" ? "playwright" : "patchright");
    loadedRuntime = { createConnection, chromium };
  }
  return loadedRuntime;
}
const createConnection = (...a) => runtime().createConnection(...a);
ensureDirs();

// One helper at a time, settled before anything else starts: each Claude Code and Codex window
// starts one when there's none (after an update, a crash), often several at once, and a second
// one must never touch the browser, the sharing tunnel or its saved state before it finds out.
const lockFile = paths.daemonLock;
function claimHelper() {
  for (let i = 0; i < 3; i++) {
    try { writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 }); break; } catch (e) {
      if (e.code !== "EEXIST") return true; // no lock possible here: as before (the socket decides)
      let pid = 0, age = Infinity;
      try { pid = Number(readFileSync(lockFile, "utf8")); age = Date.now() - statSync(lockFile).mtimeMs; } catch {}
      // A live helper holds it (still starting, or with its socket up); otherwise it's left over.
      if (pid && pid !== process.pid && pidAlive(pid) && (age < 30_000 || existsSync(paths.socket))) return false;
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

// The Tools tab (the browser's own pages, the owner only; daemon/toolstab.mjs): this session's
// downloads (in memory), the recordings this helper saved (an owner-only index), the hand-offs
// waiting for the person, and diagnostics. Fed from what the helper already sees.
const hostOfUrl = (url) => urlHost(url);
const downloads = createDownloads({ session: () => context.sessionName() });
const recordings = createRecordings();
const handoffs = createHandoffs();
// A file the person opens from Downloads shows in a tab that is theirs alone (context.mjs
// openForPerson; serve.mjs and the live view keep agents and guests out of it). Previews left by
// an earlier run go now.
const personTabs = createPersonTabs();
const previews = createPreviews();
previews.clear();
const HELPER_VERSION = readJson(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"))?.version || "";
const diagnostics = createDiagnostics({
  version: HELPER_VERSION, mask: (t) => output.mask(t), agents: () => clients.size,
  // Never a path, and never a launch for it: the browser open now, if any.
  browser: async () => {
    const inUse = context.browserInUse();
    const engine = inUse === "pairbrowse" ? inUse : isOpenBrowser(inUse) ? "open" : inUse ? "path" : null;
    const version = pinnedBrowserVersion({
      engine,
      nativeRecord: engine === "pairbrowse" ? readJson(nativeDirs().record) : null,
      ungoogled: process.platform === "darwin" ? UNGOOGLED.version : null,
      browsersJson: engine === "open" ? readJson(join(paths.runtime, "node_modules", driverChoice.driver === "playwright" ? "playwright-core" : "patchright-core", "browsers.json")) : null,
    });
    const build = inUse === "pairbrowse" ? readJson(join(engineDir(), "installed.json"))?.version ?? null : null;
    return { engine, version, build };
  },
});
const agentBy = (p, color = "") => ({ label: collaboration.participants.get(p)?.label || "Agent", color: color || hud.sparkColor(p) });
// A download started, finished or failed (context.mjs keepDownloads).
function onDownload({ op, name, page, id, path }) {
  if (op === "start") {
    let by = null;
    try { const a = tabMeta(page)?.agent; if (a) by = { label: a.label, color: a.color }; } catch {}
    const newId = downloads.add({ name, host: hostOfUrl(page?.url?.() || ""), title: "", by });
    within(1000, Promise.resolve(page?.title?.()).catch(() => "")).then((t) => { if (t) downloads.setTitle(newId, t); }).catch(() => {});
    return newId;
  }
  if (!id) return null;
  if (op === "done") downloads.done(id, path);
  else if (op === "failed") downloads.failed(id);
  return id;
}

// The parts below reach each other through these (each is called only once all exist).
const liveView = () => sharing.liveView();
const refreshTabs = () => liveView()?.refreshTabs().catch(() => {});

// Passwords are read live, so one added in the Profile panel works at once. PairBrowse swaps
// them in itself and masks them in everything Claude reads back.
const secrets = secretStore(paths.secrets, log);
const collaboration = new BrowserCoordinator({ untilSeen: true, onChange: (state) => { liveView()?.setCollaboration(state); labelsChanged(); } });
// An agent's name changed (identify): its tab's label follows (tabLabels, below).
function labelsChanged() { try { tabLabels.changed(); } catch {} }
// Per-tab turns (the default); the whole-browser lease above stays for pairbrowse_collaboration.
const tabClaims = new TabClaims({ onChange: refreshTabs });

const panel = createPanel({ context: () => context.current(), liveViewUrl: async () => (await sharing.ensureLiveView()).url, log, onStale: () => forgetPanelBuild(context.profile()), available: () => !context.willHaveBrowserPages() });
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
// perAgent: "Pause this agent" works here (not in a session joined from here); agents: the ones
// paused on their own, by name as the session list shows them.
const pauseState = () => ({ ...pause.view(), can: canPause(), perAgent: !follow.joined(),
  agents: pause.agents().map((a) => ({ who: collaboration.participants.get(a.id)?.label || "Agent", by: a.by, at: a.at })) });
// A person pressed "Pause agents" or "Resume" here (the bar in a page, the side panel, a drive
// guest's viewer). In a session joined from here the host decides, and its state comes back.
// agent: "Pause this agent" (the owner's pages only): every agent here with that name, by its
// connection. Resuming one is always possible; pausing one isn't in a session joined from here.
// In a session joined from here, the global Resume also lets this helper's own per-agent pauses go.
function pressPause(paused, who = HOST, agent = null) {
  return pressPauseIn(pause, {
    paused, who, agent, joined: follow.joined(), canPause, say: (op) => follow.say(op),
    agentIds: (name) => [...collaboration.participants].filter(([, p]) => p?.label === name).map(([id]) => id),
  });
}
const hud = createHud({
  pages: () => context.openPages(),
  waiting: (page) => presence.waiting(page), liveView, notify: panel.notify,
  pause: () => ({ by: pause.view().by, can: canPause() }),
  // An agent handed a step to the person (pairbrowse_status "you"): a hand-off until it moves on.
  onStatus: (p, st) => { if (st?.kind === "you") handoffs.set(`status:${p}`, { text: st.text, page: hud.sparkPage(p) || null, by: agentBy(p, st.color) }); else handoffs.clear(`status:${p}`); },
  // A build with its own pages (the context's browserPages): its docks carry the bottom bar's
  // duties, so pages are told they are docked (DESIGN.md Part G3). The open build: false, no call.
  docked: () => { try { return !!context.browserPages?.(); } catch { return false; } },
});
const presence = createPresence({
  host: HOST, readEvents: (frame, waitMs) => hud.call(frame, String(waitMs), "user-wait"), pages: () => context.openPages(), paused: () => context.isSwitching(),
  onUsed: (page) => context.touch(page), onStale: bumpRevision, applyBar: hud.applyBar, refreshTabs, restoring: () => context.isRestoring(),
  onPauseButton: (kind) => pressPause(kind === "pause"),
  onActing: (on) => liveView()?.setDriving?.(on),
});
const popups = createPopups({
  log,
  quiet: () => context.isRestoring(), // tabs reopened at startup aren't new
  cookieChoice: () => config.cookieChoice, // "accept" (default) or "reject"; Settings can change it
  agentActing: () => presence.agentActing(), // a tab an agent closes itself needs no note
  onYourTurn: (text, page) => { hud.setBadge(text, "you").catch(() => {}); handoffs.set("check", { text, page: page || null, kind: "captcha", by: { label: "PairBrowse", color: "" } }); },
  // The check is done: take "Your turn" down again if it was this one.
  onCleared: () => { if (hud.badge().text === CHALLENGE_TURN) hud.setBadge("", "clear").catch(() => {}); handoffs.clear("check"); },
});
const context = createContext({
  personTabs,
  config, log, chromium: () => runtime().chromium, driver: driverChoice.driver, hud, presence, popups, hostNote, notify: (text) => panel.notify(text),
  // A person renamed the session: the timeline's last writes land first, then the goal log follows.
  beforeRename: () => { activityLog.flush(); return timeline.settled(); }, onRenamed: (from, to) => journal.renamed(from, to),
  liveOthers: () => liveView()?.joinersNow() || [], // people who joined this session, there now
  onTabClosed: (page) => { tabClaims.drop(page); screenshots.forgetPage(page); hud.forgetPage(page); handoffs.forgetPage(page); }, // a closed tab's turn ends with it, with the maps onto its pictures and the sparks on it
  status: (badge) => liveView()?.setStatus(badge),
  onDownload,
  shuttingDown: () => shuttingDown,
  // A build with its own pages: their origins are let in before the browser starts (their first
  // requests pass), and they get the live view's address in its switch and their own key in an
  // owner-only file (context.mjs writes it and deletes it once used).
  helperFor: async () => {
    for (const o of BROWSER_PAGE_ORIGINS) if (!panel.origins.includes(o)) panel.origins.push(o);
    try {
      const v = await sharing.ensureLiveView();
      return { origin: new URL(v.url).origin, key: v.pagesKey, newCaptureKey: (on) => v.newCaptureKey?.(on) ?? null };
    } catch (e) { log("live view", e?.message || e); return null; }
  },
  onStarted: () => {
    registerOpener();
    liveView()?.setSession(context.sessionInfo());
    // The side panel extension gets the live view's address through its worker; the browser's own
    // pages already have the address in its switch and their own key in an owner-only file.
    if (!context.browserPages()) setTimeout(() => panel.connect().catch((e) => log("side panel", e?.message || e)), 0);
  },
  // The window is gone: end the sessions (the bridge reconnects and reopens the browser on the next
  // action), or shut down if nobody is connected.
  onClosed: () => {
    // The host closed the window: sharing ends with it (codes, yeses, tunnels). A restart of the
    // helper closes it too, but keeps them.
    if (!shuttingDown) sharing.endAll();
    previews.clear(); // their tabs went with the browser
    recorder.browserClosed();
    captureChannel.reset(); // the capture page went with the browser
    sharing.closeLiveView();
    // The agents' connections end a moment later: each session's browser server was bound to the
    // browser that closed (a fresh connection gets the next one), and the answer to a call that
    // was in flight ("the browser closed while this ran") goes out first.
    if (clients.size) { const gone = [...clients.values()]; setTimeout(() => { for (const sock of gone) sock.destroy(); }, 150); } // the ones there now, never a connection made meanwhile
    else shutdown(0);
  },
});
// the grace-timeout exit too: the browser's key file never outlives the helper
process.on("exit", () => { context.dropHelperKey(); previews.clear(); });
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
  const agent = localAgent(page) || (remote ? { label: remote.label, color: remote.color || appColor(remote.label) || APP_COLORS.claude, joined: true } :
    theirs && Date.now() < theirs.until ? { label: theirs.label, color: theirs.color || AGENT_COLOR, joined: true, from: theirs.from, until: theirs.turnUntil } : null);
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
  for (const [id, p] of collaboration.shown()) {
    const page = hud.sparkPage(id);
    const st = session.statusOf(id);
    out.push({ who: p.label, kind: "agent", color: hud.sparkColor(id), tab: page && !page.isClosed() ? (shareableUrl(page.url()) || "").replace(/^https?:\/\//, "") : "",
      task: st?.text || "", status: st?.text ? STATUS_OF[st.kind] || "working" : "idle", last: lastActions.get(p.label) || "" });
  }
  return out;
}
// The session's activity log (GET activity.json, owner only): kept as long as the helper runs,
// so a browser restart keeps it; a kept session's in its folder, a clean session's in memory.
// The bar's lines reach it through the live view; the session's messages from here (below).
const activityLog = createActivityLog({ where: () => { const name = context.sessionName(); return { name, file: isTemporary(name) ? null : activityFile(name) }; }, mask: output.mask, log });
const session = createBoard({
  locals: localEntries,
  secrets: () => secrets.get().values || {},
  labelOf: (p) => collaboration.participants.get(p)?.label || "Agent",
  onChange: () => sessionChanged(),
  // What an agent on the other side took up shows in the bottom bar and activity here too.
  onRemoteTask: (source, who, task) => hud.addActivity(`Now: ${task}`, who, null, source === "host" ? "joined" : source),
  // Each message, sent here or received, is a line in the Activity page's history too, at this
  // helper's time (another side's clock never moves the log's rising times).
  onMessage: (msg) => activityLog.add({ kind: "message", who: msg.from, to: msg.to, text: msg.text }),
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
// In a build with its own pages, the tab strip reports the tab order and moves tabs (POST
// tab-order, the tab-order event): the side panel's worker isn't asked there.
const tabOrder = createTabOrder({
  call: (fn, arg, ms) => panel.call(fn, arg, ms), getContext: () => context.getContext(), log,
  strip: { ownPages: () => context.browserPages(), snapshot: () => liveView()?.stripTabs?.() ?? null, arrange: (targets) => liveView()?.sendToPages?.("tab-order", { op: "arrange", targets }) },
});

// Where tabs are captured for joiners and recordings (daemon/capture.mjs): the side panel
// extension, the browser's own capture page (its channel: liveview/capture.mjs), or nowhere.
const captureChannel = createCaptureChannel({ send: (data) => liveView()?.sendToPages?.("capture", data), log });
const capture = createCaptureBackend({ browserPages: () => context.willHaveBrowserPages(), capturePages: () => context.willHaveCapturePages(), panelCall: (fn, arg, ms) => panel.call(fn, arg, ms), channel: captureChannel });
// Shared browser mode: joiners see this browser's tabs live and work in them (daemon/screenshare.mjs).
const screens = createScreenShare({ call: (fn, arg, ms) => panel.call(fn, arg, ms), log, during: (who) => presence.remoteStart(who), capture });
// Recording the browser to a video (pairbrowse_record, the side panel's Record button).
const recorder = createRecorder({
  capture,
  call: (fn, arg, ms) => panel.call(fn, arg, ms), log,
  owners: () => hud.sparkList().map((s) => ({ page: s.page, who: collaboration.participants.get(s.id)?.label || "Agent", color: s.color })),
  dir: () => { const { dir, problem } = saveFolder(config); if (problem) log(`recordings folder: ${problem}`); if (!dir) throw new Error(`no folder recordings may go to (${problem})`); return dir; },
  scale: async () => pixelRatio(await context.openPages()),
  changed: () => { const s = recorder.state(); liveView()?.setRecord(s); hud.setRecording(s.recording); },
  onSaved: (saved) => recordings.add(saved), // the Tools tab's Recordings (an owner-only index)
  onActivity: (fn) => hud.onActivity((text, who, page, from) => { if (who && page) fn(text, who, page, from); }),
});
// Who works in which tab, named on the tab strip (the agent's name in front of the tab's title).
const tabLabels = createTabLabels({ sparks: () => hud.sparkList(), labelOf: (id) => collaboration.participants.get(id)?.label || "Agent", lastIn: (page) => hud.lastIn(page), name: (page, text) => hud.call(page, text, "tab-name").catch(() => {}), log });
// A spark moved: the tab names, and the board (each agent's tab is its spark's), so both docks
// read where an agent is from the same state.
hud.onSparks(() => { tabLabels.changed(); sessionChanged(); });
hud.onActivity((_text, who, page) => { if (who && page) tabLabels.changed(); });
// ...and a joiner's own agent works here as a participant (serve, below), files only from its side.
const remoteAgents = createRemoteAgents({ serve: (sock, opts) => serve(sock, opts), dir: join(paths.uploads, "remote"), log });
const sharing = createSharing({
  config, log, host: HOST, notify: panel.notify, hostNote, joinAlert: (entry) => joinPrompt.alert(entry),
  view: {
    secretDomains, screens, remoteAgents, capture: captureChannel,
    // The live view's Timeline (owner only). `journal` is declared further down: this runs only
    // when the route is hit, after startup, so it is always there by then.
    journal: () => journal.read(),
    // The session's timeline of pictures, and the masking and docks' layout the browser's own pages
    // get (owner only). `timeline` is declared further down too: read when the live view starts.
    get timeline() { return timeline; },
    // The Page tab's outline (owner only); declared further down too.
    get outlines() { return outlines; },
    // The session card (owner only): rename and Save, and whether each is possible now. Rename
    // restarts the browser on the renamed session (a saved one that isn't open: no restart); Save writes its tabs now (tabs.mjs saveNow,
    // the write a person's session switch makes; run_save is the agent's tool and would merge
    // its goal log) and brings the goal log's pending write forward.
    sessionOps: {
      state: () => { const name = context.sessionName(); return { canRename: name !== "default" && !isTemporary(name) && !follow.joined(), canSave: !isTemporary(name), savedAt: journal.savedAt(), canRenameSaved: true }; },
      // from: a saved session that isn't open (the sessions page): renamed in place, nothing restarts.
      current: () => context.sessionName(),
      rename: (name, from) => (from !== undefined && from !== context.sessionName() ? context.renameSaved(from, name)
        : follow.joined() ? { error: "You joined another session from here; rename this one once you have left it." } : context.renameCurrent(name)),
      save: async () => {
        const r = await context.saveTabs();
        if (r.error) return r;
        await journal.flushNow().catch(() => {});
        return { ok: true, savedAt: journal.savedAt() };
      },
    },
    mask: output.mask, layoutDefaults: () => config.layout,
    // The session's activity log (GET activity.json, owner only; above).
    activityLog,
    // The browser's Settings page: which browser runs, the timeline, the docks' default layout
    // (liveview/settings.mjs; written into config.json and the running config).
    settings: createSettings({ config, choiceConfig: () => context.choiceConfig(), native: !!pinnedAsset(), settingsSection: () => !!context.nextShell().settingsSection, browserInUse: () => context.browserInUse() }),
    // Report a problem: relayed to config.json's reportUrl on the person's click (liveview/report.mjs).
    reporter: createReporter({ url: () => config.reportUrl, mask: output.mask, log }),
    // Refs go stale when a person there did something (elsewhere() says so) or a tab changed there;
    // their pointer alone, or just being in the tab, leaves the page as it was.
    // Their mark (a dot in their pointer's color) shows on the tab's icon here while they're in it.
    onJoinerPerson: (page, who, did, acting, changed = false, ago = 0, heardAt = Date.now()) => { presence.elsewhere(page, who, did, acting, ago, heardAt); hud.setPersonMark(page, personColor(who)); if (changed) bumpRevision(page); },
    onPause: (paused, who, agent) => pressPause(paused, who || HOST, agent || null), pauseState,
    onRecord: (on) => (on ? recorder.start() : recorder.stop()), recordState: () => recorder.state(),
    // A joiner's agent at work in their copy of a tab: in use, so the tab cap here keeps it (closing
    // it would close their copy too).
    onJoinerActivity: (page, text, who, from) => { context.touch(page); hud.addActivity(text, who, page, from); },
    extraOrigins: panel.origins, getContext: () => context.getContext(), currentUrl: () => context.currentUrl(), profile: facts.profile, tabMeta,
    onHumanInput: (page, who, changes = true) => { presence.humanIn(page, who || HOST); if (changes) bumpRevision(page); },
    onReplay: (who) => presence.replayStart(who), // the live view's input never answers a join prompt; an invite viewer's is theirs
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
          if (!spend(j, "messages", 10, { windowMs: 60_000 })) return { problem: "At most 10 messages a minute." };
          session.receive(msg);
          liveView()?.pushToJoiners("message", msg, { except: key });
        }
        return {};
      },
      onJoinerAgent: (page, who, color, left = 0, from = "", where = "") => {
        if (who) { joinedAgents.set(page, { label: who, color, until: Date.now() + JOINED_AGENT_MS, turnUntil: left > 0 ? Date.now() + left : 0, from, where }); context.touch(page); } else joinedAgents.delete(page);
        hud.setSharedSpark(page, who ? color || AGENT_COLOR : "");
        refreshTabs();
      },
    },
    status: () => hud.badge(), session: () => context.sessionInfo(), collaboration: () => collaboration.state(),
    // Named final clicks asked in the browser (owner only). Declared further down: read when the
    // live view starts, after startup.
    get clickApprovals() { return clickApprovals; },
    picker: { state: () => context.pickerState(), pick: (op) => picks.pick(op), open: () => context.reopenPicker() },
    // the first request a browser page makes with its key: the key file has done its job
    onPagesKey: () => context.dropHelperKey(),
    // A press in the browser's own pages, the side panel or the live view's controls (no page script there): a person.
    onPersonInput: () => context.personUsed(),
    // A join code's address the person hasn't allowed: their answer from the side panel or picker.
    joinHost: { state: () => follow.hostState(), act: (op) => picks.hostDecision(op) },
    // The Tools tab (owner only): files by id; Open and Reveal through the OS opener, on a click.
    // A download opens in the person's own tab where the browser renders it, as a preview there,
    // or with its app (liveview.mjs fileAction).
    tools: { downloads, recordings, handoffs, diagnostics, open: (p, how) => openFile(p, how),
      personTab: (p) => personTabs.has(p), engine: () => context.browserInUse(), platform: process.platform,
      openTab: (url, onClose) => context.openForPerson(url, { onClose }), preview: (e, kind) => previews.make(e, kind) },
  },
});
// Sessions joined from here: their tabs, followed in this browser.
const follow = createFollow({
  config, log, context, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent, mask: output.mask,
  onSession: (data, join) => {
    session.setRemote("host", crossingEntries(data?.entries), String(data?.where || join.host));
    if (data?.pause && typeof data.pause === "object") pause.mirror({ paused: data.pause.paused === true, by: String(data.pause.by || ""), resumedBy: String(data.pause.resumedBy || "") });
  },
  // Out of the session: a pause from there no longer holds the agents here.
  onLeft: () => pause.mirror({ paused: false, resumedBy: HOST }),
  note: hostNote,
  onMessage: (data) => session.receive(readMessage(data)),
  onHostChange: (state) => liveView()?.setJoinHost(state),
  // The approve role: the host's approval cards this side may answer (declared below; called later).
  onApprovals: (data) => clickApprovals.fromHost(data),
});
// A join request: the bottom bar in the host's tab in front asks (Allow / Deny) while the browser
// has the focus, else a notification with Allow / Deny (daemon/joinprompt.mjs).
let testFocus = null; // tests only (PAIRBROWSE_TEST_JOIN_PROMPT=1): true or false in place of the browser's own
// The tab in front in the host's browser, or null when it can't be told.
async function frontPage() {
  const page = await tabOrder.front().catch(() => null);
  if (page) return page;
  const pages = (await context.openPages()).filter((p) => !p.isClosed());
  return pages.length === 1 ? pages[0] : null; // the side panel couldn't say: only when there's no doubt
}
const joinPrompt = createJoinPrompt({
  approvals: sharing.approvals, log, show: hud.call, byPerson: presence.byPerson,
  notify: panel.notifyJoin, clear: panel.clearJoin,
  focused: async () => (testFocus !== null ? testFocus : tabOrder.focused()),
  front: frontPage,
});
// A named final click asked in the browser as well as in the agent's app (daemon/approvals.mjs).
// Docked (the browser's own pages), its approve page is the window's approval card; the tab's
// target id says which window.
const clickApprovals = createClickApprovals({ hud, presence, collaboration, liveView, frontPage, docked: () => !!context.browserPages?.(), targetOf: targetIdOf, mask: output.mask, log, hostName: () => HOST,
  // A session joined from here with the approve role: the host's asks on its picture pages, answers sent back on the channel.
  screen: { pages: () => follow.screenPages(), call: screenCard }, sendAnswer: (id, answer) => follow.answerApproval(id, answer) });
// Who used each session, for the session picker: joiners the host let in. A joiner let in also
// takes any approval card in the page down at once (approvals.mjs cover).
sharing.approvals.onChange(() => {
  let approved = false;
  for (const e of sharing.approvals.list()) if (e.state === "approved") { approved = true; context.recordPerson({ who: e.name, app: e.app, computer: e.computer, kind: "guest" }); }
  if (approved) clickApprovals.cover();
});
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
    const v = value.me && presence.othersMove(Number(value.me.t)) ? { ...value, me: null } : value; // an agent's, a joiner's (shared browser) or an invite viewer's moves are not the host's pointer
    liveView()?.pointed(page, v);
    follow.pointed(page, v);
  },
  onDirty: (page) => { liveView()?.fieldsChanged(page); follow.dirty(page); },
});
hud.onCursor((page, at) => { liveView()?.agentPointed?.(page, at); presence.agentPointed(page, at); });
// The goal log the helper keeps by itself (a run file per session; daemon/journal.mjs).
const journal = createJournal({ session: () => context.sessionName(), openPages: () => context.openPages(), mask: output.mask, strip: (t) => tabLabels.strip(`Page Title: ${t}`).replace(/^Page Title: /, ""), onActivity: (fn) => hud.onActivity(fn), log });
// The session's timeline: the pictures already sent to agents, kept per session (daemon/timeline.mjs).
// The Page tab's outline: the last whole-page snapshot a local agent got per tab (daemon/outline.mjs).
const outlines = createOutlines({ mask: output.mask });
const timeline = createTimeline({ dir: () => timelineDir(context.sessionName()), enabled: () => config.timeline !== false, cap: () => config.timelineCap, mask: output.mask, step: () => journal.step(), onNote: (text) => hud.addActivity(`Note: ${text}`, HOST, null), log });
const serve = createServe({
  // A fast-mode run's hand-off step (runner "handoff"): a hand-off for that tab until the step ends.
  onRunStatus: (p, text, kind, page, label) => { if (kind === "you") handoffs.set(`run:${p}`, { text, page: page || null, by: { label: label || "Agent", color: hud.sparkColor(p) } }); else handoffs.clear(`run:${p}`); },
  config, log, host: HOST, createConnection, clients, collaboration, tabClaims, context, hud, presence, popups, output, screenshots,
  secrets, facts, sharing, follow, pause, remoteHolder, personTabs, reconnecting: (except) => liveView()?.reconnecting?.(except) || null, front: () => tabOrder.front(4000), drainHostNotes: () => hostNotes.splice(0), revision: () => revision, bumpRevision, session, shareMessage, recorder, tabNames: tabLabels, journal, timeline, clickApprovals, outlines, updateNote: () => handoff.note(),
  // Tests only (PAIRBROWSE_TEST_TAB_ORDER=1): read and move tabs in the strip, as a person would
  // by dragging them; no app gets this tool otherwise.
  testTools: {
    // Tests only (PAIRBROWSE_TEST_MEMORY=1): how many listeners the browser has for its own end,
    // which grows with every session that came and went if their servers' listeners are kept.
    ...(testOn("MEMORY") ? { pairbrowse_test_memory: async (args = {}) => {
      const ctx = await context.current();
      globalThis.gc?.(); // with --expose-gc (the bench): what's reachable, not what's waiting to be collected
      // heap: a file path under the helper's home: a V8 heap snapshot is written there (leak hunts).
      if (typeof args.heap === "string" && args.heap && resolvePath(args.heap).startsWith(paths.home + sep)) (await import("node:v8")).writeHeapSnapshot(resolvePath(args.heap));
      const m = process.memoryUsage();
      return { text: JSON.stringify({ close: ctx?.listenerCount("close") ?? -1, disconnected: ctx?.browser?.()?.listenerCount("disconnected") ?? -1, contexts: ctx ? contextCount(ctx) : -1, screenshots: screenshots.held().size, clients: clients.size, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers }) };
    } } : {}),
    ...(testOn("TAB_ORDER") ? { pairbrowse_test_tab_order: (args) => tabOrder.testCommand(args) } : {}),
    // Tests only (PAIRBROWSE_TEST_JOIN_PROMPT=1): the join request in each tab's bottom bar, and
    // clicks on it as a person would (a trusted click), as an agent's or a joiner's input would,
    // or as a page script would (synthetic events); the browser's focus set (focus: true, false,
    // or "real"); the requests with a notification up (notes).
    ...(testOn("JOIN_PROMPT") ? { pairbrowse_test_join_prompt: async (args = {}) => {
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
    // Tests only (PAIRBROWSE_TEST_APPROVAL=1): the approval card in each tab, clicks on it as a
    // person, an agent, a joiner, the live view or a page script would make them, the pointer moved
    // away, and the approvals waiting.
    ...(testOn("APPROVAL") ? { pairbrowse_test_approval: async (args = {}) => {
      // Every await on a page is bounded (a page whose scripts never pause answers nothing): no
      // answer in time is said as such rather than holding the call.
      const silent = { text: "no answer from the page", error: true };
      const state = (p) => within(2000, Promise.resolve(hud.call(p, "", "approval-state")).catch(() => []));
      const pages = (await context.openPages()).filter((p) => !p.isClosed());
      if (args.pending) return { text: JSON.stringify(clickApprovals.pending()) };
      if (args.move) {
        const p = await within(3000, frontPage().catch(() => null));
        if (p && (await within(2000, p.mouse.move(5, 5).then(() => true, () => true))) === null) return silent;
        return { text: "moved" };
      }
      if (!args.click) return { text: JSON.stringify(await Promise.all(pages.map(async (p) => ({ url: p.url(), rows: (await state(p)) || [] })))) };
      const page = await within(3000, frontPage().catch(() => null));
      if (!page) return { text: "no card", error: true };
      const rows = await state(page);
      if (rows === null) return silent;
      const row = (rows || [])[0];
      if (!row || !row[args.click]) return { text: "no card", error: true };
      const { x, y } = row[args.click];
      if (args.as === "page") {
        const ok = await within(2000, page.evaluate(([cx, cy]) => { const el = document.elementFromPoint(cx, cy); for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el?.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, detail: 1, clientX: cx, clientY: cy })); }, [x, y]).then(() => true, () => true));
        return ok === null ? silent : { text: "page clicked" };
      }
      const done = args.as === "agent" ? presence.busyStart() : args.as === "joiner" ? presence.remoteStart("Eve") : args.as === "liveview" ? presence.replayStart() : () => {};
      let ok;
      try { ok = await within(3000, page.mouse.click(x, y).then(() => true, () => true)); } finally { done(); }
      return ok === null ? silent : { text: "clicked" };
    } } : {}),
    ...(testOn("SCREEN") ? { pairbrowse_test_screen: async (args = {}) => { const { expr, type, choose } = args;
      // at: a picture page by its place among the tabs (list gives them); else the first one.
      const all = (await context.getContext()).pages();
      const page = follow.pages().find((p) => !p.isClosed() && isScreenPage(p.url()) && (!Number.isInteger(args.at) || all.indexOf(p) === args.at));
      if (!page) return { text: "no picture page", error: true };
      if (Array.isArray(choose)) { page.once("filechooser", (fc) => fc.setFiles(choose.map(String)).catch(() => {})); return { text: "will choose" }; }
      if (args.shot) { await page.screenshot({ path: String(args.shot) }); return { text: "saved" }; }
      // clickAt: a person's click at that point of the picture page (CSS pixels of its window).
      if (args.clickAt) { await within(5000, page.mouse.click(Number(args.clickAt.x) || 0, Number(args.clickAt.y) || 0)); return { text: "clicked" }; }
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
    ...(testOn("PANEL") ? { pairbrowse_test_panel: async (args = {}) => {
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
// The person's session choices from the browser's own pages (POST pick, POST joinhost): the
// picker at start, the switcher and the new tab page's chips while a session is open (asking first
// while other agents are at work), the sessions page's Delete (daemon/pick.mjs).
const picks = createPick({
  context, follow, log, hostNote,
  activeAgents: () => serve.activeAgents(),
  busy: () => { const s = inUse(); return s.people ? "People are in this session; switch once they have left." : s.recording ? "Stop the recording first." : s.approvals ? "An approval is waiting; answer it first." : null; },
});
// What uses the helper now (handoff.mjs busyReason): a newer bridge's hello restarts it only without any.
const inUse = (lv = liveView()) => readUse({ agents: clients.size, view: lv, follow, recorder, approvals: clickApprovals, downloads, presence, context });
const handoff = createVersionHandoff({ own: HELPER_VERSION, state: inUse, stop: () => shutdown(0), lock: lockFile, log });
output.start();

// The opener registry (plans/555 D6.2a, opener.mjs claimOpener): this helper's record for the
// native build it launches, named by that build's bundle id, so that build opened by hand comes
// to this helper (an instance, another home) and not the default home's. Written once the socket
// listens and again after each launch (a first install, a changed "browser"); another running
// helper's record is left alone; removed at a clean stop.
const openScript = join(dirname(fileURLToPath(import.meta.url)), "open.mjs");
const registry = { name: null, dir: null };
function launchedBundleId() {
  const choice = context.choiceConfig?.() || config;
  const spec = chooseBrowser(choice, { native: !!pinnedAsset(), pinnedExec: () => nativeDirs().exec });
  const exec = spec.binary === "native" ? (spec.executablePath || nativeDirs().exec) : spec.executablePath;
  return exec ? bundleIdOfApp(exec) : null;
}
async function registerOpener() {
  if (process.platform !== "darwin" || shuttingDown) return;
  try {
    const name = launchedBundleId();
    registry.dir ??= registryDir({ harness: harnessStarted() });
    if (registry.name && registry.name !== name) { releaseOpener(registry.name, { dir: registry.dir }); registry.name = null; }
    if (!name) return;
    const r = await claimOpener(name, { dir: registry.dir, script: openScript });
    if (r === "written") registry.name = name;
    else if (r === "kept" && registry.name !== name) log(`opener: another running helper holds the ${name} record; that build opened by hand goes to it`);
  } catch (e) { log(`opener registry: ${e?.code || e?.message || e}`); }
}

async function shutdown(code) {
  if (shuttingDown) return;
  if (registry.name) { try { releaseOpener(registry.name, { dir: registry.dir }); } catch {} }
  // No new connections and no new browser while closing: a client that reconnects at once
  // would otherwise start the browser again inside a helper that's on its way out.
  shuttingDown = true;
  socketServer?.close();
  journal.flushNow().catch(() => {}); // the goal log's last lines
  activityLog.flush(); // the activity log's last lines
  // Join codes outlive a restart: their tunnels keep running for the next run (sharing.mjs); a
  // tunnel kept idle for a next code ends with the helper.
  sharing.suspend();
  // Joiners' channels end before the browser closes: its tabs closing isn't the host closing them,
  // and joiners keep their copies.
  sharing.closeLiveView();
  follow.stop().catch(() => {});
  cobrowse.stop();
  screens.close().catch(() => {}); // joiners' direct connections and the tabs' debugger sessions
  // The browser gets a clean close (the engine writes its cookies and logins on the way out; it
  // writes them only every ~30 s otherwise), at most SHUTDOWN_GRACE_MS: then the helper exits
  // and Playwright's exit handler kills what's left of it.
  const started = Date.now();
  setTimeout(() => { log(`shutdown: the browser didn't close within ${SHUTDOWN_GRACE_MS} ms; killing it`); process.exit(code); }, SHUTDOWN_GRACE_MS).unref();
  await context.close({ deadline: started + SHUTDOWN_GRACE_MS });
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
  // An agent's connection, or a single line: a PairBrowse hook's (an approval asked in the browser)
  // the opener's (the browser opened by hand, scripts/open.mjs) or a bridge's version (handoff.mjs).
  socketServer = net.createServer((sock) => shuttingDown ? sock.destroy() : routeConnection(sock, {
    onHook: (s, line) => answerOpen(s, line, () => context.openByHand(), log) || handoff.answer(s, line)
      || clickApprovals.hook(s, line).catch((e) => { log("approval hook", e?.message || e); s.destroy(); }),
    onOther: (s) => serve(s).catch((e) => { log("session error", e?.stack || e); s.destroy(); }),
  }));
  socketServer.listen(paths.socket, () => {
    log(`listening on ${paths.socket}`);
    // The PairBrowse browser opened by hand runs this helper's opener (scripts/opener.mjs): the
    // record names this Node and this copy's script, rewritten at each start.
    if (process.platform !== "win32") {
      try { writeOpener({ script: openScript }); } catch (e) { log(`opener: ${e?.code || e?.message || e}`); }
      registerOpener();
    }
    const socketAt = Math.round(performance.now());
    setImmediate(() => {
      try { runtime(); } catch (e) { log(`the runtime didn't load: ${e?.stack || e}`); shutdown(1); return; }
      log(`startup: socket after ${socketAt} ms, runtime after ${Math.round(performance.now())} ms`);
    });
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));
  // A promise nobody caught (a page that closed under a background read, a joiner's channel
  // dropping mid-send) is logged and the helper goes on: Node would otherwise end the process,
  // killing the browser before it wrote its cookies. A thrown error outside any handler is a bug
  // the helper can't reason about: logged, then a clean shutdown (the browser closes properly and
  // the bridges reopen it on the next action).
  process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e?.stack || e}`));
  process.on("uncaughtException", (e) => { log(`uncaught exception: ${e?.stack || e}`); shutdown(1); });
}

if (process.argv[1]?.endsWith("daemon.mjs")) main();
