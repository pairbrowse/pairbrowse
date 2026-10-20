// The browser's state, shared by its parts (browser/launch.mjs, browser/tabs.mjs,
// sessions/picker.mjs, sessions/switch.mjs) through one object instead of a closure's variables.
import { EXTENSION_SHELL } from "../../browser/choice.mjs";

export function createBrowserState({ session, pick }) {
  return {
    contextPromise: null, // the browser's context while it runs or starts, else null
    ownPages: false, // the browser in use has its own pages (no side panel extension)
    chosen: false, // shell, ownPages and capture are this launch's (set once its build was chosen)
    capture: false, // ...and its own capture page
    shell: EXTENSION_SHELL, // this launch's shell (browser/choice.mjs): ownPages and capture are its
    engine: null, // the launch layer's config of the last launch (engineConfig), null before one
    helperKeyPath: null, // the key file of the browser launched last, until used or closed
    captureKeyPath: null, // ...and its capture page's
    // The PairBrowse browser is being downloaded and installed (first start, or a new version):
    // the user hears of it, and actions say so at once rather than waiting for minutes.
    installing: false,
    launching: false,
    // The next launch is for a person who opened the PairBrowse browser by hand (openByHand): it may
    // come to the front, so nothing puts the app they were in back in front of it (keepFocus).
    byHand: false,
    // When a person last used the browser where the page script never runs (opened it by hand,
    // picked a session, pressed something in its own pages or the side panel), ms; 0 for never.
    // A newer bridge's hello restarts the helper only once that is a while ago (handoff.mjs).
    personAt: 0,
    inUse: null, // the browser the last launch chose
    session, // which browser session (browser profile) is in use
    switching: false,
    // While a session switch closes one browser and opens the next, anyone else asking for the
    // browser waits for it: a browser started in between would be left running, unknown to the
    // helper (a second window, and the next start fails on its profile in use).
    switched: Promise.resolve(),
    screen: null, // virtual display on a Linux machine without a screen (browser/supervise.mjs)
    screenStopping: false, // ...being ended on purpose (shutdown): its exit is not a lost screen
    // The crash-loop guard (browser/supervise.mjs, server mode only): when the browser closed by
    // itself soon after its start, ms, within the last few minutes; and until when launches are
    // refused (0: they aren't).
    unexpectedCloses: [],
    crashLoopUntil: 0,
    // Keep-alive (browser/supervise.mjs relaunchSoon): starts after a close in a row (each waits
    // longer), and when the start planned now comes, ms (0: none is planned).
    relaunches: 0,
    relaunchAt: 0,
    resetting: false, // the helper closes the browser itself (reset(): a stalled call), never a crash
    tabTracker: null,
    restoring: null, // promise while saved tabs are being reopened
    restoredActiveUrl: null,
    lastCurrentUrl: null, // the tab Claude worked in last, from tool results
    // The session picker: { state: "off" | "pending" | "showing" | "done", page, text, done, resolve, reopened }.
    pick,
    pickSwitch: null, // the switch the person's pick started, until the new browser is up
    predicted: null, // predict()'s last answer: { sig, shell }
  };
}
