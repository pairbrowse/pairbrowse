// Fast mode: Claude sends a whole page (or flow) of steps in one call, and they run here at
// machine speed, with no model turn between steps. Returns a short summary plus an outline of
// the page it ended on, so the next page can be planned without a full snapshot.
//
// The same safety rules apply as for single actions: web pages only, passwords only on their
// domains, uploads only of checked media and documents, final actions (pay, publish, submit for
// review, delete, message people) are left for browser_click so the user confirms them.
import { navigationProblem } from "./rules/policy.mjs";
import { isLocalNetwork } from "./rules/network.mjs";
import { uploadProblem } from "./upload.mjs";
import { within } from "./util.mjs";
import { withHelpers, isVisible, nearbyText } from "./daemon/page.mjs";
import { LATE_MAX_MS, Touched, fieldProblems, lateRewrites, leftovers } from "./runner/verify.mjs";
import { stepsIn } from "./runner/steps.mjs";

// Its parts live in runner/; re-exported here (tests and the daemon import runner.mjs).
export { LATE_MAX_MS, LATE_MIN_MS } from "./runner/verify.mjs";
export { UNREADABLE, activatingKey, contextAt, enterButtonLabel, focusedFrame, riskAt, riskReason } from "./runner/risk.mjs";
export { clickScore, revealable } from "./runner/locate.mjs";
export { isoDate, sameDate } from "./runner/dates.mjs";
export { listPlaybooks, loadPlaybook, savePlaybook, substitute } from "./runner/playbooks.mjs";

// The tools' definitions live in the catalog (tools/catalog.mjs).
export { RUN_TOOL, SCROLL_TOOL } from "./tools/catalog.mjs";

// Checks a step list before anything runs. Returns a problem string, or null.
export function preflight(steps, uploadsDir) {
  if (!Array.isArray(steps) || !steps.length) return "No steps.";
  if (steps.length > 200) return "Too many steps (max 200).";
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step || {})[0] || [];
    const at = `Step ${i + 1} (${kind})`;
    const names = arg && typeof arg === "object" && !Array.isArray(arg) ? Object.keys(arg) : typeof arg === "string" ? [arg] : Array.isArray(arg) ? arg.filter((x) => typeof x === "string") : [];
    if (names.some((n) => n.length > 300)) return `${at}: a name that long (${Math.max(...names.map((n) => n.length))} characters) is no field's; use the label a person reads.`;
    if (kind === "go") {
      const p = navigationProblem(arg);
      if (p) return `${at}: ${p}`;
      if (isLocalNetwork(arg)) return `${at}: ${arg} is on the local network. Use browser_navigate so the user can approve it.`;
    } else if (kind === "click") {
      // What the click does is checked when it runs (the page isn't there yet).
    } else if (kind === "upload") {
      for (const p of Object.values(arg || {})) {
        const problem = uploadProblem(p, uploadsDir); // the same checks as pairbrowse_upload
        if (problem) return `${at}: ${problem}`;
      }
    } else if (kind === "drag") {
      const ok = Array.isArray(arg) && arg.length >= 2 && arg.length <= 200 && arg.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && n >= 0 && n <= 1));
      if (!ok) return `${at}: drag takes 2 to 200 points [x, y], fractions 0-1 of the visible page.`;
      const far = Math.max(...arg.map(([x, y]) => Math.hypot(x - arg[0][0], y - arg[0][1])));
      if (far < 0.01) return `${at}: a drag has to move (for a click use click).`;
    } else if (kind === "scroll") {
      if (!(arg === "down" || arg === "up" || (Number.isFinite(Number(arg)) && Number(arg) !== 0 && Math.abs(Number(arg)) <= 20000))) return `${at}: scroll takes "down", "up" or a number of pixels (negative: up).`;
    } else if (kind === "handoff") {
      if (!arg || typeof arg !== "object" || Array.isArray(arg) || (arg.until === undefined && arg.untilGone === undefined)) return `${at}: handoff takes {"say": "what the user must do", "until": "text that appears after"} (or "untilGone").`;
      if ((arg.until !== undefined && typeof arg.until !== "string") || (arg.untilGone !== undefined && typeof arg.untilGone !== "string") || (arg.say !== undefined && typeof arg.say !== "string")) return `${at}: say, until and untilGone are text.`;
    } else if (!["fill", "check", "uncheck", "select", "press", "waitFor", "expect"].includes(kind)) {
      return `${at}: unknown step. Use one of go, fill, check, uncheck, select, click, press, scroll, upload, waitFor, expect, handoff.`;
    }
  }
  return null;
}

// Compact description of what's on the page now: enough to plan the next steps.
const describePage = withHelpers(() => {
  const name = (el) => {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (el.getAttribute("aria-label") || id?.innerText || el.closest("label")?.innerText || el.placeholder || nearbyText(el) || el.name || "").replace(/\s+/g, " ").trim().slice(0, 50);
  };
  const fields = [...document.querySelectorAll("input, select, textarea")].filter((el) => isVisible(el) && el.type !== "hidden" && el.type !== "submit").slice(0, 25).map((el) => {
    const type = el.tagName === "SELECT" ? "select" : el.type || "text";
    const val = type === "checkbox" || type === "radio" ? (el.checked ? "on" : "off") : type === "password" ? (el.value ? "(set)" : "") : String((type === "select" ? el.selectedOptions[0]?.text.trim() : el.value) || "").slice(0, 30);
    return `${name(el) || "(unlabeled)"} [${type}${el.required ? ", required" : ""}${el.getAttribute("aria-invalid") === "true" ? ", INVALID" : ""}]${val ? ` = ${val}` : ""}`;
  });
  const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit], a[href]")].filter(isVisible)
    .map((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean);
  // Real messages only: short text with no fields inside (a wrapper named "...error-handling"
  // isn't an error), plus what an invalid field points to with aria-describedby.
  const described = [...document.querySelectorAll('[aria-invalid="true"][aria-describedby]')].flatMap((f) => f.getAttribute("aria-describedby").split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean));
  // A message a person can see: screen-reader-only live regions ("Page loaded", "Expanded":
  // a 1 px box, or clipped away) are announcements, not errors.
  const onScreen = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width >= 8 && r.height >= 8 && st.clip === "auto" && (st.clipPath === "none" || !st.clipPath); };
  const errors = [...document.querySelectorAll('[role=alert], [aria-live=assertive], .error, .errors, [class*="error" i], [class*="invalid" i]'), ...described].filter(isVisible).filter(onScreen)
    .filter((el) => !el.matches("input, select, textarea, button, option") && !el.querySelector("input, select, textarea, button") && (el.innerText || "").trim().length <= 160)
    .map((el) => el.innerText.replace(/\s+/g, " ").trim().slice(0, 100)).filter(Boolean);
  const h = document.querySelector("h1, h2")?.innerText.replace(/\s+/g, " ").trim().slice(0, 80);
  return [
    `Page: ${document.title.slice(0, 80)} <${location.href.slice(0, 120)}>`,
    h && `Heading: ${h}`,
    fields.length && `Fields: ${fields.join("; ")}`,
    buttons.length && `Buttons/links: ${[...new Set(buttons)].slice(0, 20).join(" | ")}`,
    errors.length && `Errors: ${[...new Set(errors)].slice(0, 5).join(" | ")}`,
  ].filter(Boolean).join("\n");
}, isVisible, nearbyText);
export const outline = (page) => page.evaluate(describePage);

// hooks.dialogOpen(): the confirm or prompt the page waits on, or null.
export async function runSteps(page, steps, hooks) {
  const human = !hooks.smooth && page._pairbrowseHumanized === true;
  if (human) page._pairbrowseHumanized = false;
  // hooks.signal: aborted when the agent left, or when the run's time is up (serve.mjs).
  const touched = new Touched(); // [{ el, label }]: the fields the run filled or chose in
  // Fields are brought into view at once: a page's smooth scrolling (CSS scroll-behavior) would
  // animate every jump to the next field. Put back when the run ends.
  const instant = hooks.smooth || typeof page.evaluate !== "function" ? null : await within(500, Promise.resolve().then(() => page.evaluate(() => { const st = document.createElement("style"); st.textContent = "html, body, * { scroll-behavior: auto !important; }"; st.setAttribute("data-pb-instant", ""); (document.head || document.documentElement).appendChild(st); return true; })).catch(() => null));
  try {
    const result = await stepsIn(page, steps, hooks, touched);
    // A page waiting on its own confirm or prompt runs no script: nothing more can be read from it.
    if (result.dialog) return { ...result, checks: [] };
    // A value the page rewrites a moment after it was filled (a lookup from another answer, a
    // location guess, a script on blur): looked at again once the page is quiet.
    // Each read of the page after the run is bounded: a restless page (a travel site redrawing
    // its search box without end) must never hold the run, and every agent behind it, for good.
    hooks.trace?.("after the steps: looking for values the page changed");
    const late = (await within(LATE_MAX_MS + 6000, lateRewrites(page, touched)).catch(() => [])) ?? [];
    hooks.trace?.("after the steps: looking for problems the page shows");
    result.checks = [...late.map((c) => c.text), ...((await within(8000, fieldProblems(touched.filter((t) => !late.some((c) => c.t === t)))).catch(() => [])) ?? [])];
    // What's still blank in that form: often fields the form added while it was filled (a state once
    // the country is chosen). Only after a run that filled something, and not when it stopped.
    if (result.ok && touched.length) {
      hooks.trace?.("after the steps: looking for fields left empty");
      const left = (await within(8000, leftovers(page, touched)).catch(() => null)) ?? { required: [], optional: [] };
      const list = (names) => names.map((n) => `"${n}"`).join(", ");
      if (left.required.length) result.checks.push(`still empty and required: ${list(left.required)}`);
      if (left.optional.length) result.checks.push(`left empty (optional; fill them if the user's details or task cover them): ${list(left.optional)}`);
    }
    return result;
  } finally {
    // Elements held by hand (a styled dropdown): let go of them.
    for (const t of touched) {
      if (typeof t.el?.asElement === "function") t.el.dispose().catch(() => {});
      Promise.resolve(t.handle).then((h) => h?.dispose()).catch(() => {});
    }
    if (human) page._pairbrowseHumanized = true;
    if (instant) await within(500, page.evaluate(() => document.querySelectorAll("style[data-pb-instant]").forEach((n) => n.remove())).catch(() => {}));
  }
}
