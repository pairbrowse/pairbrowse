// A press step: a key, unless it would commit something the user should confirm.
import { strongSignal } from "../../rules/clicks.mjs";
import { within } from "../../util.mjs";
import { activatingKey, enterButtonLabel, riskAt, riskReason } from "../risk.mjs";
import { cardKey, cardRefusal, listKey, SIGNALS, AUTOFILL_TOKENS } from "../../rules/cards.mjs";
import { focusedCardField, focusedCardForm } from "../cards.mjs";

export async function press({ page, arg, i, steps, hooks, fail, run }) {
  // A card's digits or a paste into a card field: the person's to enter (spec server-mode B13).
  const typing = cardKey(arg);
  const card = typing ? await focusedCardField(page) : "";
  if (card) return fail(cardRefusal(SIGNALS.key(typing, card)));
  // A saved card on (B12, hooks.savedCard): no key at all into a field its autofill opens on, and
  // no list key into a text field of a form whose fields name a card without a cc-* token.
  const saved = !!hooks?.savedCard?.();
  const autofill = (saved ? await focusedCardField(page, { tokens: AUTOFILL_TOKENS }) : "") || (saved && listKey(arg) ? await focusedCardForm(page) : "");
  if (autofill) return fail(cardRefusal(SIGNALS.savedCardKey(arg, autofill)));
  const key = activatingKey(arg);
  // Enter right after a fill goes to the field typed last, as a person's would: the run's own
  // Tab (leaving each field to check it kept its value) moved the focus on.
  if (key === "enter" && run.lastTyped && Object.keys(steps[i - 1] || {})[0] === "fill") await within(2000, run.lastTyped.focus({ timeout: 1500 }).catch(() => {}));
  if (key) {
    const risk = await riskAt(page, null, key);
    if (strongSignal(risk)) {
      const label = await enterButtonLabel(page, null, key);
      return fail(`${String(arg)} here would ${label ? `press "${label.slice(0, 60)}" and ` : ""}commit something (${riskReason(risk)}). Use browser_click on its button so the user confirms.`);
    }
  }
  // Bounded: a page that stops answering ends the step with a word, not the run with a hang.
  if ((await within(10_000, page.keyboard.press(String(arg)).then(() => true))) === null) return fail(`Pressing ${String(arg)} got no answer from the page (it's busy or stuck). Take a browser_snapshot and try again.`);
}
