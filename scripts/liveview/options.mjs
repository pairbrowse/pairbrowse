// The hand-off viewer's option list (spec server-mode B8, T-B18): an open select list is a popup the
// browser draws in a window of its own, so it never reaches the screencast the phone sees
// (measured by test/integration/your-turn.test.mjs: the list is open, the picture shows none of
// it). After each tap the viewer asks for the focused field of the tab on screen; when it is a
// select, the helper answers its options' labels and the viewer lists them over the picture. The
// person's choice goes back as the person's own keys while the page's list is open (arrows to the
// option, then Enter), through the same queue and checks as their typing, and the helper reads the
// select again to say whether it took. A closed select never gets keys (Enter there sends the form
// on Linux and Windows; an arrow on macOS opens a system menu nobody sees): the choice is set in
// the page with the input and change events a choice fires, on that same select, still focused,
// still closed. Labels go only to that viewer's request, never to a log, an
// agent or another guest; the viewer sees the same tab without covers anyway.
import { within } from "../util.mjs";
import { focusedHandle } from "../runner/cards.mjs";

export const OPTIONS_MAX = 200; // a select with more is answered as too long for the list
const LABEL_MAX = 100;
const READ_MS = 1500;

export const OPTION_WORDS = {
  away: "That tab isn't on screen. Go back to the hand-off's tab.",
  gone: "That list isn't selected in the page any more. Tap it in the picture again.",
  disabled: "That option can't be chosen. Pick another one.",
  missed: "The page didn't take that option. Tap the list in the picture again, or use the arrow keys of a keyboard.",
};

// In the page, on the focused element: a single-choice select's label, options and choice, or null.
// Options in a disabled group count as disabled (the keys skip them as they skip disabled ones).
function scan(n, { max, labelMax }) {
  const el = n?.tagName === "LABEL" && n.control ? n.control : n;
  if (el?.tagName !== "SELECT" || el.multiple || el.disabled || Number(el.size) > 1) return null;
  const clean = (s) => String(s || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, labelMax);
  let open = false;
  try { open = el.matches(":open"); } catch {}
  const options = [...el.options].slice(0, max + 1).map((o) => ({ label: clean(o.label || o.text), disabled: !!(o.disabled || (o.parentElement?.tagName === "OPTGROUP" && o.parentElement.disabled)) }));
  const label = clean(el.labels?.[0]?.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "");
  return { label, count: el.options.length, selected: el.selectedIndex, open, options };
}

// The focused select of page (in whichever frame) as scan reads it, or null (none, or no answer in time).
export async function focusedSelect(page) {
  const el = await focusedHandle(page);
  if (!el) return null;
  try {
    return await within(READ_MS, Promise.resolve().then(() => el.evaluate(scan, { max: OPTIONS_MAX, labelMax: LABEL_MAX })).catch(() => null));
  } finally { el.dispose?.().catch(() => {}); }
}

// In the page, on the focused element: choose option index of a closed select of count options,
// as a choice from its list does (input, then change). False when it isn't that select any more.
function choose(n, { index, count }) {
  const el = n?.tagName === "LABEL" && n.control ? n.control : n;
  if (el?.tagName !== "SELECT" || el.multiple || el.disabled || el.options.length !== count) return false;
  let open = false;
  try { open = el.matches(":open"); } catch {}
  const o = el.options[index];
  if (open || !o || o.disabled || (o.parentElement?.tagName === "OPTGROUP" && o.parentElement.disabled)) return false;
  if (el.selectedIndex === index) return true;
  el.selectedIndex = index;
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.selectedIndex === index;
}
export async function chooseInPage(page, index, count) {
  const el = await focusedHandle(page);
  if (!el) return false;
  try {
    return (await within(READ_MS, Promise.resolve().then(() => el.evaluate(choose, { index, count })).catch(() => false))) === true;
  } finally { el.dispose?.().catch(() => {}); }
}

// What the viewer gets: { label, selected, options: [{ label, disabled }] } for a select it can
// list, else { options: null } (no select, or one too long to list).
export function listOf(sel) {
  if (!sel || sel.count > OPTIONS_MAX || sel.count < 1) return { options: null };
  return { label: sel.label, selected: sel.selected, options: sel.options.slice(0, sel.count) };
}

// How option index of sel (as focusedSelect read it) is chosen: { keys } while its list is open
// (ArrowDown or ArrowUp once per enabled option between the current choice and it, as the keys skip
// disabled ones, then Enter), { keys: null } while it is closed (set in the page by chooseInPage),
// or { problem } (an OPTION_WORDS key).
export function pickKeys(sel, index, count) {
  if (!sel || sel.count !== count || sel.count > OPTIONS_MAX) return { problem: "gone" };
  if (!Number.isSafeInteger(index) || index < 0 || index >= sel.count) return { problem: "gone" };
  if (sel.options[index]?.disabled) return { problem: "disabled" };
  const enabled = sel.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const to = enabled.indexOf(index);
  const from = enabled.indexOf(sel.selected); // -1: nothing chosen yet (the first ArrowDown picks the first)
  const steps = to - from;
  const key = (k) => ({ type: "key", key: k, modifiers: 0 });
  const keys = Array.from({ length: Math.abs(steps) }, () => key(steps > 0 ? "ArrowDown" : "ArrowUp"));
  if (!sel.open) return { keys: null };
  keys.push(key("Enter"));
  return { keys };
}
