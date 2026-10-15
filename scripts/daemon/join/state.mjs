// One session joined from here (pairbrowse_join): everything the joiner side keeps about it, in
// one place. daemon/follow.mjs makes one per join; its parts (join/*.mjs) read and change it.
import { newJoinerId } from "../../sharing/join.mjs";
import { createMirror, createFormSync, createOrderSync } from "../../sharing/tabsync.mjs";

// A tab opened or sent somewhere here: its first answer within this.
export const OPEN_MS = 15_000;

// What follow.mjs and its parts share: the session joined now (cur, or null) and how the last one
// ended without a leave (ended: { text }, denied or revoked, for status).
export const newFollowState = () => ({ cur: null, ended: null });

// shared: a shared browser session (codes with mode "shared": picture pages), else follow mode.
// owner: the connection that joined (leaving ends with it).
export function newJoinState({ shared, owner }) {
  return {
    join: null, // the connection to the host (sharing/join-client.mjs startJoin), set once started
    queue: null, // the host's changes and this side's, one at a time (serially)
    owner,
    shared,
    joinerId: newJoinerId(), // who this side is to the host (its pointers come back keyed by it)
    wasIn: false, // the host let this side in at least once
    // The host's tabs here.
    pages: new Map(), // host tab id -> page here
    mirror: createMirror(), // addresses both ways (tabsync.mjs)
    window: false, // the shared window is open
    windowId: null, // ...and its id (new tabs in it are shared)
    candidates: new Map(), // page -> when it opened from a shared tab (Infinity: in the shared window), until adopted
    seen: new WeakSet(), // pages decided on (shared, or never)
    quiet: new Set(), // tab ids that cross as addresses only (the host's secret domains)
    order: createOrderSync(),
    orderAt: 0, // when the order here was checked last
    hostOrderSig: null, // the host's order, as last applied
    devSig: null, // the host's dev servers, as last allowed (their cookies set)
    // Who does what.
    lastT: 0, // the newest activity from there shown here
    heard: new Map(), // tab id -> the newest "did" number heard from there
    told: new WeakMap(), // page -> the newest of this person's actions sent there
    agents: new Map(), // page -> the agent holding the tab there ({ label, color, held, until })
    agentSent: new Map(), // tab id -> { sig, at }: the agent here holding it, as last sent
    personSent: new Map(), // tab id -> when a person here acting in it was last sent
    outbox: [], // ops waiting for the next round (activity, order)
    // Form values.
    forms: createFormSync(),
    dirty: new Set(), // pages whose fields changed since the last round
    formsAllAt: 0, // when every field was read last
    formT: new Map(), // tab id -> when the values from there were sent (latency log)
    formTimer: null,
    // Pointers.
    pointed: new WeakMap(), // page -> { me, agent, view } here
    pointerTimer: null,
    pointerSig: "",
    pointerAt: 0,
    drawn: new Set(), // pages with pointers from there drawn
    // Shared browser mode: the picture pages.
    screens: new Map(), // page -> its connection's record (screensRound)
    titles: new Map(), // tab id -> the title and address said to its page
    infos: new Map(), // tab id -> { title, url } from the host
    who: new Map(), // tab id -> who works in it there (tabWho), and what its page was told
    urls: new Map(), // tab id -> the host tab's address (opened as your own on leaving)
    inputTimer: null, // the slower route's input, while it runs
  };
}
