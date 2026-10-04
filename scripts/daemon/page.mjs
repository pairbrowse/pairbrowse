// Code that runs inside web pages, shared by the helper's checks and fast mode. Playwright sends a
// function's source to the page, so the helpers it calls have to travel inside that source.

// fn, as a function whose source also declares the given helper functions (by their names).
export function withHelpers(fn, ...helpers) {
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

// What a click on n (or Enter or Space there: kind "enter", "space") commits, judged by what it
// does rather than what it says, so it works for new wording, any language and icon-only
// buttons. Returns { level, word, why }: level "safe" (a link, a tab, a section that opens, a
// step through a form, a search, a sign-in), "commit" (a form submit or a commit-style action:
// the user confirms it) or "strong" (signals stack up: card fields with a submit, a danger button
// in a confirmation dialog); word: what the click must be called so the guard asks ("pay",
// "delete", "submit"); why: the signals, for the refusal. prev: what the click just before in
// this tab committed ("delete": its "Confirm" in the popup is still a delete). Self-contained:
// runs in the page.
export function clickRisk(n, kind = "click", prev = "") {
  const safe = { level: "safe", word: "", why: [] };
  if (!n || n.nodeType !== 1) return safe;
  const why = [];
  const text = (el) => String(el?.innerText || el?.value || el?.getAttribute?.("aria-label") || el?.getAttribute?.("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
  const card = (v) => {
    const d = String(v || "").replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
    return sum % 10 === 0;
  };
  const PAY_HOST = /(^|\.)(stripe\.com|paypal\.com|adyen\.com|adyenpayments\.com|checkout\.com|braintreegateway\.com|klarna\.com|squareup\.com|mollie\.com|razorpay\.com|2checkout\.com)$/i;
  // Where an address goes: a payment provider or a checkout or billing path ("pay"), or a path
  // that deletes or cancels something ("delete").
  const goes = (raw) => {
    try {
      const u = new URL(raw, location.href);
      if (PAY_HOST.test(u.hostname) || /\/(checkout|pay|payment|payments|billing|purchase)(\/|$|\.)/i.test(u.pathname)) return "pay";
      if (/\/(delete|remove|destroy|erase|deactivate|close-account|cancel|unsubscribe)(\/|$|\.|-)/i.test(u.pathname)) return "delete";
    } catch {}
    return "";
  };
  // Red: a danger button (by its color, not its class name).
  const red = (el) => {
    const st = getComputedStyle(el);
    const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const [r, g, b, a = 1] = rgb(st.backgroundColor);
    if (a > 0.3 && r >= 170 && r - g >= 80 && r - b >= 60) return true;
    const [tr, tg, tb] = rgb(st.color);
    return (!(a > 0.3)) && tr >= 170 && tr - tg >= 80 && tr - tb >= 60;
  };
  // A label that only steps through a form, searches, signs in, or closes something.
  const STEP = /^(next|continue|back|previous|prev|skip|search|sign in|log in|login|cancel|close|no|not now|keep|dismiss|weiter|fortfahren|zurück|überspringen|suchen|anmelden|abbrechen|schließen|nein|suivant|continuer|retour|précédent|passer|rechercher|connexion|se connecter|annuler|fermer|non|siguiente|continuar|atrás|anterior|volver|omitir|buscar|iniciar sesión|cancelar|cerrar|avanti|continua|indietro|salta|cerca|accedi|annulla|chiudi|volgende|doorgaan|verder|vorige|terug|overslaan|zoeken|inloggen|annuleren|sluiten|próximo|voltar|pular|pesquisar|entrar|fechar|次へ|続ける|戻る|検索|ログイン|キャンセル|閉じる|下一步|继续|返回|上一步|搜索|登录|取消|关闭)(?![\p{L}\p{N}])/u;
  const stepLabel = (el) => { const t = text(el).replace(/[^\p{L}\p{N} ]+/gu, " ").trim(); return t.length <= 30 && STEP.test(t); };
  const control = n.closest('a[href], button, input[type=submit], input[type=image], input[type=button], input[type=reset], [role=button], [role=link], [role=menuitem], [role=tab], summary') || n;
  const dialog = control.closest('dialog, [role=dialog], [role=alertdialog], [aria-modal="true"]');
  const confirmText = /are you sure|can(no|['’])?t be undone|cannot be undone|irreversible|permanently|sind sie sicher|nicht rückgängig|êtes-vous sûr|est irréversible|estás seguro|no se puede deshacer|sei sicuro|non può essere annullat|weet je het zeker|kan niet ongedaan|tem certeza|não pode ser desfeit|本当に|元に戻せません|确定要|无法撤销|无法恢复/i;
  const confirming = !!dialog && (dialog.matches('[role=alertdialog]') || confirmText.test(String(dialog.innerText || "").slice(0, 2000)));
  // Only a button counts (a red link or red text is just a color).
  const danger = control.matches('button, input[type=submit], input[type=button], input[type=image], [role=button]') && red(control);
  if (danger) why.push("it's styled as a danger button");
  if (confirming) why.push("it's in a confirmation dialog");

  // What it submits: a submit button's form, or Enter in a field (Space presses buttons only).
  let form = null, submitter = null;
  const b = control.matches("button, input[type=submit], input[type=image]") ? control : null;
  if (b && !(b.tagName === "BUTTON" && (b.getAttribute("type") || "submit").toLowerCase() !== "submit")) { form = b.form; submitter = b; }
  else if (!b && kind === "enter" && n.tagName === "INPUT") form = n.form;
  // Payment fields: by autocomplete (cc-*, billing or shipping sections), card-number values, and
  // field names, in the form, or on the page with a payment provider's frame.
  const payFields = (root) => {
    for (const f of [...root.querySelectorAll("input, select, textarea")].slice(0, 400)) {
      const tokens = String(f.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      if (tokens.some((t) => t.startsWith("cc-")) || tokens.includes("billing") || tokens.includes("shipping")) return true;
      if (f.tagName === "INPUT" && card(f.value)) return true;
      if (/\b(cvv|cvc|csc|iban|card.?number|cardnumber)\b/i.test(`${f.name || ""} ${f.id || ""}`)) return true;
    }
    return [...root.querySelectorAll("iframe[src]")].slice(0, 50).some((f) => { try { return PAY_HOST.test(new URL(f.src, location.href).hostname); } catch { return false; } });
  };

  if (form || (kind === "enter" && !b)) {
    if (!form) return safe; // Enter outside a form submits nothing
    const action = submitter?.getAttribute("formaction") || form.getAttribute("action") || "";
    const dest = action ? goes(action) : "";
    const paying = payFields(form) || dest === "pay";
    if (paying) return { level: "strong", word: "pay", why: [...why, dest === "pay" ? "it sends a form to a payment page" : "it sends a form with card or billing/shipping fields"] };
    if (danger || confirming || dest === "delete" || prev === "delete") return { level: "strong", word: "delete", why: [...why, dest === "delete" ? "it sends a form to a delete or cancel page" : prev === "delete" ? "it follows a delete click" : "it submits a form"] };
    // Forms that commit nothing: an explicit GET (a search, a filter: scripted forms often name no
    // method, so a missing one isn't taken for it), a search box, a sign-in form.
    const method = String(submitter?.getAttribute("formmethod") || form.getAttribute("method") || "").toLowerCase();
    if (method === "get") return safe;
    if (form.matches('[role=search]') || form.closest('[role=search]') || form.querySelector('input[type=search]')) return safe;
    const fields = [...form.querySelectorAll("input, select, textarea")].filter((f) => !/^(hidden|submit|button|image|reset|checkbox|radio)$/i.test(f.type || "") && f.getClientRects().length);
    const pw = fields.filter((f) => f.type === "password");
    if (pw.length === 1 && !/new-password/i.test(pw[0].getAttribute("autocomplete") || "") && fields.length <= 3) return safe;
    // A step through a multi-step form ("Next", "Continue", "Back"), when nothing else is at stake.
    if (submitter ? stepLabel(submitter) : [...form.querySelectorAll('button:not([type]), button[type=submit], input[type=submit]')].slice(0, 1).every(stepLabel)) return safe;
    return { level: "commit", word: "submit", why: [...why, "it submits a form"] };
  }
  if (kind === "enter" || (kind === "space" && !b)) return safe;

  // Not a submit: links go somewhere; buttons act through the page's scripts.
  const href = control.matches("a[href]") ? control.getAttribute("href") : "";
  const dest = href && !/^\s*(#|javascript:)/i.test(href) ? goes(href) : "";
  if (dest) return { level: confirming || danger ? "strong" : "commit", word: dest, why: [...why, dest === "pay" ? "it opens a payment page" : "it opens a delete or cancel page"] };
  if (prev && dialog && !stepLabel(control)) return { level: "strong", word: prev, why: [...why, `it confirms the ${prev} click before it`] };
  if (danger && confirming) return { level: "strong", word: "delete", why };
  if (control.matches('[role=tab], summary, [aria-expanded], [aria-haspopup]')) return safe;
  if (danger || (confirming && !stepLabel(control))) return { level: "commit", word: "delete", why };
  return safe;
}
