// Fast mode's steps: stepsIn runs each step of a run (fill, check, select, click, press, drag,
// scroll, upload, wait, expect, handoff) and says how far it got.
import { SENSITIVE } from "../rules/policy.mjs";
import { hostAllowed } from "../rules/secrets.mjs";
import { clickClass, strongSignal } from "../rules/clicks.mjs";
import { uploadFiles } from "../upload.mjs";
import { addressOnly } from "../log.mjs";
import { sleep, within, bounded } from "../util.mjs";
import { buttonLabel } from "../daemon/page.mjs";
import { activatingKey, contextAt, enterButtonLabel, riskAt, riskReason } from "./risk.mjs";
import { byFirstOption, byNearbyText, clickable, cssString, exactlyClickable, field, find, formRoots, hiddenNow, onlyOne, openSectionOf, unfold, viewSize, visibleSoon } from "./locate.mjs";
import { choicesBefore, chooseNative, clearChoices, hiddenDropdown, labelOpener, nativeNamed, pickFromOpened, pickSuggestion } from "./choices.mjs";
import { isoDate, sameDate } from "./dates.mjs";

// Cancel passive waits when a participant disconnects; active browser operations finish
// before the daemon releases their queued turn.
async function waitOrDisconnect(promise, signal) {
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new Error("Participant disconnected."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

// Runs steps on page. hooks: { secrets: {values, domains}, uploadsDir, signal, beforeStep(kind, el),
// status(text, kind), activity(text), cursor(el, act), remember(label, value, site), owner(el) }.
// beforeStep gets "enter" for an Enter press, and a click's element. owner(el): the person
// filling that field ({ who }) or null: such a field is skipped (in skipped) and the run goes on.
// Fast mode is just fast: the engine's human-like mouse and typing (on by default for single
// actions) are off for the run, and a scroll step goes at once. hooks.smooth: a single action
// (pairbrowse_scroll) that glides like a person.
// Why a run stops at a page's confirm or prompt dialog ({ type, message }, popups.mjs).
const dialogStop = (d, what) => `${what} opened the page's own ${d.type} dialog: "${d.message}". The page waits on it, so nothing more was done. ` +
  `Decide with the user, answer it with browser_handle_dialog (accept, or dismiss), then run the remaining steps.`;

// A stroke's pace: one small move this often (a steady hand drawing).
const STROKE_STEP_MS = 8;
const strokeEnds = new WeakMap(); // page -> where its last stroke let go (moves the humanized mouse doesn't know of)
// How long a handoff waits for the user (a sign-in, a CAPTCHA).
const HANDOFF_MS = 10 * 60_000;

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
  let lastTyped = null; // the field a fill step typed last (an Enter right after it goes there)
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step)[0];
    const fail = (why) => ({ ok: false, done, skipped, stoppedAt: i + 1, why });
    trace(`step ${i + 1} (${kind})`);
    // Out of time (the run's deadline), or the agent left: stop here, between steps.
    if (hooks.signal?.aborted && i > 0) return fail(`This run took too long (${Math.round((Date.now() - started) / 1000)} s on the steps before this one: a slow or restless page). Take a browser_snapshot, then run the remaining steps.`);
    // A field missing after earlier steps of this run: forms add and remove fields as they're answered.
    const gone = () => (touched.length ? " An earlier answer in this run may have removed it (forms add and remove fields as they're filled): take a snapshot, then fill what's there now." : "");
    try {
      if (kind !== "click") await hooks.beforeStep?.(kind === "press" && activatingKey(arg) === "enter" ? "enter" : kind);
      if (kind === "go") {
        // Wait for the page to arrive, not for every script and image: a slow resource on the
        // site mustn't fail the step when the page itself is there and usable.
        await page.goto(arg, { waitUntil: "commit", timeout: 30000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        // Sites built in JavaScript draw their forms a moment after the page arrives.
        await page.locator("input:not([type=hidden]), textarea, select").first().waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
        hooks.activity(`Opened ${addressOnly(arg)}`);
      } else if (kind === "fill") {
        const filled = [];
        const suggestionsSeen = new Map(); // label -> what a suggesting field offered
        for (const [label, raw] of Object.entries(arg)) {
          // A person using the tab: wait until they're done, then go on (their fields stay theirs).
          await hooks.holdForPeople?.();
          trace(`step ${i + 1}: finding "${label}"`);
          let el = await field(page, label);
          if (!el && (await openSectionOf(page, label))) el = await field(page, label);
          // Folded away by a compact layout (a search box behind a "Search" button): unfolded once.
          const u = el ? null : await unfold(page, label, () => field(page, label), hooks);
          if (u?.el) el = u.el;
          if (!el) {
            // Its input hidden inside a box a person clicks: a styled dropdown, picked with select.
            const box = await hiddenDropdown(page, label);
            if (box) { await box.evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {}); return fail(`"${label}" is a dropdown: use a select step with the option's text ({"select": {"${label}": "..."}}).`); }
            return fail(u.note ? `No field "${label}" shows.${u.note}${gone()}` : await hiddenNow(page, label) ? `"${label}" is hidden right now: the form shows it only for some answers. Leave it, or change the answer it depends on.` : `No field "${label}".${gone()}`);
          }
          if (await theirs(el, label)) continue;
          // The element itself is held from here: a field named by text that goes away once it holds
          // a value (its label drawn in the box as its placeholder) can't be found by that name after
          // the fill, and every later look at it would wait for the name instead.
          el = (await el.elementHandle({ timeout: 1000 }).catch(() => null)) || el;
          let value = String(raw);
          const isSecret = Object.hasOwn(hooks.secrets.values, value);
          // Remember what was filled for next time; never passwords or one-time codes.
          if (!isSecret && value && !SENSITIVE.test(label) && !hooks.left) {
            const type = await bounded(el.getAttribute("type"), null);
            if (type !== "password") hooks.remember?.(label, value, (() => { try { return new URL(page.url()).hostname; } catch { return ""; } })());
          }
          if (isSecret) {
            // The address of the document the field is in: a frame's own, not the page around it.
            const where = await within(2000, el.evaluate(() => location.href)).catch(() => "");
            if (!where || !hostAllowed(where, hooks.secrets.domains[value] || []) || !hostAllowed(page.url(), hooks.secrets.domains[value] || [])) return fail(`${value} may only be typed on HTTPS pages of ${(hooks.secrets.domains[value] || []).join(", ") || "(no domains set)"}; this field is on ${where || page.url()}. Hand this field to the user.`);
            value = hooks.secrets.values[value];
          }
          await hooks.cursor?.(el, "type"); // sent (and the press declared) before the field is touched
          // A field that suggests as you type (a combobox): a person picks the suggestion that
          // matches; typing alone often doesn't count. Wait briefly for the list, then click it.
          const kindOf = await within(2000, el.evaluate((n) => ({ readOnly: !!n.readOnly, number: n.type === "number", date: n.type === "date" }))).catch(() => ({}));
          // A date field takes YYYY-MM-DD: a date written another way is turned into that when it
          // can only mean one day (03/15/1990, 15.03.1990, March 15, 1990); an ambiguous one (03/04) isn't.
          if (kindOf.date && !isSecret) value = isoDate(value) || value;
          if (kindOf.readOnly) return fail(`"${label}" can't be typed into (a picker): use a select step with the choice's text ({"select": {"${label}": "..."}}).`);
          if (kindOf.number && !/^-?\d+([.,]\d+)?$/.test(value.trim())) return fail(`"${label}" takes a number only (it got "${value.slice(0, 40)}").`);
          const suggests = !isSecret && (await within(2000, el.evaluate((n) => n.getAttribute("role") === "combobox" || !!n.getAttribute("aria-autocomplete") || n.hasAttribute("aria-controls") && n.getAttribute("aria-haspopup") === "listbox")).catch(() => false));
          const mark = suggests ? await choicesBefore(page) : "";
          trace(`step ${i + 1}: filling "${label}"`);
          try {
            await el.fill(value, { timeout: 5000 });
          } catch (e) {
            const m = String(e?.message);
            if (/type "(radio|checkbox)" cannot be filled/i.test(m)) return fail(`"${label}" is a choice to tick, not a text field: use a check step with the choice's own text ({"check": "..."}).`);
            if (/not an <input>|not an input|contenteditable/i.test(m)) {
              // The name matched something else first (a floating label, a wrapper): the text box
              // named that, when there is one.
              const box = await find(page, [(root) => root.getByRole("textbox", { name: label, exact: true }), (root) => root.getByRole("textbox", { name: label })]);
              if (box && (await box.fill(value, { timeout: 5000 }).then(() => true, () => false))) { el = (await box.elementHandle({ timeout: 1000 }).catch(() => null)) || box; filled.push({ el, label, value, secret: isSecret }); continue; }
              return fail(`"${label}" isn't a text field (it's a dropdown or a button): use a select step ({"select": {"${label}": "..."}}) or click it.`);
            }
            if (/Malformed value/i.test(m)) {
              const type = await within(2000, el.evaluate((n) => n.type)).catch(() => "");
              const shape = { date: "YYYY-MM-DD", "datetime-local": "YYYY-MM-DDThh:mm", month: "YYYY-MM", week: "YYYY-Www", time: "hh:mm", color: "#rrggbb" }[type];
              return fail(`"${label}" is a ${type || "special"} field: it takes ${shape ? `a value like ${shape}` : "a value in its own format"} (it got "${value.slice(0, 40)}").`);
            }
            if (/Timeout/i.test(m)) return fail(`"${label}" didn't take typing: it's read-only, disabled or covered by something (a banner, a closed section). Look at the screenshot: open or uncover it first, or skip it.`);
            throw e;
          }
          if (suggests) {
            trace(`step ${i + 1}: picking a suggestion for "${label}"`);
            let s2 = await pickSuggestion(page, el, value, mark, "", hooks).finally(() => clearChoices(page, mark));
            // Nothing matched the whole text: as a person would, type less (its first word, then its
            // first letters) and take the suggestion that matches the value.
            for (const shorter of [String(value).trim().split(/\s+/)[0], String(value).trim().slice(0, 3)]) {
              if (s2.picked || !shorter || shorter === String(value).trim()) continue;
              const m2 = await choicesBefore(page);
              await el.fill(shorter, { timeout: 5000 }).catch(() => {});
              s2 = await pickSuggestion(page, el, value, m2, shorter, hooks).finally(() => clearChoices(page, m2));
            }
            if (s2.picked) { hooks.activity(`Picked a suggestion for **${label}**`); touched.push({ el, label }); continue; }
            suggestionsSeen.set(label, s2.seen.map((c) => c.text));
            await el.fill(value, { timeout: 5000 }).catch(() => {});
          }
          filled.push({ el, label, value, secret: isSecret });
        }
        // Check every field kept its value once focus has moved on: date pickers, masks and
        // autocompletes can throw a filled value away on blur. Retype those key by key; if one
        // still doesn't keep it, stop and say so rather than report it done.
        // Leave each field with Tab, like a person: a picker that didn't take a pasted value clears it then.
        // The same value, also when the field only formatted it (a phone or card mask adding spaces,
        // dashes, dots or brackets: "4155550142" shown as "(415) 555-0142").
        const bare = (v) => String(v).replace(/\r\n/g, "\n").trim();
        // A phone field may also put the country's code in front ("+1 415 555 0142").
        const digits = (v) => bare(v).replace(/[\s\-()./]/g, "");
        // Or take it off when the form picks the country separately ("+1 415 555 0142" shown as "415 555 0142").
        const coded = (withCode, plain) => /^\+\d{1,4}/.test(withCode) && /^\d{6,}$/.test(plain) && withCode.endsWith(plain) && withCode.length - plain.length >= 2 && withCode.length - plain.length <= 5;
        const same = (a, b) => sameDate(a, b) || bare(a) === bare(b) || (/\d/.test(b) && (digits(a) === digits(b) || coded(digits(a), digits(b)) || coded(digits(b), digits(a))));
        for (const f of filled) {
          trace(`step ${i + 1}: checking "${f.label}" kept its value`);
          const multiline = await within(2000, f.el.evaluate((n) => n.tagName === "TEXTAREA" || n.isContentEditable)).catch(() => true);
          if (!multiline) await within(3000, f.el.press("Tab", { timeout: 2000 }).catch(() => {}));
          const now = await within(3000, f.el.inputValue({ timeout: 2000 }).catch(() => null));
          if (now !== null && !f.secret && coded(digits(f.value), digits(now))) {
            // Kept without its country code: the form takes the country from its own picker.
            f.note = `shows "${now}": the field dropped ${digits(f.value).slice(0, digits(f.value).length - digits(now).length)}; make sure the form's country or code picker shows that country`;
          } else if (now !== null && !f.secret && digits(now) !== digits(f.value) && !sameDate(now, f.value) && same(now, f.value)) {
            // Kept, with a country code the field put in front: right only if that's the number's country.
            f.note = `shows "${now}": the field put ${digits(now).slice(0, digits(now).length - digits(f.value).length)} in front; if the number is from another country, choose that country in the field first`;
          }
          if (now === null || same(now, f.value)) continue; // not a plain field (contenteditable): nothing to read
          // A phone field that reads each keystroke as part of a number with its country code: the
          // number in one piece ("+14155550142") is what it parses best.
          const compact = digits(f.value);
          if (!f.secret && /^\+?\d{7,15}$/.test(compact) && compact !== bare(f.value)) {
            await f.el.fill(compact, { timeout: 3000 }).catch(() => {});
            if (!multiline) await f.el.press("Tab", { timeout: 2000 }).catch(() => {});
            const kept = await f.el.inputValue({ timeout: 2000 }).catch(() => null);
            if (kept !== null && same(kept, f.value)) continue;
          }
          await within(4000, f.el.fill("", { timeout: 3000 }).catch(() => {}));
          await hooks.cursor?.(f.el, "click"); // its own click, never taken for a person's
          await within(4000, f.el.click({ timeout: 3000 }).catch(() => {}));
          // (A held element types with type(): its pressSequentially.) Each key waits for the
          // page to take it: a page whose scripts stopped pausing takes none, so the typing is
          // bounded and the run says so instead of waiting on it.
          const typed = await within(20_000, (typeof f.el.pressSequentially === "function" ? f.el.pressSequentially(f.value, { delay: 15, timeout: 15000 }) : f.el.type(f.value, { delay: 15, timeout: 15000 })).then(() => true, () => true));
          if (typed === null) return fail(`"${f.label}": the page stopped answering while it was retyped (its scripts are busy without pause, or it froze). Wait a moment and try again, or reload the page with browser_navigate.`);
          await within(3000, f.el.press("Tab", { timeout: 2000 }).catch(() => {}));
          const after = await within(3000, f.el.inputValue({ timeout: 2000 }).catch(() => null));
          if (after !== null && !same(after, f.value)) {
            const offered = suggestionsSeen.get(f.label);
            const code = !f.secret && /^\+/.test(String(after).trim()) && !/^\+/.test(bare(f.value)) ? " It puts a country code in front: fill the number with its code, like +1 415 555 0142." : "";
            return fail(`"${f.label}" didn't keep the value${f.secret ? "" : ` "${f.value}"`} (it shows ${f.secret ? "something else" : `"${after}"`}).${code}${offered?.length ? ` It suggested: ${offered.slice(0, 20).join(", ")}; fill one of those.` : offered ? " It suggests as you type but offered nothing for that text (or a shorter part of it): try another wording, or use a select step." : " It may need its picker or a different format: check the screenshot, then fill it step by step."}`);
          }
        }
        for (const f of filled) touched.push({ el: f.el, label: f.label, note: f.note, secret: f.secret, value: f.secret ? undefined : String(f.value) });
        lastTyped = filled.at(-1)?.el || null;
        if (filled.length) hooks.activity(`Filled ${filled.map((f) => `**${f.label}**`).join(", ")}`);
      } else if (kind === "check" || kind === "uncheck") {
        // Also a bare box followed by its text, with no label element ("<input> checkbox 1").
        const bare = String(arg).includes('"') ? null : (root) => root.locator(`xpath=//text()[normalize-space(.)="${String(arg).trim()}"]/preceding-sibling::input[@type="checkbox" or @type="radio"][1]`);
        // Any kind of quote mark in the name matches any other ("Submit" / 'Submit' / “Submit”).
        const quoteless = new RegExp(String(arg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/["'“”‘’]/g, "[\"'“”‘’]"), "i");
        const el = await find(page, [(root) => root.getByLabel(arg, { exact: true }), (root) => root.getByRole("checkbox", { name: arg }), (root) => root.getByRole("radio", { name: arg }), (root) => root.getByLabel(arg), ...(bare ? [bare] : []),
          (root) => root.getByRole("checkbox", { name: quoteless }), (root) => root.getByRole("radio", { name: quoteless })]);
        if (!el) {
          // A styled box: the real checkbox is hidden and its text (beside it, not a <label>) is what
          // a person clicks. Click that text, then make sure the box really changed.
          let hidden = null;
          for (const root of await formRoots(page)) {
            const box = root.getByRole("checkbox", { name: String(arg), exact: true }).first();
            if (await bounded(box.count(), 0)) { hidden = box; break; }
          }
          const want = kind === "check";
          const was = hidden ? await hidden.isChecked({ timeout: 1500 }).catch(() => null) : null;
          const text = was === null ? null : await find(page, [(root) => root.getByText(String(arg), { exact: true }), (root) => root.getByText(String(arg))]);
          if (!text) {
            const u = await unfold(page, String(arg), () => find(page, [(root) => root.getByLabel(arg, { exact: true }), (root) => root.getByRole("checkbox", { name: arg }), (root) => root.getByRole("radio", { name: arg }), (root) => root.getByLabel(arg)]), hooks);
            if (!u.el) return fail(`No checkbox "${arg}"${u.note ? " shows." : "."}${u.note}${gone()}`);
            if (await theirs(u.el, String(arg))) { done.push(kind); continue; }
            await hooks.cursor?.(u.el, "click");
            await (kind === "check" ? u.el.check({ timeout: 3000 }) : u.el.uncheck({ timeout: 3000 }));
            touched.push({ el: u.el, label: String(arg) });
            hooks.activity(`${kind === "check" ? "Ticked" : "Unticked"} **${arg}**`);
            done.push(kind);
            continue;
          }
          if (was !== want) {
            await hooks.cursor?.(text, "click");
            await text.click({ timeout: 5000 });
            if ((await hidden.isChecked({ timeout: 1500 }).catch(() => null)) !== want) return fail(`Clicked "${String(arg).slice(0, 60)}" but its box is still ${want ? "unticked" : "ticked"}. Look at the screenshot and click the box itself.`);
          }
          hooks.activity(`${want ? "Ticked" : "Unticked"} **${arg}**`);
          touched.push({ el: hidden, label: String(arg) });
          done.push(kind);
          continue;
        }
        if (await theirs(el, String(arg))) { done.push(kind); continue; }
        await hooks.cursor?.(el, "click"); // sent before the press, which puts it on the click
        // A box drawn over by its styled look: click its label as a person does, then make sure.
        await (kind === "check" ? el.check({ timeout: 3000 }) : el.uncheck({ timeout: 3000 })).catch(async () => {
          const label = await el.evaluate((n) => !!n.labels?.length, undefined, { timeout: 1500 }).catch(() => false);
          if (label) await el.evaluate((n) => n.labels[0].click(), undefined, { timeout: 1500 }).catch(() => {});
          if ((await el.isChecked({ timeout: 1500 }).catch(() => null)) !== (kind === "check")) {
            const shown = await within(1500, el.isVisible()).catch(() => false);
            throw new Error(shown ? `Couldn't ${kind} "${String(arg).slice(0, 60)}": something covers it. Look at the screenshot.` : `"${String(arg).slice(0, 60)}" is hidden right now: the form shows it only for some answers (an earlier answer in this run may have removed it). Leave it, or change the answer it depends on.`);
          }
        });
        touched.push({ el, label: String(arg) });
        hooks.activity(`${kind === "check" ? "Ticked" : "Unticked"} **${arg}**`);
      } else if (kind === "select") {
        for (const [label, option] of Object.entries(arg)) {
          // Named exactly first: "Country" is never taken for "Country code" when both are there.
          let el = await find(page, [(root) => root.getByLabel(label, { exact: true }), (root) => root.getByRole("combobox", { name: label, exact: true }),
            (root) => root.getByRole("button", { name: label, exact: true }),
            (root) => root.locator(`select[name="${cssString(label)}"], select[id="${cssString(label)}"]`)]);
          // A native <select> by that exact name that's drawn invisible (a styled box shows instead).
          if (!el || !(await bounded(el.evaluate((n) => n.tagName === "SELECT"), false))) {
            const native = await nativeNamed(page, label);
            if (native) {
              if (await theirs(native, label)) continue;
              const picked = await chooseNative(native, option);
              if (!picked.picked) return fail(`"${label}" has no option "${option}". Its options: ${picked.options.join(", ")}.`);
              touched.push({ el: native, label, want: picked.picked });
              continue;
            }
          }
          // A label whose own field is missing or hidden, beside the one button that opens its list.
          if (!el) el = await labelOpener(page, label);
          // A <select> named only by the text before or beside it (no label), or by its own first
          // choice ("Organization Type*", a placeholder the form shows in the box).
          if (!el) for (const root of await formRoots(page)) { const hit = await byNearbyText(root, label) || await byFirstOption(root, label); if (hit && (await bounded(hit.evaluate((n) => n.tagName === "SELECT"), false))) { el = hit; break; } }
          // Then a name that holds the words ("Country*", "Select your country"); last, the page's one
          // unnamed dropdown, when nothing else on the page carries the name.
          if (!el) el = await find(page, [(root) => root.getByRole("combobox", { name: label }), (root) => root.getByLabel(label), (root) => root.getByRole("button", { name: label })]) || await onlyOne(page, "select", label);
          // A styled dropdown whose own input is hidden (0x0 inside the box a person clicks): open
          // the box around it, then pick the option as for any styled list.
          const control = el ? null : await hiddenDropdown(page, label);
          // A native <select> drawn invisible over (or under) its styled box: chosen as its own list
          // would, with the events a person's choice fires.
          if (control && (await bounded(control.field.evaluate((n) => n.tagName === "SELECT"), false))) {
            await control.evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {});
            const picked = await chooseNative(control.field, option);
            if (!picked.picked) return fail(`"${label}" has no option "${option}". Its options: ${picked.options.join(", ")}.`);
            touched.push({ el: control.field, label, want: picked.picked });
            continue;
          }
          if (control) {
            const why = await pickFromOpened(page, control, option, label, hooks).finally(() => control.evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {}));
            if (why) return fail(why);
            touched.push({ el: control.field, label });
            continue;
          }
          if (!el) {
            const u = await unfold(page, label, () => find(page, [(root) => root.getByLabel(label, { exact: true }), (root) => root.getByRole("combobox", { name: label, exact: true }), (root) => root.getByRole("button", { name: label, exact: true }), (root) => root.getByRole("combobox", { name: label }), (root) => root.getByLabel(label)]), hooks);
            if (u.el) el = u.el;
            else return fail(u.note ? `No dropdown "${label}" shows.${u.note}${gone()}` : await hiddenNow(page, label) ? `"${label}" is hidden right now: the form shows it only for some answers. Leave it, or change the answer it depends on.` : `No dropdown "${label}".${gone()}`);
          }
          if (await theirs(el, label)) continue;
          await hooks.cursor?.(el, "click");
          const isSelect = await bounded(el.evaluate((n) => n.tagName === "SELECT"), false);
          if (isSelect) {
            // An option it doesn't have: say which ones it has rather than wait for it.
            const options = await bounded(el.evaluate((n) => [...n.options].map((o) => [o.label || o.text, o.value])), []);
            const want = String(option);
            if (options.length && !options.some(([l, v]) => l.trim() === want || v === want)) {
              // The one option holding that text ("US - United States" for "United States").
              const near = await chooseNative(el, want);
              if (near.picked) { touched.push({ el, label, want: near.picked }); continue; }
              return fail(`"${label}" has no option "${want}". Its options: ${options.map(([l]) => l.trim()).filter(Boolean).slice(0, 25).join(", ")}${options.length > 25 ? ", ..." : ""}.`);
            }
            const chosen = await el.selectOption({ label: want }, { timeout: 3000 }).then(() => true, () => el.selectOption(want, { timeout: 3000 }).then(() => true, () => false));
            if (!chosen) {
              const off = await bounded(el.evaluate((n) => n.disabled || !!n.closest("fieldset[disabled]")), false);
              return fail(`"${label}" didn't take "${want}": ${off ? "it's disabled until another answer is given (often the field before it)" : "something covers it or it's waiting for another answer"}. Fill the fields above it first, then choose again.`);
            }
          }
          else {
            // A styled dropdown (a button or combobox with its own list): open it, click the option.
            // Its name often says the choice ("Ticket type. Round trip"), so the name it was found by
            // no longer finds it once chosen: the element itself is held for what comes after.
            const node = await el.elementHandle({ timeout: 1000 }).catch(() => null);
            const why = await pickFromOpened(page, el, option, label, hooks).finally(() => (node || el).evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {}));
            if (why) return fail(why);
            if (node) { touched.push({ el: node, label, want: "" }); continue; }
          }
          touched.push({ el, label, want: isSelect ? String(option) : "" });
        }
        hooks.activity(`Chose in ${Object.keys(arg).map((k) => `**${k}**`).join(", ")}`);
      } else if (kind === "click") {
        // A step the agent named as a final action ("Send: Reply") goes through browser_click, which asks the user.
        if (clickClass(arg)) return fail(`"${arg}" is named as a final action. Run the steps before it, then use browser_click on it so the user confirms.`);
        // Named exactly first. One named exactly but folded away (in a narrow window's hamburger
        // menu) is unfolded and clicked, never traded for a shown control that only holds the name
        // ("Installing Python modules" for "modules").
        let el = await exactlyClickable(page, String(arg));
        let u = null;
        if (!el) {
          u = await unfold(page, String(arg), () => exactlyClickable(page, String(arg)), hooks, { exact: true });
          el = u.el || null;
          if (!el && u.scan?.hidden) return fail(`"${arg}" doesn't show${u.note ? `.${u.note}` : " at this window size, and nothing on the page opens it."}${u.scan.href ? ` Its link goes to ${u.scan.href}: open that with browser_navigate.` : ""}`);
        }
        if (!el) el = await clickable(page, String(arg));
        if (!el) {
          u = await unfold(page, String(arg), () => clickable(page, String(arg)), hooks);
          if (!u.el) return fail(`Nothing to click named "${arg}"${u.note ? " shows." : "."}${u.note}`);
          el = u.el;
        }
        await hooks.beforeStep?.("click", el);
        // What the matched element does, by the page's structure, whatever it says: strong signals
        // (payment, danger, DELETE, unreadable) make it the user's to confirm; ordinary submits go.
        const real = String(await el.evaluate(buttonLabel, undefined, { timeout: 2000 }).catch(() => ""));
        const { risk } = await contextAt(page, el, "click");
        if (strongSignal(risk)) return fail(`"${arg}" is the "${real.slice(0, 60)}" button: ${riskReason(risk)}. Run the steps before it, then use browser_click on it so the user confirms.`);
        // Whether the click should take the page elsewhere: a link (same tab) to another document.
        const urlBefore = page.url();
        const goes = await within(1500, el.evaluate((n) => {
          const a = n.closest("a[href]");
          if (!a || (a.target && a.target !== "_self") || /^\s*(#|javascript:)/i.test(a.getAttribute("href") || "") || a.hasAttribute("download")) return null;
          try { const u = new URL(a.href), l = new URL(location.href); u.hash = ""; l.hash = ""; return u.href === l.href ? null : { role: "link", to: u.origin + u.pathname }; } catch { return null; }
        }).catch(() => null));
        await hooks.cursor?.(el, "click"); // sent before the press, which puts it on the click
        try {
          // A click that opens the page's own confirm or prompt never returns while the page
          // waits on it: stop as soon as the dialog is up instead of waiting the click out.
          let watching = true;
          const dialogUp = new Promise((resolve) => { const tick = () => { if (!watching) return; if (hooks.dialogOpen?.()) resolve("dialog"); else setTimeout(tick, 100); }; setTimeout(tick, 100); });
          const r = await Promise.race([el.click({ timeout: 5000 }).then(() => "clicked"), dialogUp]).finally(() => { watching = false; });
          if (r === "dialog") return { ...fail(dialogStop(hooks.dialogOpen(), "This step")), dialog: true };
        } catch (e) {
          const asked = hooks.dialogOpen?.();
          if (asked) return { ...fail(dialogStop(asked, "This step")), dialog: true };
          if (!/Timeout|intercepts pointer events|not visible|outside of the viewport/i.test(String(e?.message))) throw e;
          return fail(`"${arg}" is on the page but couldn't be clicked (hidden, covered or not ready): look at the screenshot, close what covers it or wait, then try again.`);
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        // A link to another page that left the page where it was: no "Done" for it. Said with what
        // was clicked, so the agent sees what happened and corrects it.
        if (goes) {
          for (let t = 0; t < 15 && page.url() === urlBefore; t++) await sleep(200);
          if (page.url() === urlBefore) return fail(`Clicked ${goes.role} "${real.replace(/\s+/g, " ").trim().slice(0, 80)}" for "${arg}", which links to ${goes.to}, but the page stayed on ${addressOnly(urlBefore)}. Look at the screenshot: if that wasn't the control you meant, click it by its ref with browser_click.`);
        }
        hooks.activity(`Clicked **${arg}**`);
      } else if (kind === "press") {
        const key = activatingKey(arg);
        // Enter right after a fill goes to the field typed last, as a person's would: the run's own
        // Tab (leaving each field to check it kept its value) moved the focus on.
        if (key === "enter" && lastTyped && Object.keys(steps[i - 1] || {})[0] === "fill") await within(2000, lastTyped.focus({ timeout: 1500 }).catch(() => {}));
        if (key) {
          const risk = await riskAt(page, null, key);
          if (strongSignal(risk)) {
            const label = await enterButtonLabel(page, null, key);
            return fail(`${String(arg)} here would ${label ? `press "${label.slice(0, 60)}" and ` : ""}commit something (${riskReason(risk)}). Use browser_click on its button so the user confirms.`);
          }
        }
        // Bounded: a page that stops answering ends the step with a word, not the run with a hang.
        if ((await within(10_000, page.keyboard.press(String(arg)).then(() => true))) === null) return fail(`Pressing ${String(arg)} got no answer from the page (it's busy or stuck). Take a browser_snapshot and try again.`);
      } else if (kind === "drag") {
        // Drawing, as a person does: the mouse goes down at the first point and follows the rest
        // (in the PairBrowse browser its moves take human paths and timing), then lets go.
        const [w, h] = await viewSize(page);
        const pts = arg.map(([x, y]) => ({ x: Math.round(x * w), y: Math.round(y * h) }));
        const mark = (p) => hooks.cursor?.({ boundingBox: async () => ({ x: p.x, y: p.y, width: 0, height: 0 }) }, "");
        const glide = Math.min(600, Number(await mark(pts[0])) || 0); // how long the cursor takes to get there
        // The stroke goes straight to the browser's input at a steady drawing pace: the humanized
        // mouse gives every move a hand's whole reach-and-settle time (about half a second per
        // point, seconds for a long reach) and presses where its own last move ended.
        const cdp = await page.context().newCDPSession(page);
        const send = (type, p) => cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
        const from = strokeEnds.get(page);
        if (!from) {
          // The first stroke here: the hand comes to the start as a person's does (human paths in
          // the PairBrowse browser).
          await page.mouse.move(pts[0].x, pts[0].y);
        } else {
          // From the last stroke's end: along a gentle curve, eased, in the time the cursor glides.
          const dx = pts[0].x - from.x, dy = pts[0].y - from.y;
          const n = Math.max(3, Math.round(glide / 16));
          for (let k = 1; k <= n; k++) {
            const e = (1 - Math.cos((Math.PI * k) / n)) / 2, bend = 0.08 * Math.sin(Math.PI * e);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(from.x + dx * e - dy * bend), y: Math.round(from.y + dy * e + dx * bend), button: "none", buttons: 0 });
            await new Promise((r) => setTimeout(r, glide / n));
          }
        }
        let at = pts[0];
        try {
          await send("mousePressed", at);
          // Let go whatever happens on the way: a stroke that fails must never leave the button held.
          try {
            for (const p of pts.slice(1)) {
              // A person took over (clicked, typed, paused agents): the stroke stops where it is.
              const why = hooks.interrupted?.();
              if (why) throw new Error(why);
              const n = Math.max(2, Math.min(12, Math.round(Math.hypot(p.x - at.x, p.y - at.y) / 12)));
              for (let k = 1; k <= n; k++) {
                await send("mouseMoved", { x: Math.round(at.x + (p.x - at.x) * k / n), y: Math.round(at.y + (p.y - at.y) * k / n) });
                await new Promise((r) => setTimeout(r, STROKE_STEP_MS));
              }
              at = p;
              await mark(p);
            }
          } finally {
            await send("mouseReleased", at).catch(() => {});
            strokeEnds.set(page, at);
          }
        } finally {
          cdp.detach().catch(() => {});
        }
        hooks.activity(`Drew a stroke (${pts.length} points)`);
      } else if (kind === "scroll") {
        // The cursor onto the page, then the wheel: in small eased steps that glide like a person
        // (pairbrowse_scroll), or in two quick ones (fast mode). A screen for "down" / "up".
        const [w, h] = await viewSize(page);
        const total = arg === "down" ? Math.round(h * 0.8) : arg === "up" ? -Math.round(h * 0.8) : Math.round(Number(arg));
        const x = Math.round(w / 2), y = Math.round(h / 2);
        await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, "");
        await page.mouse.move(x, y);
        // A glide: about a third of a second a screen, in up to a dozen eased steps (smooth to watch,
        // never slow); fast mode: two quick turns.
        const n = hooks.smooth ? Math.min(12, Math.max(6, Math.ceil(Math.abs(total) / 90))) : 2;
        let sent = 0;
        for (let k = 1; k <= n; k++) {
          const eased = Math.round(total * (1 - Math.cos((Math.PI * k) / n)) / 2); // slow, fast, slow
          await page.mouse.wheel(0, eased - sent);
          sent = eased;
          if (k % 10 === 0) await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, ""); // still the agent's
          if (hooks.smooth) await new Promise((r) => setTimeout(r, 16));
        }
        await new Promise((r) => setTimeout(r, 60)); // the page catches up with the last turn of the wheel
        hooks.activity(`Scrolled ${total > 0 ? "down" : "up"}`);
      } else if (kind === "upload") {
        // Like pairbrowse_upload: files from anywhere (checked, copied into the uploads folder),
        // into a field, an upload button or a drop zone.
        for (const [label, file] of Object.entries(arg)) {
          const r = await uploadFiles(page, { files: [file], target: label }, { uploadsDir: hooks.uploadsDir });
          if (!r.ok) return fail(r.text);
        }
        hooks.activity(`Uploaded ${Object.values(arg).map((p) => String(p).split(/[\\/]/).pop()).join(", ")}`);
      } else if (kind === "waitFor" || kind === "expect") {
        // Page text, or a field shown by its placeholder or label ("Enter your email").
        const shown = page.getByText(String(arg)).or(page.getByPlaceholder(String(arg))).or(page.getByLabel(String(arg)));
        const ok = await waitOrDisconnect(visibleSoon(shown, kind === "expect" ? 3000 : 15000), hooks.signal);
        if (!ok) return fail(`"${arg}" didn't appear.`);
      } else if (kind === "handoff") {
        hooks.status(arg.say || "Your turn", "you");
        hooks.activity(`Waiting for you: ${arg.say || ""}`);
        const target = arg.until ? page.getByText(arg.until).first().waitFor({ state: "visible", timeout: HANDOFF_MS })
          : page.getByText(arg.untilGone).first().waitFor({ state: "hidden", timeout: HANDOFF_MS });
        let ok;
        try { ok = await waitOrDisconnect(target.then(() => true, () => false), hooks.signal); }
        finally { hooks.status("", "clear"); } // also when the participant disconnected
        if (!ok) return fail(`The user didn't finish within ${HANDOFF_MS / 60_000} minutes.`);
      }
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
