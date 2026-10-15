// A fill step: type each value into the field its label names, then check each kept it.
import { SENSITIVE } from "../../rules/policy.mjs";
import { hostAllowed } from "../../rules/secrets.mjs";
import { within, bounded } from "../../util.mjs";
import { field, find, hiddenNow, openSectionOf, unfold } from "../locate.mjs";
import { choicesBefore, clearChoices, hiddenDropdown, pickSuggestion } from "../choices.mjs";
import { isoDate, sameDate } from "../dates.mjs";

export async function fill({ page, arg, i, hooks, touched, fail, gone, theirs, trace, run }) {
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
  run.lastTyped = filled.at(-1)?.el || null;
  if (filled.length) hooks.activity(`Filled ${filled.map((f) => `**${f.label}**`).join(", ")}`);
}
