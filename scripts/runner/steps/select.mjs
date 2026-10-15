// A select step: choose an option in each dropdown named, native or styled.
import { bounded } from "../../util.mjs";
import { byFirstOption, byNearbyText, cssString, find, formRoots, hiddenNow, onlyOne, unfold } from "../locate.mjs";
import { chooseNative, hiddenDropdown, labelOpener, nativeNamed, pickFromOpened } from "../choices.mjs";

export async function select({ page, arg, hooks, touched, fail, gone, theirs }) {
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
}
