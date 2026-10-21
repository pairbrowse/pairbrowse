// Humanized moves at two paces on one page (the adaptive input pace, native/pace.mjs). The engine
// pack shapes a page's moves by the motion it was given when it took that page over, once. So with
// inputPace "adaptive" each page gets the pack's humanized input twice, one set for each pace (the
// fast one at config's motion and typingPace, the everyday one at "combined" and an everyday
// typist's pace), and the set in use is swapped in when the pace changes (useMotion). The two sets
// share one pointer: each set's moves end where the pointer is, so the set not in use is brought
// there without a move reaching the page (its own moves swallowed while it follows), a moment after
// the other one stops, and before it is swapped in at the latest; a swap never jumps the pointer.
// With "fast" or "human", or with humanize off, the pack takes the context once, as before.
import { within } from "../util.mjs";

// Properties the pack keeps for itself on a page, shared by both sets, never swapped.
const KEEP = new Set(["__pairbrowseHumanized", "_pairbrowseHumanized", "_pairbrowsePersona", "_pairbrowseAutoAmbient"]);
export const FOLLOW_MS = 4000; // the set not in use following the pointer, at most (one of its paths)
const SETTLE_MS = 150; // after the last move, before the set not in use follows
const paced = new WeakMap(); // page -> its two sets: { active, sets, pre, keys, at, known, quiet, chain, timer }
const holders = (page) => [page, page.mouse, page.keyboard];
const ownValues = (o) => new Map(Object.keys(o).map((k) => [k, o[k]]));
const other = (name) => (name === "fast" ? "human" : "fast");

// The methods an install put on the page, its mouse and its keyboard: [[holder, key, value]].
// Only functions: the driver's own fields (an event emitter's counts) change as listeners come.
function changes(page, before) {
  const out = [];
  holders(page).forEach((o, i) => {
    for (const k of Object.keys(o)) if (!KEEP.has(k) && typeof o[k] === "function" && (!before[i].has(k) || before[i].get(k) !== o[k])) out.push([i, k, o[k]]);
  });
  return out;
}
// Puts a set's methods on the page; a key only the other set changed goes back to what it was.
function apply(st, name) {
  const hs = holders(st.page);
  const mine = new Map(st.sets[name].map(([i, k, v]) => [`${i} ${k}`, v]));
  for (const [i, k] of st.keys) {
    if (mine.has(`${i} ${k}`)) hs[i][k] = mine.get(`${i} ${k}`);
    else if (st.pre[i].has(k)) hs[i][k] = st.pre[i].get(k);
    else delete hs[i][k];
  }
  st.active = name;
}
const moveOf = (st, name) => st.sets[name].find(([i, k]) => i === 1 && k === "move")?.[2];

// Brings a set to where the pointer is, its own moves swallowed (they reach no page). true when
// it is there (or there is nowhere to bring it yet).
async function follow(st, name) {
  const at = st.at, known = st.known[name], move = moveOf(st, name);
  if (!at || !move || st.page.isClosed?.() || (known && known.x === at.x && known.y === at.y)) return true;
  st.quiet[name] = true;
  const going = Promise.resolve().then(() => move.call(st.page.mouse, at.x, at.y)).catch(() => {});
  const done = await within(FOLLOW_MS, going.then(() => true));
  // A path still under way keeps its moves swallowed until it ends.
  if (done) st.quiet[name] = false;
  else going.finally(() => { st.quiet[name] = false; });
  return done === true;
}
function later(st) {
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.chain = st.chain.then(() => follow(st, other(st.active))).catch(() => false); }, SETTLE_MS);
  st.timer.unref?.();
}

// The page's two sets, from the pack's two page hooks (each takes one page over, synchronously).
// false when the pack didn't take it over at once: then the fast set alone stays, as it is.
function setUp(page, hooks) {
  if (paced.has(page) || !page?.mouse || !page.keyboard) return false;
  const hs = holders(page);
  const pre = hs.map(ownValues);
  const realMove = page.mouse.move.bind(page.mouse);
  const st = { page, active: "fast", sets: {}, pre, keys: [], at: null, known: { fast: null, human: null }, quiet: { fast: false, human: false }, chain: Promise.resolve(true), timer: null };
  // Each set's own move: where the pointer goes is kept; swallowed while the set follows.
  const base = (name) => async (x, y, options) => {
    st.known[name] = { x, y };
    if (st.quiet[name]) return;
    await realMove(x, y, options);
    st.at = { x, y };
    if (st.active === name) later(st);
  };
  const take = (name) => {
    page.mouse.move = base(name);
    delete page.__pairbrowseHumanized;
    delete page._pairbrowseHumanized;
    const before = hs.map(ownValues);
    hooks[name](page);
    if (page._pairbrowseHumanized !== true) return false;
    st.sets[name] = changes(page, before);
    return true;
  };
  if (!take("fast")) return false;
  // Back to the page's own methods, so the second set builds on them too.
  for (const [i, k] of st.sets.fast) {
    if (pre[i].has(k)) hs[i][k] = pre[i].get(k);
    else delete hs[i][k];
  }
  const human = take("human");
  st.keys = [...new Map([...st.sets.fast, ...(human ? st.sets.human : [])].map(([i, k]) => [`${i} ${k}`, [i, k]])).values()];
  if (!human) delete st.sets.human;
  apply(st, "fast");
  page.__pairbrowseHumanized = true;
  page._pairbrowseHumanized = true;
  paced.set(page, st);
  return true;
}

// Has the pack take over the context's pages: once (sets.human absent), or twice for the adaptive
// pace. install(context, options): the pack's installHumanizeOnContext. sets: { fast, human? },
// each { motion, typingPace } over options. log: one line when the two sets can't be had.
export function installPacedHumanize(context, install, options, sets, log = () => {}) {
  if (!sets.human || !options.humanize) return install(context, { ...options, ...sets.fast });
  const hooks = {};
  for (const name of ["fast", "human"]) {
    const scope = {
      browser: () => (typeof context.browser === "function" ? context.browser() : null),
      // The cursor's page script is the context's once (the fast set's).
      addInitScript: (...args) => (name === "fast" ? context.addInitScript(...args) : Promise.resolve()),
      on: (event, hook) => { if (event === "page") hooks[name] = hook; return scope; },
      pages: () => [],
    };
    install(scope, { ...options, ...sets[name], showCursor: name === "fast" && !!options.showCursor });
  }
  if (!hooks.fast || !hooks.human) {
    log("humanized input: one pace only (the engine pack took no page hook)");
    return install(context, { ...options, ...sets.fast, showCursor: false });
  }
  let warned = false;
  const each = (page) => {
    let ok = false;
    try { ok = setUp(page, hooks); } catch (error) { log(`humanized input: pace sets: ${String(error?.message || error).slice(0, 120)}`); }
    if (!ok && !paced.has(page) && !warned) { warned = true; log("humanized input: a page kept one pace (the engine pack didn't take it over at once)"); }
  };
  if (typeof context.on === "function") context.on("page", each);
  for (const page of (typeof context.pages === "function" ? context.pages() : [])) each(page);
}

// Moves on page at pace ("fast" or "human") from now on. Bounded: when the set can't be brought
// to the pointer in time, the page keeps the pace it has. Returns the pace its moves go at now
// (motionPace): another than the one asked for when the swap didn't happen; null for one set only.
export async function useMotion(page, pace) {
  const st = page && paced.get(page);
  if (!st || !st.sets[pace] || st.active === pace) return motionPace(page);
  clearTimeout(st.timer);
  st.chain = st.chain.then(() => follow(st, pace)).catch(() => false);
  if ((await within(FOLLOW_MS + 500, st.chain)) !== true || st.page.isClosed?.()) return motionPace(page);
  apply(st, pace);
  later(st);
  return motionPace(page);
}

// The pace a page moves at now, or null (one set only, or not taken over).
export function motionPace(page) {
  const st = page && paced.get(page);
  return st?.sets.human ? st.active : null;
}
