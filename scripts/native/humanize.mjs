// Humanized input in the native browser: typing with a person's rhythm (humanType) and form fills
// field by field (humanFill), paced by "pairbrowse" typingPace and formMove in config.json. Used for
// every engine by daemon/serve.mjs; the engine pack's own humanize covers mouse moves.
import { within } from "../util.mjs";

// typingPace: how fast humanized typing goes, 0.2 (fastest) to 1 (the engine's own, about 60 words a
// minute); the gaps between keys scale, how long each key is held doesn't. For a single browser_type
// 0.3 is about 104 words a minute (measured: 0.5 is 80, 0.35 is 95); a form fill (humanFill) has its
// own rhythm at the same pace.
export const TYPING_PACE = 0.3;
export const clampPace = (pace, floor = 0.2) => Math.min(1, Math.max(floor, Number(pace) || TYPING_PACE));

// What a form fill (browser_fill_form) in the native browser follows. typingPace as above, floored at
// 0.25 here: quicker would be under 40 ms a key on average, which no hand does. formMove: "tab" (the
// default) goes on to the next field with the Tab key when it is next in the page's own order, by
// mouse otherwise; "mouse" reaches for every field, as single actions do.
export const FILL_PACE_FLOOR = 0.25;
export function fillSettings(config) {
  const { typingPace = TYPING_PACE, formMove = "tab" } = config?.pairbrowse ?? {};
  return { typingPace: clampPace(typingPace, FILL_PACE_FLOOR), formMove: formMove === "mouse" ? "mouse" : "tab" };
}

// Typing a value in a form fill: key by key with a person's rhythm. The next key often goes down
// before the last one comes up (rollover), as a quick typist's do; Shift is held for capitals and
// signs; a beat after a word or a sign, now and then a thought. The gaps scale with pace, the hold of
// each key doesn't. Returns [{ at, type: "down" | "up", key }], at in ms from the first key, in order.
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;
export function keystrokeSchedule(text, pace = TYPING_PACE, rng = Math.random) {
  const p = clampPace(pace, FILL_PACE_FLOOR);
  const between = (a, b) => a + (b - a) * rng();
  const chars = Array.from(String(text ?? ""));
  const events = [];
  const upAt = new Map(); // key -> when it last came up: a key goes down again only after that
  let at = 0, lastUp = 0, shift = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const key = ch === "\n" ? "Enter" : ch === "\t" ? "Tab" : ch;
    const needsShift = SHIFTED.test(ch);
    if (i > 0) {
      let gap = between(55, 160);
      if (/[\s.,;:!?@\-_/]/.test(chars[i - 1])) gap += between(15, 80);
      if (rng() < 0.03) gap += between(150, 350);
      at += gap * p;
    }
    if (needsShift !== shift) {
      // Shift changes between two keys: the last key is up first, then Shift moves.
      at = Math.max(at, lastUp + between(5, 25));
      events.push({ at, type: shift ? "up" : "down", key: "Shift" });
      shift = needsShift;
      at += between(40, 110) * p;
    }
    if (upAt.has(key)) at = Math.max(at, upAt.get(key) + between(8, 30));
    const dwell = between(40, 95);
    events.push({ at, type: "down", key });
    lastUp = at + dwell;
    upAt.set(key, lastUp);
    events.push({ at: lastUp, type: "up", key });
  }
  if (shift) events.push({ at: lastUp + between(10, 40), type: "up", key: "Shift" });
  return events.sort((a, b) => a.at - b.at || (a.type === b.type ? 0 : a.type === "down" ? -1 : 1));
}

// browser_type with slowly: a slower hand, about 90 ms a key (a slower typingPace stays slower).
export const SLOW_TYPE_PACE = 0.7;
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Types text on the page's keyboard: each key down and up when the schedule says.
async function typeKeys(keys, text, pace, rng, wait) {
  const start = Date.now();
  for (const e of keystrokeSchedule(text, pace, rng)) {
    const due = start + e.at - Date.now();
    if (due > 0) await wait(due);
    await (e.type === "down" ? keys.down(e.key) : keys.up(e.key));
  }
}
// What a field holds: an input's or textarea's value, a contenteditable's text, else null (also
// when the page has replaced the element since: every wait here is short).
const readBack = (loc) => loc.inputValue({ timeout: 1500 }).catch(() => loc.evaluate((el) => (el.isContentEditable ? el.textContent : null), undefined, { timeout: 1500 }).catch(() => null));
// What the field with the focus holds (where the keys went, also when the page swapped the element
// for another as it was typed in, as a search box with suggestions does): as readBack, else null.
const readFocused = (page) => within(1500, page.evaluate(() => { const a = document.activeElement; return a && typeof a.value === "string" ? a.value : a?.isContentEditable ? a.textContent : null; })).catch(() => null);
// Clears what a focused field holds, as a hand does: select all, Backspace.
async function clearField(keys, between, wait) {
  await keys.press("ControlOrMeta+a");
  await wait(between(30, 90));
  await keys.press("Backspace");
  await wait(between(40, 120));
}
// How a typed value stayed, read back: { line, failed }. done: the line when it did; said: how the
// line starts when the page kept something else ("Filled Name", "Typed into Name"); plain: the value
// may be said in the result (not a secret).
function afterTyping(label, value, now, plain, said, done) {
  if (now === value || now === null) return { line: done, failed: false };
  if (now === "") return { line: `${label} didn't take what was typed: it is empty.`, failed: true };
  // The page's own spelling of it (a phone mask) may be said; anything else is page content, not.
  if (plain && now.replace(/\W/g, "") === value.replace(/\W/g, "")) return { line: `${said}; the page shows it as "${now.slice(0, 80)}".`, failed: false };
  return { line: `${said}; the page changed what was typed.`, failed: false };
}
const errorLine = (error) => String(error?.message || error).split("\n")[0].slice(0, 160);

// browser_type in the native browser: the field focused by the engine's own reach and click (none
// when it has the focus already), what it holds cleared (slowly: typed at the caret, as the key-by-key
// path always did), the text key by key (keystrokeSchedule) at settings.typingPace, or slowly at
// SLOW_TYPE_PACE when that is slower; read back. item: { target (aria ref), name, value, shown } as
// in humanFill. Returns { line, failed }. trace: one line on how it went (the daemon log).
export async function humanType(page, item, settings, { rng = Math.random, wait = defaultWait, trace = null, slowly = false } = {}) {
  const between = (a, b) => a + (b - a) * rng();
  const keys = page.keyboard;
  const label = item.name || item.target;
  const value = String(item.value ?? "");
  const plain = String(item.shown ?? value) === value;
  const pace = slowly ? Math.max(settings.typingPace, SLOW_TYPE_PACE) : settings.typingPace;
  const loc = page.locator(`aria-ref=${item.target}`).first();
  // How long each step took (the trace line): the daemon log shows where a slow page spent it.
  const steps = [];
  let at = Date.now();
  const step = (name) => { steps.push(`${name} ${Date.now() - at}`); at = Date.now(); };
  let how = "click", result;
  try {
    const focused = await loc.evaluate((el) => { const a = document.activeElement; return !!a && a !== document.body && (a === el || el.contains(a)); }, undefined, { timeout: 1500 }).catch(() => false);
    step("check");
    if (focused) how = "focused";
    else { await loc.click({ timeout: 5000 }); await wait(between(60, 140)); step("click"); }
    // What it holds, read from the field with the focus: the one clicked, or the one the page put
    // in its place on the click (a ref to the old one would wait out its timeouts, 3 s).
    const had = (await readFocused(page)) ?? await readBack(loc);
    step("read");
    if (!slowly && had?.length) { await clearField(keys, between, wait); step("clear"); }
    await typeKeys(keys, value, pace, rng, wait);
    step("type");
    const now = await readFocused(page);
    step("read");
    const said = `Typed into ${label}`, done = `${said}.`;
    // Slowly: the text went in at the caret, next to what the field held.
    if (!slowly) result = afterTyping(label, value, now, plain, said, done);
    else if (now === null || now.includes(value)) result = { line: done, failed: false };
    else if (now === (had ?? "")) result = { line: `${label} didn't take what was typed${now === "" ? ": it is empty" : ""}.`, failed: true };
    else result = { line: `${said}; the page changed what was typed.`, failed: false };
  } catch (error) {
    step("failed");
    result = { line: `${label} couldn't be typed into: ${errorLine(error)}`, failed: true };
  }
  trace?.(`browser_type, ${value.length} characters${slowly ? " slowly" : ""}: ${label} by ${how}: ${steps.join(", ")} ms`);
  return result;
}

// In the page: whether the Tab key would land on this element from the one that has the focus.
// "tab": it is next in the page's tab order; "focused": it has the focus already; "no": somewhere
// else (or a list of suggestions is open on the focused field, where Tab may pick one).
function nextByTab(el) {
  const active = document.activeElement;
  if (active && active !== document.body && (active === el || el.contains(active))) return "focused";
  if (active && (active.getAttribute("aria-expanded") === "true" || active.hasAttribute("aria-activedescendant"))) return "no";
  const index = (n) => { const t = n.getAttribute("tabindex"); return t !== null && /^-?\d+$/.test(t) ? Number(t) : n.tabIndex; };
  const shown = (n) => { if (!n.getClientRects().length || n.closest("[inert]")) return false; const s = getComputedStyle(n); return s.visibility !== "hidden" && s.display !== "none"; };
  const grouped = (n) => n.tagName === "INPUT" && n.type === "radio" && !n.checked && n.name && [...document.getElementsByName(n.name)].some((o) => o !== n && o.checked && o.form === n.form);
  const all = [...document.querySelectorAll('input, select, textarea, button, a[href], area[href], iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]')]
    .filter((n) => !n.disabled && n.type !== "hidden" && index(n) >= 0 && shown(n) && !grouped(n));
  const rank = (i) => (i === 0 ? Infinity : i);
  const order = all.map((n, i) => [n, index(n), i]).sort((a, b) => rank(a[1]) - rank(b[1]) || a[2] - b[2]).map((x) => x[0]);
  // Nothing focused yet (a fresh page): the first Tab goes to the first field.
  if (!active || active === document.body) return order[0] === el ? "tab" : "no";
  const i = order.indexOf(active);
  return i >= 0 && order[i + 1] === el ? "tab" : "no";
}

// In the page: how to pick an option on a focused select by typing, as a person does: the shortest
// start of its text that is its alone (prefix; null when none within 8 keys), where it is (to) and
// what is chosen now (from). null: not a select, or no such option.
function selectByTyping(el, label) {
  if (el.tagName !== "SELECT") return null;
  const texts = [...el.options].map((o) => (o.label || o.text).trim());
  const to = texts.findIndex((t) => t === label.trim());
  if (to < 0) return null;
  const lower = texts.map((t) => t.toLowerCase());
  for (let n = 1; n <= Math.min(8, lower[to].length); n++) {
    if (lower.findIndex((t) => t.startsWith(lower[to].slice(0, n))) === to) return { from: el.selectedIndex, to, prefix: texts[to].slice(0, n) };
  }
  return { from: el.selectedIndex, to, prefix: null };
}

// browser_fill_form in the native browser, field by field in the order given, as a person fills a
// form: on to each field by Tab when it is next in the page's order (settings.formMove "tab"), by
// mouse otherwise (the engine's own reach and click); the value typed key by key (keystrokeSchedule);
// a choice by arrow keys on a focused select, else the engine's own; a box ticked by Space when
// focused, else by its click. Every field is read back. items: [{ target (aria ref), name, type,
// value (what goes in), shown (what the result may say: a secret shows its name) }].
// Returns { lines, failed }. A field whose value doesn't stay is said so; the rest go on. trace: one
// line on how each field was reached and how long it took (the daemon log). isoDate: a date in
// another spelling as YYYY-MM-DD, or null (runner.mjs).
const DATE_SHAPES = { date: "YYYY-MM-DD", "datetime-local": "YYYY-MM-DDThh:mm", month: "YYYY-MM", week: "YYYY-Www", time: "hh:mm" };
export async function humanFill(page, items, settings, { rng = Math.random, wait = defaultWait, trace = null, isoDate: toIso = () => null } = {}) {
  const between = (a, b) => a + (b - a) * rng();
  const keys = page.keyboard;
  const lines = [], took = [];
  let failed = false;
  const type = (text) => typeKeys(keys, text, settings.typingPace, rng, wait);
  for (const item of items) {
    const label = item.name || item.target;
    const value = String(item.value ?? "");
    const shown = String(item.shown ?? value);
    const plain = shown === value; // the value may be said in the result
    const loc = page.locator(`aria-ref=${item.target}`).first();
    const started = Date.now();
    let how = "mouse", typedAt = null;
    try {
      let focused = false;
      if (settings.formMove === "tab") {
        const next = await loc.evaluate(nextByTab, undefined, { timeout: 1500 }).catch(() => "no");
        if (next === "focused") focused = true;
        else if (next === "tab") {
          // A date or time field just left has parts (month, day, year): Tab moves through them
          // first, up to three more presses while the focus stays in that same field.
          for (let presses = 0; presses < 4 && !focused; presses++) {
            await keys.press("Tab");
            await wait(between(50, 120));
            const at = (await within(2500, loc.evaluate((el) => {
              const active = document.activeElement;
              if (el === active || el.contains(active)) return "here";
              return active?.tagName === "INPUT" && /^(date|time|month|week|datetime-local)$/.test(active.type) ? "parts" : "elsewhere";
            }, undefined, { timeout: 1500 }).catch(() => "elsewhere"))) ?? "elsewhere";
            if (at === "here") focused = true;
            else if (at !== "parts") break;
          }
        }
        if (focused) how = next;
      }
      // A date, time, month or week field takes one exact shape (YYYY-MM-DD, hh:mm): key by key
      // leaves garbage, so it is set at once (a date in another spelling becomes YYYY-MM-DD when
      // it can only mean one day). Focused by Tab or not, the field is where a person's eyes are.
      const dated = item.type === "textbox" ? await loc.evaluate((el) => (el.tagName === "INPUT" && /^(date|time|month|week|datetime-local)$/.test(el.type) ? el.type : ""), undefined, { timeout: 1500 }).catch(() => "") : "";
      if (dated) {
        const exact = dated === "date" ? toIso(value) || value : value;
        const human = page._pairbrowseHumanized;
        page._pairbrowseHumanized = false;
        try { await loc.fill(exact, { timeout: 5000 }); } finally { page._pairbrowseHumanized = human; }
        const now = await loc.inputValue({ timeout: 1500 }).catch(() => null);
        if (now === exact) lines.push(`Filled ${label} with ${plain ? exact : shown}.`);
        else { failed = true; lines.push(`${label} didn't take ${plain ? `"${value.slice(0, 40)}"` : "it"}: a ${dated} field takes ${DATE_SHAPES[dated]}.`); }
      } else if (item.type === "checkbox" || item.type === "radio") {
        const want = value === "true";
        if ((await loc.isChecked({ timeout: 3000 })) !== want) {
          if (focused) { await keys.press("Space"); await wait(between(40, 110)); }
          if ((await loc.isChecked({ timeout: 3000 })) !== want) await loc.setChecked(want, { timeout: 5000 });
        }
        lines.push(`${want ? "Ticked" : "Unticked"} ${label}.`);
      } else if (item.type === "combobox") {
        // Focused: the option's first letters, as a person picks on a closed select (arrow keys open
        // the menu on macOS). Else, or when that didn't choose it: the engine's own way.
        let chosen = false;
        if (focused) {
          const pick = await loc.evaluate(selectByTyping, value, { timeout: 1500 }).catch(() => null);
          if (pick?.from === pick?.to && pick) chosen = true;
          else if (pick?.prefix) {
            await type(pick.prefix);
            await wait(between(60, 140));
            chosen = (await loc.evaluate((el) => el.selectedIndex, undefined, { timeout: 1500 }).catch(() => -1)) === pick.to;
          }
        }
        if (!chosen) await loc.selectOption({ label: value }, { timeout: 5000 });
        lines.push(`Chose ${shown} for ${label}.`);
      } else if (item.type === "slider") {
        await loc.fill(value, { timeout: 5000 });
        lines.push(`Set ${label} to ${shown}.`);
      } else {
        if (!focused) { await loc.click({ timeout: 5000 }); await wait(between(60, 140)); }
        const had = await readBack(loc);
        if (had?.length) await clearField(keys, between, wait);
        typedAt = Date.now();
        await type(value);
        const typed = afterTyping(label, value, await readBack(loc), plain, `Filled ${label}`, `Filled ${label} with ${shown}${/[.!?]$/.test(shown) ? "" : "."}`);
        if (typed.failed) failed = true;
        lines.push(typed.line);
      }
    } catch (error) {
      failed = true;
      const verb = { checkbox: "ticked", radio: "ticked", combobox: "chosen in" }[item.type] || "filled";
      lines.push(`${label} couldn't be ${verb}: ${errorLine(error)}`);
    }
    took.push(`${label} by ${how} ${typedAt ? `${typedAt - started}+${Date.now() - typedAt}` : Date.now() - started} ms`);
  }
  trace?.(`browser_fill_form, ${items.length} fields: ${took.join(", ")}`);
  return { lines, failed };
}
