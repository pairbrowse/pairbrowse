// The browser itself: launching it (and the native PairBrowse build), the pages it opens, the
// tabs it brings back, downloads, the tab cap, switching between browser sessions and the browser
// profile each starts on. This is the facade over its parts: browser/{state,launch,downloads,tabs}.mjs,
// sessions/{picker,switch,profiles}.mjs.
import { currentSession } from "../sessions.mjs";
import { createPersonTabs } from "./toolstab.mjs";
import { where } from "./where.mjs";
import { createDownloads } from "./browser/downloads.mjs";
import { createBrowserState } from "./browser/state.mjs";
import { createSupervisor } from "./browser/supervise.mjs";
import { createTabs, stopRequestMirroring } from "./browser/tabs.mjs";
import { createLaunch, browserPagesIn, capturePagesIn, captureKeyedIn, settingsSectionIn, quietTabsIn, measuringLog, MEASURING_STATUS } from "./browser/launch.mjs";
import { createPicker } from "./sessions/picker.mjs";
import { createSwitch } from "./sessions/switch.mjs";
import { createProfiles } from "./sessions/profiles.mjs";

export { stopRequestMirroring, measuringLog, MEASURING_STATUS };
// Where the browser runs ("Local", or "Server" over SSH): daemon/where.mjs.
export { where };

// hud, presence, popups: the other parts that watch each page. hostNote(text): a note for the
// host's agent's next result. onTabClosed(page). status(badge): the live view's status line.
// shuttingDown(): no new browser then. onStarted(ctx) / onClosed(): the browser came up / went
// away by itself (not for a session switch).
// liveOthers(): who else is in this browser's session right now ({ who, app, computer }).
// browserPagesOf(config): whether the browser it launches has its own pages. helperFor(): the live view's
// { origin, key } for those pages (started then), or null: the address goes in its launch switch,
// the key in an owner-only file named by the other switch, deleted on first use (dropHelperKey).
// beforeRename(): awaited before a rename moves the session's files (the timeline's last writes).
// onRenamed(from, to): the session was renamed (the goal log follows).
// onRestored(): saved tabs came back after a launch (browser/tabs.mjs); onCrashLoop(): the crash-loop
// guard stopped launches (browser/supervise.mjs). Both: yourturn.mjs, spec server-mode B16.
// network: the session's proxy at each launch (daemon/network.mjs createNetwork; null: direct, tests).
// profileStore: the browser profile store each launch reads its session's profile from
// (profiles/store.mjs createProfileStore; null: the helper home's own, sessions/profiles.mjs).
// ensureNativeBuild: the native build's install and check (native/install.mjs ensureNative; tests).
// onDownload({ op: "start", name, page }) -> id, then { op: "done", id, path } or { op: "failed", id }:
// the Tools tab's Downloads (daemon/toolstab.mjs), in memory only.
// personTabs: the person's own tabs (daemon/toolstab.mjs createPersonTabs), shared with serve.mjs:
// openForPerson opens one, and no agent's fallback tab is ever one.
export function createContext({ personTabs = createPersonTabs(), config, log, chromium, driver = "patchright", hud, presence, popups, hostNote, onTabClosed, status, shuttingDown, onStarted, onClosed, liveOthers = () => [], notify = () => {}, browserPagesOf = browserPagesIn, capturePagesOf = capturePagesIn, captureKeyedOf = captureKeyedIn, settingsSectionOf = settingsSectionIn, quietTabsOf = quietTabsIn, helperFor = async () => null,
  beforeRename = async () => {}, onRenamed = () => {}, onDownload = () => null, phishing = null, onRestored = () => {}, onCrashLoop = () => {}, network = null, profileStore = null, ensureNativeBuild }) {
  const st = createBrowserState({ session: currentSession(), pick: null }); // browser/state.mjs
  // What the browser's parts (browser/*.mjs, sessions/*.mjs) are given, and the functions they
  // read from each other when called (api).
  const deps = { personTabs, config, log, chromium, driver, hud, presence, popups, hostNote, onTabClosed, status, shuttingDown, onStarted, onClosed, liveOthers, notify, phishing,
    browserPagesOf, capturePagesOf, captureKeyedOf, settingsSectionOf, quietTabsOf, helperFor, beforeRename, onRenamed, onRestored, onCrashLoop, network, profileStore, ensureNativeBuild };
  const api = {};
  // The virtual screen the browser runs on, when this machine needs one (browser/supervise.mjs).
  // With server.keepAlive, the browser kept up with nobody connected.
  const { stopScreenNow, crashLoop, statusParts: screenParts, keepAlive, keepAliveStart, isServer } = Object.assign(api, createSupervisor(st, deps, api));
  // The browser profile each launch starts on: assignment, binding, engine, mapping (sessions/profiles.mjs).
  const profiles = api.profiles = createProfiles(st, deps);
  // Launching the browser and getContext() (browser/launch.mjs).
  const { dropHelperKey, choiceConfig, profile, getContext, watchClose, ready, reset, openByHand, close, nextShell, graphicsStatus, graphicsSummary } = Object.assign(api, createLaunch(st, deps, api));
  // Downloads: kept in the Downloads folder, and Playwright's temporary ones forgotten (browser/downloads.mjs).
  Object.assign(api, createDownloads({ personTabs, config, hostNote, log, onDownload, profile }));
  // The tabs: finding them, the cap, what watches each page, saved tabs coming back (browser/tabs.mjs).
  const { findPage, openPages, pageAt, touch, successorOf, takeRestoredActive, openForPerson } = Object.assign(api, createTabs(st, deps, api));
  // The session picker (sessions/picker.mjs): sets st.pick.
  const { reopenPicker, waitForPick, pickerState, pickSession, pickedJoin, switchForPerson, agentChose, recordPersonHere } = Object.assign(api, createPicker(st, deps, api));
  // Switching, renaming and saving sessions, pairbrowse_session (sessions/switch.mjs).
  const { sessionInfo, renameCurrent, renameSaved, saveTabs, sessionCommand, startUp } = Object.assign(api, createSwitch(st, deps, api));

  return {
    // The shell of the browser in use (browser/choice.mjs: "extension" or "pages", with its
    // capture page or not), and its parts as they were read before (aliases).
    shell: () => st.shell,
    browserPages: () => st.ownPages,
    capturePages: () => st.capture,
    // The same, before the browser has started too (what it will be once it runs): an invite made
    // first says what the share will really carry.
    nextShell,
    willHaveBrowserPages: () => nextShell().ownPages,
    willHaveCapturePages: () => nextShell().capturePage,
    openForPerson, isPersonTab: (p) => personTabs.has(p), openByHand,
    // The browser of the window open now ("pairbrowse", "pairbrowse-open" or a path), null when none is.
    browserInUse: () => (st.contextPromise ? st.inUse : null),
    // The settings the choice is read from (config with the older names as the person wrote them).
    choiceConfig,
    getContext, watchClose, current: () => st.contextPromise, reset, profile, openPages, findPage, pageAt, ready, takeRestoredActive, touch,
    isRestoring: () => st.restoring !== null, isSwitching: () => st.switching,
    // The browser is on its way up: launching, reopening saved tabs, or between two sessions.
    starting: () => st.launching || st.restoring !== null || st.switching || !!st.pickSwitch,
    // A person used the browser where the page script never runs (personUsed: the browser's own
    // pages and the side panel, through the live view); personAt: when, last (0 for never).
    personUsed: (t = Date.now()) => { st.personAt = Math.max(st.personAt, Math.min(Number(t) || 0, Date.now())); },
    personAt: () => st.personAt,
    currentUrl: () => st.lastCurrentUrl, setCurrentUrl: (url) => { st.lastCurrentUrl = url; },
    sessionInfo, sessionCommand, startUp, close, sessionName: () => st.session, renameSaved, renameCurrent, saveTabs,
    // The browser's pages used their key (or the helper stops): its file has done its job.
    dropHelperKey: () => dropHelperKey(),
    // At process exit, where close() can't wait: the virtual screen is told to end now.
    stopScreenNow,
    // The crash-loop guard's refusal while it holds, else null; and what pairbrowse_status adds
    // about the browser's surroundings (browser/supervise.mjs) and the session's network
    // (daemon/network.mjs: its last check, or a failed one that holds).
    // The running browser's profile ("Profile: <name> (rev <n>, <status> on <build>)") and its
    // graphics ("Graphics: <kind> (<renderer>), requested <backend>, <status> on <build>"; remote: a
    // joiner's agent asks, which gets no renderer) come before them.
    crashLoop, statusParts: ({ remote = false } = {}) => [...screenParts(), ...profiles.statusParts(), ...graphicsStatus({ remote }), ...(network?.statusParts(st.session) || [])],
    // The running browser's graphics for diagnostics: { kind, status } (never the renderer or IDs), or null.
    graphics: graphicsSummary,
    // The browser profiles there are (the store's list): what an agent may pick from (spec D14).
    profiles: () => profiles.list(),
    // The person's profile operations on the sessions page (sessions/profile-owner.mjs): owner-only routes.
    profileOps: profiles.owner,
    // The open compatibility items a hand-off reports apart from the site's own verification
    // (daemon/yourturn.mjs, spec server-mode B14): the running profile's coherence items and the
    // session's network verdict and coherence items (rules/coherence.mjs), PairBrowse's to fix.
    compatibility: () => [...profiles.coherence(), ...(network?.compatibility(st.session) || [])],
    // The refusal the session's starts get while its proxy's failed check holds, else null.
    networkRefusal: () => network?.refusal(st.session) || null,
    // Whether the browser runs a strict proxied session now: shared browser mode then sends
    // pictures only, as host and as joiner (spec server-mode C11).
    networkStrict: () => !!network?.strict(),
    // Server mode (display.mjs serverMode): hand-offs always go to the person's channels there.
    isServer,
    // server.keepAlive: the helper stays when the browser closes and counts as in use (handoff.mjs);
    // keepAliveStart() starts the browser as the helper starts.
    keepAlive, keepAliveStart,
    // The tab a page came back as after its session's browser restarted (a session switch and
    // back), or null.
    successorOf,
    waitForPick, pickerState, pickSession, pickedJoin, switchForPerson, // In the session being opened, when the person just picked another.
    recordPerson: recordPersonHere, picking: () => st.pick.state === "showing", reopenPicker,
    agentChose,
  };
}
