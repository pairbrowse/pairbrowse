// Fast mode: Claude sends a whole page (or flow) of steps in one call, and they run here at
// machine speed, with no model turn between steps. Returns a short summary plus an outline of
// the page it ended on, so the next page can be planned without a full snapshot.
//
// The same safety rules apply as for single actions: web pages only, passwords only on their
// domains, uploads only of checked media and documents, final actions (pay, publish, submit for
// review, delete, message people) are left for browser_click so the user confirms them.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { navigationProblem, isRef, SENSITIVE } from "./policy.mjs";
import { hostAllowed } from "./secrets.mjs";
import { isLocalNetwork, finalAction, finalActionStrict } from "./guard.mjs";
import { uploadProblem, uploadFiles } from "./upload.mjs";
import { slug } from "./runs.mjs";
import { readJson, sleep, within } from "./util.mjs";
import { withHelpers, buttonLabel, isVisible, nearbyText } from "./daemon/page.mjs";

// How long a handoff waits for the user (a sign-in, a CAPTCHA).
const HANDOFF_MS = 10 * 60_000;

export const RUN_TOOL = {
  name: "pairbrowse_run",
  description:
    "Run several browser steps in one call, fast, on the current tab. Use it for each page (or a whole saved flow) instead of one tool call per field. " +
    'Steps, one key each: {"go":url} {"fill":{"Label":"value",...}} {"check":"Label"} {"uncheck":"Label"} {"select":{"Label":"Option"}} ' +
    '{"click":"Button or link text"} {"press":"Enter"} {"upload":{"Label":"/abs/path"}} {"waitFor":"text"} {"expect":"text"} ' +
    '{"handoff":{"say":"what the user must do","until":"text that appears after"}} (or "untilGone"). ' +
    "Labels match the field's label, placeholder or name. Values may use {{var}} from vars. Stops at the first problem and says why. " +
    "Returns where it ended and an outline of the page (fields, buttons, errors). Save a working flow with saveAs, replay it with playbook + vars; list saved ones with list:true. " +
    "Final actions (pay, publish, submit for review, delete) are not run here: use browser_click so the user confirms.",
  inputSchema: {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "object" } },
      vars: { type: "object", additionalProperties: { type: "string" } },
      playbook: { type: "string", description: "Run a saved playbook" },
      saveAs: { type: "string", description: "Save these steps as a playbook if they all succeed" },
      list: { type: "boolean", description: "List saved playbooks" },
    },
  },
};

const PLAYBOOKS = join(paths.home, "playbooks");
const playbookFile = (name) => join(PLAYBOOKS, `${slug(name, "playbook")}.json`);

export function listPlaybooks() {
  mkdirSync(PLAYBOOKS, { recursive: true, mode: 0o700 });
  return readdirSync(PLAYBOOKS).filter((f) => f.endsWith(".json")).map((f) => {
    const p = readJson(join(PLAYBOOKS, f));
    if (!Array.isArray(p?.steps)) return null;
    const vars = [...new Set(JSON.stringify(p.steps).match(/\{\{(\w+)\}\}/g) || [])].map((v) => v.slice(2, -2));
    return `${p.name} (${p.steps.length} steps${vars.length ? `; vars: ${vars.join(", ")}` : ""})`;
  }).filter(Boolean);
}

export function loadPlaybook(name) {
  return JSON.parse(readFileSync(playbookFile(name), "utf8")).steps;
}

export function savePlaybook(name, steps) {
  mkdirSync(PLAYBOOKS, { recursive: true, mode: 0o700 });
  writeFileSync(playbookFile(name), JSON.stringify({ name, steps, savedAt: new Date().toISOString() }, null, 2));
}

export function substitute(value, vars = {}) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in vars)) throw new Error(`missing var ${k}`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [substitute(k, vars), substitute(v, vars)]));
  return value;
}

// Keys that press a button: Enter (with or without modifiers: Shift+Enter submits a form too)
// in a field or on a button or link, and Space on a focused button. Returns "enter", "space" or "".
export function activatingKey(key) {
  const last = String(key || "").split("+").pop();
  if (/^(Enter|NumpadEnter)$/i.test(last)) return "enter";
  if (/^(Space|Spacebar| )$/i.test(last) || String(key) === " ") return "space";
  return "";
}

// The label of the button a key press (activatingKey) would press: the focused button or link
// itself, or for Enter in a field, the form's default submit button. "" when it presses none.
// Called in the page as (element, kind) on a target, or as (kind) for the focused element.
const pressedButton = withHelpers((a, b) => {
  const kind = typeof a === "string" ? a : b;
  let el = (typeof a === "string" ? null : a) || document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el.isContentEditable) return "";
  if (el.matches?.('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a[href], [role="link"]')) return buttonLabel(el);
  if (kind !== "enter" || el.tagName === "TEXTAREA") return "";
  const button = (el.form || el.closest?.("form"))?.querySelector('button:not([type]), button[type="submit"], input[type="submit"]');
  return button ? buttonLabel(button) : "";
}, buttonLabel);

export async function enterButtonLabel(page, target, kind = "enter") {
  try {
    const run = target
      ? page.locator(isRef(target) ? `aria-ref=${target}` : String(target)).first().evaluate(pressedButton, kind, { timeout: 1000 })
      : page.evaluate(pressedButton, kind);
    return String(await within(1500, run.catch(() => "")) ?? "");
  } catch {
    return "";
  }
}

// Checks a step list before anything runs. Returns a problem string, or null.
export function preflight(steps, uploadsDir) {
  if (!Array.isArray(steps) || !steps.length) return "No steps.";
  if (steps.length > 200) return "Too many steps (max 200).";
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step || {})[0] || [];
    const at = `Step ${i + 1} (${kind})`;
    if (kind === "go") {
      const p = navigationProblem(arg);
      if (p) return `${at}: ${p}`;
      if (isLocalNetwork(arg)) return `${at}: ${arg} is on the local network. Use browser_navigate so the user can approve it.`;
    } else if (kind === "click") {
      const final = finalActionStrict(arg);
      if (final) return `${at}: "${arg}" is a final action (${final.word}). Run the steps before it, then use browser_click so the user confirms.`;
    } else if (kind === "upload") {
      for (const p of Object.values(arg || {})) {
        const problem = uploadProblem(p, uploadsDir); // the same checks as pairbrowse_upload
        if (problem) return `${at}: ${problem}`;
      }
    } else if (!["fill", "check", "uncheck", "select", "press", "waitFor", "expect", "handoff"].includes(kind)) {
      return `${at}: unknown step. Use one of go, fill, check, uncheck, select, click, press, upload, waitFor, expect, handoff.`;
    }
  }
  return null;
}

// First visible match among candidate locators.
async function find(page, candidates) {
  for (const make of candidates) {
    const loc = make();
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const one = loc.nth(i);
      if (await one.isVisible().catch(() => false)) return one;
    }
  }
  return null;
}

// The first of these that's visible within the time (a locator matching several elements).
async function visibleSoon(loc, timeout) {
  const until = Date.now() + timeout;
  do {
    for (let i = 0, n = Math.min(await loc.count().catch(() => 0), 50); i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
    await sleep(200);
  } while (Date.now() < until);
  return false;
}

// A field named only by the text just before it in its row (a "Date of Birth" div or label
// with no for=): the one visible fillable field whose nearby text is exactly that, or none if
// that's ambiguous. The same rule names fields in the outline.
const nearbyMatch = withHelpers((els, want) => {
  const norm = (t) => t.replace(/[\s*:]+$/g, "").trim().toLowerCase();
  const fillable = (el) => !(el.matches("input") && /^(hidden|submit|button|image|reset|checkbox|radio|file|range|color)$/i.test(el.type));
  const hits = els.map((el, i) => (fillable(el) && isVisible(el) && norm(nearbyText(el)) === norm(want) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : -1;
}, isVisible, nearbyText);
async function byNearbyText(page, label) {
  const all = page.locator("input, textarea, select");
  const index = await all.evaluateAll(nearbyMatch, label).catch(() => -1);
  return index >= 0 ? all.nth(index) : null;
}

const field = (page, label) => find(page, [
  () => page.getByLabel(label, { exact: true }),
  () => page.getByPlaceholder(label, { exact: true }),
  () => page.getByRole("textbox", { name: label, exact: true }),
  () => page.getByLabel(label),
  () => page.getByPlaceholder(label),
  () => page.locator(`[name="${label.replace(/"/g, '\\"')}"]`),
  () => page.locator(`[id="${label.replace(/"/g, '\\"')}"]`),
]).then((el) => el || byNearbyText(page, label));
// The page's only visible field of a kind: the one meant when it has no label at all.
async function onlyOne(page, selector) {
  const all = page.locator(selector);
  const shown = [];
  for (let i = 0, n = Math.min(await all.count().catch(() => 0), 20); i < n; i++) if (await all.nth(i).isVisible().catch(() => false)) shown.push(all.nth(i));
  return shown.length === 1 ? shown[0] : null;
}

const clickable = (page, name) => find(page, [
  () => page.getByRole("button", { name, exact: true }),
  () => page.getByRole("link", { name, exact: true }),
  () => page.getByRole("button", { name }),
  () => page.getByRole("link", { name }),
  () => page.getByRole("tab", { name }),
  () => page.getByRole("menuitem", { name }),
  () => page.getByText(name, { exact: true }),
]);

// Compact description of what's on the page now: enough to plan the next steps.
const describePage = withHelpers(() => {
  const name = (el) => {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (el.getAttribute("aria-label") || id?.innerText || el.closest("label")?.innerText || el.placeholder || nearbyText(el) || el.name || "").replace(/\s+/g, " ").trim().slice(0, 50);
  };
  const fields = [...document.querySelectorAll("input, select, textarea")].filter((el) => isVisible(el) && el.type !== "hidden" && el.type !== "submit").slice(0, 25).map((el) => {
    const type = el.tagName === "SELECT" ? "select" : el.type || "text";
    const val = type === "checkbox" || type === "radio" ? (el.checked ? "on" : "off") : type === "password" ? (el.value ? "(set)" : "") : String(el.value || "").slice(0, 30);
    return `${name(el) || "(unlabeled)"} [${type}${el.required ? ", required" : ""}${el.getAttribute("aria-invalid") === "true" ? ", INVALID" : ""}]${val ? ` = ${val}` : ""}`;
  });
  const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit], a[href]")].filter(isVisible)
    .map((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean);
  // Real messages only: short text with no fields inside (a wrapper named "...error-handling"
  // isn't an error), plus what an invalid field points to with aria-describedby.
  const described = [...document.querySelectorAll('[aria-invalid="true"][aria-describedby]')].flatMap((f) => f.getAttribute("aria-describedby").split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean));
  const errors = [...document.querySelectorAll('[role=alert], [aria-live=assertive], .error, .errors, [class*="error" i], [class*="invalid" i]'), ...described].filter(isVisible)
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

// Runs steps on page. hooks: { secrets: {values, domains}, uploadsDir, signal, beforeStep(),
// status(text, kind), activity(text), cursor(el, act), remember(label, value, site) }
export async function runSteps(page, steps, hooks) {
  const started = Date.now();
  const done = [];
  // No bringToFront here: on macOS it raises the whole browser window over the app you're in.
  // Background tabs aren't slowed down anyway (the browser starts with throttling switched off).
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step)[0];
    const fail = (why) => ({ ok: false, done, stoppedAt: i + 1, why });
    try {
      await hooks.beforeStep?.();
      if (kind === "go") {
        // Wait for the page to arrive, not for every script and image: a slow resource on the
        // site mustn't fail the step when the page itself is there and usable.
        await page.goto(arg, { waitUntil: "commit", timeout: 30000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        // Sites built in JavaScript draw their forms a moment after the page arrives.
        await page.locator("input:not([type=hidden]), textarea, select").first().waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
        hooks.activity(`Opened ${arg}`);
      } else if (kind === "fill") {
        const filled = [];
        for (const [label, raw] of Object.entries(arg)) {
          const el = await field(page, label);
          if (!el) return fail(`No field "${label}".`);
          let value = String(raw);
          const isSecret = Object.hasOwn(hooks.secrets.values, value);
          // Remember what was filled for next time; never passwords or one-time codes.
          if (!isSecret && value && !SENSITIVE.test(label)) {
            const type = await el.getAttribute("type").catch(() => null);
            if (type !== "password") hooks.remember?.(label, value, (() => { try { return new URL(page.url()).hostname; } catch { return ""; } })());
          }
          if (isSecret) {
            if (!hostAllowed(page.url(), hooks.secrets.domains[value] || [])) return fail(`${value} may only be typed on HTTPS pages of ${(hooks.secrets.domains[value] || []).join(", ") || "(no domains set)"}; this page is ${page.url()}. Hand this field to the user.`);
            value = hooks.secrets.values[value];
          }
          hooks.cursor?.(el, "type");
          await el.fill(value, { timeout: 5000 });
          filled.push({ el, label, value, secret: isSecret });
        }
        // Check every field kept its value once focus has moved on: date pickers, masks and
        // autocompletes can throw a filled value away on blur. Retype those key by key; if one
        // still doesn't keep it, stop and say so rather than report it done.
        // Leave each field with Tab, like a person: a picker that didn't take a pasted value clears it then.
        const same = (a, b) => String(a).replace(/\r\n/g, "\n").trim() === String(b).replace(/\r\n/g, "\n").trim();
        for (const f of filled) {
          const multiline = await f.el.evaluate((n) => n.tagName === "TEXTAREA" || n.isContentEditable).catch(() => true);
          if (!multiline) await f.el.press("Tab", { timeout: 2000 }).catch(() => {});
          const now = await f.el.inputValue({ timeout: 2000 }).catch(() => null);
          if (now === null || same(now, f.value)) continue; // not a plain field (contenteditable): nothing to read
          await f.el.fill("", { timeout: 3000 }).catch(() => {});
          await f.el.click({ timeout: 3000 }).catch(() => {});
          await f.el.pressSequentially(f.value, { delay: 15, timeout: 15000 }).catch(() => {});
          await f.el.press("Tab").catch(() => {});
          const after = await f.el.inputValue({ timeout: 2000 }).catch(() => null);
          if (after !== null && !same(after, f.value)) {
            return fail(`"${f.label}" didn't keep the value${f.secret ? "" : ` "${f.value}"`} (it shows ${f.secret ? "something else" : `"${after}"`}). It may need its picker or a different format: check the screenshot, then fill it step by step.`);
          }
        }
        hooks.activity(`Filled ${Object.keys(arg).map((k) => `**${k}**`).join(", ")}`);
      } else if (kind === "check" || kind === "uncheck") {
        // Also a bare box followed by its text, with no label element ("<input> checkbox 1").
        const bare = String(arg).includes('"') ? null : () => page.locator(`xpath=//text()[normalize-space(.)="${String(arg).trim()}"]/preceding-sibling::input[@type="checkbox" or @type="radio"][1]`);
        const el = await find(page, [() => page.getByLabel(arg, { exact: true }), () => page.getByRole("checkbox", { name: arg }), () => page.getByRole("radio", { name: arg }), () => page.getByLabel(arg), ...(bare ? [bare] : [])]);
        if (!el) return fail(`No checkbox "${arg}".`);
        hooks.cursor?.(el, "click");
        await (kind === "check" ? el.check({ timeout: 5000 }) : el.uncheck({ timeout: 5000 }));
        hooks.activity(`${kind === "check" ? "Ticked" : "Unticked"} **${arg}**`);
      } else if (kind === "select") {
        for (const [label, option] of Object.entries(arg)) {
          const el = await find(page, [() => page.getByLabel(label, { exact: true }), () => page.getByRole("combobox", { name: label }), () => page.getByLabel(label),
            () => page.getByRole("button", { name: label }),
            () => page.locator(`select[name="${label.replace(/"/g, '\\"')}"], select[id="${label.replace(/"/g, '\\"')}"]`)]) || await onlyOne(page, "select");
          if (!el) return fail(`No dropdown "${label}".`);
          hooks.cursor?.(el, "click");
          const isSelect = await el.evaluate((n) => n.tagName === "SELECT").catch(() => false);
          if (isSelect) await el.selectOption({ label: String(option) }, { timeout: 5000 }).catch(() => el.selectOption(String(option), { timeout: 5000 }));
          else {
            // A styled dropdown (a button or combobox with its own list): open it, click the option.
            await el.click({ timeout: 5000 });
            const pick = await find(page, [() => page.getByRole("option", { name: String(option), exact: true }), () => page.getByRole("menuitem", { name: String(option), exact: true }),
              () => page.getByRole("option", { name: String(option) }), () => page.getByText(String(option), { exact: true })]);
            if (!pick) return fail(`Opened "${label}" but found no option "${option}".`);
            await pick.click({ timeout: 5000 });
          }
        }
        hooks.activity(`Chose ${Object.entries(arg).map(([k, v]) => `**${k}** = \`${v}\``).join(", ")}`);
      } else if (kind === "click") {
        const el = await clickable(page, String(arg));
        if (!el) return fail(`Nothing to click named "${arg}".`);
        // The name may match a longer label ("Confirm" finds "Confirm payment"): check what the
        // element really says before clicking it.
        const real = String(await el.evaluate(buttonLabel, undefined, { timeout: 2000 }).catch(() => ""));
        const finalWord = finalAction(real)?.word;
        if (finalWord) return fail(`"${arg}" is the "${real.slice(0, 60)}" button, a final action (${finalWord}). Use browser_click on it so the user confirms.`);
        hooks.cursor?.(el, "click");
        await el.click({ timeout: 5000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        hooks.activity(`Clicked **${arg}**`);
      } else if (kind === "press") {
        const key = activatingKey(arg);
        if (key) {
          const label = await enterButtonLabel(page, null, key);
          const word = finalAction(label)?.word;
          if (word) return fail(`${String(arg)} here would press "${label.slice(0, 60)}" (${word}). Use browser_click on it so the user confirms.`);
        }
        await page.keyboard.press(String(arg));
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
    } catch (e) {
      return fail(String(e?.message || e).split("\n")[0].slice(0, 200));
    }
  }
  return { ok: true, done, ms: Date.now() - started };
}
