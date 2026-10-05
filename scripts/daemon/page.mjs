// Code that runs inside web pages, shared by the helper's checks and fast mode. Playwright sends a
// function's source to the page, so the helpers it calls have to travel inside that source.

// fn, as a function whose source also declares the given helper functions (by their names).
export function withHelpers(fn, ...helpers) {
  // Built only from PairBrowse's own functions (fn and helpers), never from page or user input.
  // eslint-disable-next-line no-new-func
  return new Function("...args", `${helpers.map(String).join("\n")}\nreturn (${fn})(...args);`);
}

// A button's or link's label as the page shows it (the click guards only see what Claude calls
// it): its text, aria label (also through aria-labelledby), value, title and alt, and the labels
// of icons inside it.
export function buttonLabel(n) {
  const by = (n.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
  const icons = [...n.querySelectorAll("img[alt], svg [aria-label], svg title, [aria-label]")].slice(0, 10).map((i) => i.getAttribute("alt") || i.getAttribute("aria-label") || i.textContent || "");
  return [n.getAttribute("aria-label"), by, n.value, n.innerText || n.textContent, n.getAttribute("title"), n.getAttribute("alt"), ...icons]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
}

export function isVisible(el) {
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
}

// Short text just before a field in its row (a "Date of Birth" div next to the input), not a
// section heading: how fast mode finds a field with no label, and how its outline names it.
export function nearbyText(el) {
  for (let node = el, up = 0; node && up < 4; node = node.parentElement, up++) {
    for (let prev = node.previousSibling; prev; prev = prev.previousSibling) {
      if (prev.nodeType === 3) {
        const t = prev.nodeValue.replace(/\s+/g, " ").trim();
        if (t) return t.length <= 40 ? t : "";
        continue;
      }
      if (prev.nodeType !== 1) continue;
      if (prev.matches("input, select, textarea") || prev.querySelector("input, select, textarea")) return "";
      if (prev.matches("h1, h2, h3, h4, h5, h6, legend, nav, header")) return "";
      const t = (prev.innerText || "").replace(/\s+/g, " ").trim();
      if (t) return t.length <= 40 ? t : "";
    }
  }
  return "";
}

// What a click on n (or Enter or Space there: kind "enter", "space") commits, judged only by the
// page's structure, never by words, so it works for any wording, any language and icon-only
// buttons. Returns { level, word, why, unclear? }: level "safe" (a link, a tab, a section that
// opens, a step through a multi-step form, a search, a sign-in), "commit" (a form submit or
// another committing action: the user confirms it) or "strong" (signals stack up: card fields
// with a submit, a danger button in a confirmation dialog); word: the class the click must be
// named with so the guard asks ("pay", "delete", "submit"); why: the signals, for the refusal;
// unclear: safe by structure but what it does runs in the page's scripts (it goes; the agent names
// it if its task says it commits, scripts/clickrule.mjs). prev: what the click just before in this tab committed ("delete": its
// confirmation is still a delete). hints.payFrame: a frame on the page has card fields (the helper
// reads frames this code can't). Self-contained: runs in the page.
export function clickRisk(n, kind = "click", prev = "", hints = {}) {
  const safe = (unclear) => (unclear ? { level: "safe", word: "", why: [], unclear: true } : { level: "safe", word: "", why: [] });
  if (!n || n.nodeType !== 1) return safe();
  const why = [];
  const card = (v) => {
    const d = String(v || "").replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
    return sum % 10 === 0;
  };
  // An IBAN by its checksum (ISO 13616, mod 97), whatever the field is called.
  const iban = (v) => {
    const s = String(v || "").replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
    const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let r = 0;
    for (const ch of digits) r = (r * 10 + Number(ch)) % 97;
    return r === 1;
  };
  const rgb = (c) => (String(c).match(/[\d.]+/g) || []).map(Number);
  // Red: a danger button (by its computed color, not its class name).
  const red = (el) => {
    const st = getComputedStyle(el);
    const [r, g, b, a = 1] = rgb(st.backgroundColor);
    if (a > 0.3 && r >= 170 && r - g >= 80 && r - b >= 60) return true;
    const [tr, tg, tb] = rgb(st.color);
    return (!(a > 0.3)) && tr >= 170 && tr - tg >= 80 && tr - tb >= 60;
  };
  // A filled button (an opaque, colored or dark background): the one a dialog wants pressed.
  const filled = (el) => {
    const [r, g, b, a = 1] = rgb(getComputedStyle(el).backgroundColor);
    if (!(a > 0.5)) return false;
    return Math.max(r, g, b) - Math.min(r, g, b) >= 40 || Math.max(r, g, b) <= 90;
  };
  const shown = (el) => el.getClientRects().length > 0;
  const BUTTONS = 'button, input[type=submit], input[type=button], input[type=image], input[type=reset], [role=button]';
  const control = n.closest('a[href], button, input[type=submit], input[type=image], input[type=button], input[type=reset], [role=button], [role=link], [role=menuitem], [role=tab], summary') || n;
  const dialog = control.closest('dialog, [role=dialog], [role=alertdialog], [aria-modal="true"]');
  const dialogButtons = dialog ? [...dialog.querySelectorAll(BUTTONS)].filter(shown).slice(0, 20) : [];
  const danger = control.matches(BUTTONS) && red(control); // a red link or red text is just a color
  // A confirmation dialog, by its shape: an alert dialog, or a dialog with a danger button.
  const confirming = !!dialog && (dialog.matches('[role=alertdialog]') || dialogButtons.some(red));
  // The button that closes a dialog rather than confirming it: a plain one next to a filled one.
  const dismiss = !!dialog && control.matches(BUTTONS) && !filled(control) && !danger && dialogButtons.some((x) => x !== control && (filled(x) || red(x)));
  if (danger) why.push("it's styled as a danger button");
  if (confirming) why.push("it's in a confirmation dialog");
  // The HTTP method a script sends for this control (Rails, Turbo, htmx attributes), or a form's
  // method override field: a protocol name, not page wording.
  const verbOf = (el) => String(el.getAttribute("data-method") || el.getAttribute("data-turbo-method") ||
    ["delete", "put", "patch", "post"].find((v) => el.hasAttribute(`hx-${v}`)) || "").toLowerCase();

  // What it submits: a submit button's form, or Enter in a field (Space presses buttons only).
  let form = null, submitter = null;
  const b = control.matches("button, input[type=submit], input[type=image]") ? control : null;
  if (b && !(b.tagName === "BUTTON" && (b.getAttribute("type") || "submit").toLowerCase() !== "submit")) { form = b.form; submitter = b; }
  else if (!b && kind === "enter" && n.tagName === "INPUT") form = n.form;
  const method = form ? String(submitter?.getAttribute("formmethod") || form.getAttribute("method") || "").toLowerCase() : "";
  // A form in a dialog that only closes it (method="dialog") is one of the dialog's buttons.
  if (method === "dialog") form = null;
  // Payment fields: autocomplete cc-* or billing/shipping sections, a card number or IBAN typed
  // in, or a payment frame (allow="payment") in the form.
  const payFields = (root) => {
    for (const f of [...root.querySelectorAll("input, select, textarea")].slice(0, 400)) {
      const tokens = String(f.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      if (tokens.some((t) => t.startsWith("cc-")) || tokens.includes("billing") || tokens.includes("shipping")) return true;
      if (f.tagName === "INPUT" && (card(f.value) || iban(f.value))) return true;
    }
    return !!root.querySelector('iframe[allow*="payment" i]');
  };
  // Where a multi-step form stands, by its markup: "middle" (more steps follow), "last", or ""
  // (no steps marked). A step list with aria-current="step", a progress bar, or fieldsets the
  // form shows one at a time; looked for in the form and around it, up to the next other form.
  const stepOf = (f) => {
    for (let el = f, up = 0; el && up < 6; el = el.parentElement, up++) {
      if (el !== f && [...el.querySelectorAll("form")].some((o) => o !== f)) break;
      const current = el.querySelector('[aria-current="step"]');
      if (current) {
        const item = current.closest("li, [role=listitem], [role=tab]") || current;
        const items = [...(item.parentElement?.children || [])].filter((x) => x.tagName === item.tagName);
        return items.indexOf(item) < items.length - 1 ? "middle" : "last";
      }
      const bar = el.querySelector("progress[max], [role=progressbar][aria-valuemax]");
      if (bar) {
        const now = Number(bar.getAttribute("value") ?? bar.getAttribute("aria-valuenow")), max = Number(bar.getAttribute("max") ?? bar.getAttribute("aria-valuemax"));
        if (Number.isFinite(now) && Number.isFinite(max) && max > 0) return now < max ? "middle" : "last";
      }
    }
    const sets = [...f.querySelectorAll("fieldset")].filter((x) => !x.parentElement.closest("fieldset"));
    if (sets.length >= 2 && sets.some((x) => !shown(x))) {
      const lastShown = sets.findLastIndex(shown);
      return lastShown >= 0 && sets.slice(lastShown + 1).some((x) => !shown(x)) ? "middle" : "last";
    }
    return "";
  };

  // What the control does, and where a multi-step form stands: part of the click's context.
  const realHref = control.matches("a[href]") && !/^\s*(#|javascript:)/i.test(control.getAttribute("href") || "");
  const does = form ? "submits a form" : kind !== "click" ? "nothing" : verbOf(control) ? `sends a ${verbOf(control).toUpperCase()} request` : realHref ? "navigates"
    : control.matches('[role=tab], summary, [aria-expanded], [aria-haspopup], [aria-controls], [aria-pressed], [role=switch], [role=checkbox], [role=radio], [role=option]') ? "changes the page in place" : "runs the page's scripts";
  const step = form ? stepOf(form) : "";
  const r = (() => {
  if (form || (kind === "enter" && !b && method !== "dialog")) {
    if (!form) return safe(); // Enter outside a form submits nothing
    const override = String(form.querySelector('input[type=hidden][name="_method"]')?.value || "").toLowerCase();
    if (payFields(form) || hints.payFrame) return { level: "strong", word: "pay", why: [...why, hints.payFrame && !payFields(form) ? "it sends a form on a page with a card payment frame" : "it sends a form with card, IBAN or billing/shipping fields"] };
    if (danger || confirming || override === "delete" || prev === "delete") {
      return { level: "strong", word: "delete", why: [...why, override === "delete" ? "it sends a DELETE request" : prev === "delete" ? "it follows a delete click" : "it submits a form"] };
    }
    // Forms that commit nothing: an explicit GET (a search, a filter: scripted forms often name no
    // method, so a missing one isn't taken for it), a search form, a sign-in form.
    if (method === "get") return safe();
    if (form.closest('[role=search]') || form.querySelector('[role=search], input[type=search]')) return safe();
    const fields = [...form.querySelectorAll("input, select, textarea")].filter((f) => !/^(hidden|submit|button|image|reset|checkbox|radio)$/i.test(f.type || "") && shown(f));
    const pw = fields.filter((f) => f.type === "password");
    if (pw.length === 1 && !/new-password/i.test(pw[0].getAttribute("autocomplete") || "") && fields.length <= 3) return safe();
    // A step through a multi-step form, marked as one; the last step, or no marks, asks.
    if (stepOf(form) === "middle") return safe();
    return { level: "commit", word: "submit", why: [...why, "it submits a form"] };
  }
  if (kind === "enter" || (kind === "space" && !b)) return safe();

  // Not a submit: links go somewhere; buttons act through the page's scripts.
  const verb = verbOf(control);
  if (verb === "delete") return { level: confirming || danger ? "strong" : "commit", word: "delete", why: [...why, "it sends a DELETE request"] };
  if (verb && verb !== "get") return { level: "commit", word: prev || "submit", why: [...why, `it sends a ${verb.toUpperCase()} request`] };
  // A link to another address only goes there (a GET); "#" and script links act like buttons.
  const href = control.matches("a[href]") ? control.getAttribute("href") || "" : "";
  if (href && !/^\s*(#|javascript:)/i.test(href)) return safe();
  if (dialog && prev && !dismiss) return { level: "strong", word: prev, why: [...why, `it confirms the ${prev} click before it`] };
  if (danger && confirming) return { level: "strong", word: "delete", why };
  if (confirming && !dismiss) return { level: "commit", word: danger ? "delete" : "submit", why };
  if (danger) return { level: "commit", word: "delete", why };
  if (control.matches('[role=tab], summary, [aria-expanded], [aria-haspopup], [aria-controls], [aria-pressed], [role=switch], [role=checkbox], [role=radio], [role=option], [role=menuitemcheckbox], [role=menuitemradio]')) return safe();
  // A plain button: whatever it does runs in the page's scripts.
  return safe(control.matches(`${BUTTONS}, [role=menuitem], a[href]`) || control.hasAttribute("onclick"));
  })();
  return { ...r, does, step, confirming };
}

// A click's context, the one shared reading behind every check (browser_click, Enter and Space,
// pairbrowse_click_at, fast mode, uploads): the structural decision (clickRisk) plus what the page is (title, origin, headings), the form (method, step, its fields'
// names, types and autocomplete, never values), the dialog it's in, and what the control does.
// Needs clickRisk and buttonLabel alongside it (withHelpers). Self-contained: runs in the page.
export function clickContext(n, kind = "click", prev = "", hints = {}) {
  const risk = clickRisk(n, kind, prev, hints);
  const clip = (v, max = 80) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
  const page = { title: clip(document.title, 120), origin: location.origin, headings: [...document.querySelectorAll("h1, h2")].slice(0, 5).map((h) => clip(h.innerText)).filter(Boolean) };
  if (!n || n.nodeType !== 1) return { risk, page, control: null, form: null, dialog: null, prev };
  const control = n.closest("a[href], button, input, [role=button], [role=link], [role=menuitem], [role=tab], summary") || n;
  const f = control.form || (kind === "enter" ? n.form : null) || null;
  const form = f ? {
    method: clip(f.getAttribute("method") || "", 10).toLowerCase(), step: risk.step || "",
    fields: [...f.querySelectorAll("input, select, textarea")].filter((x) => !/^(hidden|submit|button|image|reset)$/i.test(x.type || "")).slice(0, 30)
      .map((x) => ({ name: clip(x.labels?.[0]?.innerText || x.getAttribute("aria-label") || x.getAttribute("name") || x.id || x.getAttribute("placeholder"), 60), type: x.type || x.tagName.toLowerCase(), autocomplete: clip(x.getAttribute("autocomplete"), 40) })),
  } : null;
  const d = control.closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=\"true\"]");
  const dialog = d ? { role: d.getAttribute("role") || "dialog", confirmation: !!risk.confirming, text: clip(d.innerText, 200) } : null;
  return { risk, page, control: { label: clip(buttonLabel(control), 200), does: risk.does }, form, dialog, prev };
}
