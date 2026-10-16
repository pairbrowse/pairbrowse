// A button that only moves a checkout on to its next step, by the label the page gives it: "Next",
// "Continue", "Continue to shipping", "Proceed to payment". The one place in the click checks where
// words count, kept apart from them (test/shared-rules.test.mjs holds every other click file to no
// wording), and only ever to lift a payment read from address fields alone (autocomplete billing
// or shipping: such a form pays nothing itself; scripts/rules/clicks.mjs paySignal). Words never
// make a click final. The whole label must be one of these phrases, so "Continue and pay", "Place
// order" or "Next: Pay now" never match, and a form with card or IBAN fields or a payment frame
// pays whatever its button says. English only: in another language the button asks, as before.
// Self-contained (the click checks run it in the page).
export function nextStepLabel(label) {
  const t = String(label ?? "").replace(/\s+/g, " ").replace(/[\s›»→>]+$/u, "").replace(/^[\s‹«←<]+/u, "").trim().toLowerCase();
  if (!t || t.length > 60) return false;
  return /^(?:continue|next|proceed|next step|(?:continue|proceed|go|next step) to (?:the )?(?:next step|shipping|delivery|payment|billing|review|checkout|summary)(?: (?:method|methods|option|options|details|information|info|address|page|step))?)$/.test(t);
}
