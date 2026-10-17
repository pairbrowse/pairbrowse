// Fast mode's steps: stepsIn runs each step of a run (fill, check, select, click, press, drag,
// scroll, upload, wait, expect, handoff) and says how far it got. Each kind's handler is in
// steps/: it returns nothing when its step is done, NEXT when it recorded nothing more to look at,
// or the run's result when the run stops there.
import { activatingKey } from "./risk.mjs";
import { isWebStore, WEB_STORE_RULE, isWebTab, NOT_WEB_RULE, ERROR_PAGE_RULE } from "../rules/policy.mjs";
import { NEXT, dialogStop } from "./steps/common.mjs";
import { go } from "./steps/go.mjs";
import { fill } from "./steps/fill.mjs";
import { check } from "./steps/check.mjs";
import { select } from "./steps/select.mjs";
import { click } from "./steps/click.mjs";
import { press } from "./steps/press.mjs";
import { drag } from "./steps/drag.mjs";
import { scroll } from "./steps/scroll.mjs";
import { upload } from "./steps/upload.mjs";
import { wait } from "./steps/wait.mjs";
import { handoff } from "./steps/handoff.mjs";

// Each step kind's handler; a kind not here does nothing and counts as done.
const HANDLERS = new Map([
  ["go", go], ["fill", fill], ["check", check], ["uncheck", check], ["select", select], ["click", click],
  ["press", press], ["drag", drag], ["scroll", scroll], ["upload", upload], ["waitFor", wait], ["expect", wait], ["handoff", handoff],
]);

// Runs steps on page. hooks: { secrets: {values, domains}, uploadsDir, signal, beforeStep(kind, el),
// status(text, kind), activity(text), cursor(el, act), remember(label, value, site), owner(el) }.
// beforeStep gets "enter" for an Enter press, and a click's element. owner(el): the person
// filling that field ({ who }) or null: such a field is skipped (in skipped) and the run goes on.
// Fast mode is just fast: the engine's human-like mouse and typing (on by default for single
// actions) are off for the run, and a scroll step goes at once. hooks.smooth: a single action
// (pairbrowse_scroll) that glides like a person.
const READ_STEPS = new Set(["go", "waitFor", "expect", "scroll", "handoff"]);
export async function stepsIn(page, steps, hooks, touched = []) {
  const started = Date.now();
  const done = [];
  const skipped = []; // [{ label, who }]
  const theirs = async (el, label) => {
    const o = await hooks.owner?.(el);
    // Its owner couldn't be read in time (a very busy page): left, never typed over.
    if (o) skipped.push({ label, who: o.unknown ? "maybe a person: the page was too busy to check, try it again" : o.who });
    return !!o;
  };
  // No bringToFront here: on macOS it raises the whole browser window over the app you're in.
  // Background tabs aren't slowed down anyway (the browser starts with throttling switched off).
  // hooks.trace(text): where the run is now, for the word on a run that gets stuck (serve.mjs).
  const trace = (t) => { try { hooks.trace?.(t); } catch {} };
  const run = { lastTyped: null }; // the field a fill step typed last (an Enter right after it goes there)
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step)[0];
    const fail = (why) => ({ ok: false, done, skipped, stoppedAt: i + 1, why });
    trace(`step ${i + 1} (${kind})`);
    // Out of time (the run's deadline), or the agent left: stop here, between steps.
    if (hooks.signal?.aborted && i > 0) return fail(`This run took too long (${Math.round((Date.now() - started) / 1000)} s on the steps before this one: a slow or restless page). Take a browser_snapshot, then run the remaining steps.`);
    // A field missing after earlier steps of this run: forms add and remove fields as they're answered.
    const gone = () => (touched.length ? " An earlier answer in this run may have removed it (forms add and remove fields as they're filled): take a snapshot, then fill what's there now." : "");
    try {
      // The Web Store is the user's: a run reads it, never acts there.
      if (!READ_STEPS.has(kind) && typeof page.url === "function" && !isWebTab(page.url())) return fail(/^chrome-error:/i.test(page.url()) ? ERROR_PAGE_RULE : NOT_WEB_RULE);
      if (!READ_STEPS.has(kind) && isWebStore(page.url?.())) return fail(WEB_STORE_RULE);
      if (kind !== "click") await hooks.beforeStep?.(kind === "press" && activatingKey(arg) === "enter" ? "enter" : kind);
      const handler = HANDLERS.get(kind);
      const r = handler && await handler({ page, kind, arg, i, steps, hooks, touched, done, fail, gone, theirs, trace, run });
      if (r === NEXT) { done.push(kind); continue; }
      if (r) return r;
      done.push(kind);
      // The step opened the page's own confirm or prompt: nothing runs until it's answered.
      const asked = hooks.dialogOpen?.();
      if (asked) return { ...fail(dialogStop(asked, "The step before this one")), done, stoppedAt: Math.min(i + 2, steps.length), dialog: true };
    } catch (e) {
      const asked = hooks.dialogOpen?.();
      if (asked) return { ...fail(dialogStop(asked, "This step")), dialog: true };
      return fail(String(e?.message || e).split("\n")[0].slice(0, 200));
    }
  }
  return { ok: true, done, skipped, ms: Date.now() - started };
}
