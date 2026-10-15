// A check or uncheck step: tick or untick the box or radio its text names.
import { within, bounded } from "../../util.mjs";
import { find, formRoots, unfold } from "../locate.mjs";
import { NEXT } from "./common.mjs";

export async function check({ page, kind, arg, hooks, touched, fail, gone, theirs }) {
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
      if (await theirs(u.el, String(arg))) return NEXT;
      await hooks.cursor?.(u.el, "click");
      await (kind === "check" ? u.el.check({ timeout: 3000 }) : u.el.uncheck({ timeout: 3000 }));
      touched.push({ el: u.el, label: String(arg) });
      hooks.activity(`${kind === "check" ? "Ticked" : "Unticked"} **${arg}**`);
      return NEXT;
    }
    if (was !== want) {
      await hooks.cursor?.(text, "click");
      await text.click({ timeout: 5000 });
      if ((await hidden.isChecked({ timeout: 1500 }).catch(() => null)) !== want) return fail(`Clicked "${String(arg).slice(0, 60)}" but its box is still ${want ? "unticked" : "ticked"}. Look at the screenshot and click the box itself.`);
    }
    hooks.activity(`${want ? "Ticked" : "Unticked"} **${arg}**`);
    touched.push({ el: hidden, label: String(arg) });
    return NEXT;
  }
  if (await theirs(el, String(arg))) return NEXT;
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
}
