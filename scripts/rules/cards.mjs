// Card details are entered by a person, never by an agent (spec server-mode B13, U7, 13.1), in
// every session and app: the rules that find a card field and a card number, pure. The page reads
// that apply them live in scripts/runner/cards.mjs; the checks in daemon/serve/refuse.mjs
// (browserToolProblem: every browser tool, both drivers, the native humanized fill) and fast mode
// (runner/steps/fill.mjs, select.mjs, press.mjs).
//
// A card field: autocomplete cc-number, cc-csc, cc-exp, cc-exp-month or cc-exp-year (the name on
// the card and the card's type stay an agent's to fill: cc-name, cc-given-name, cc-family-name,
// cc-additional-name, cc-type), any field in a frame holding such a field, or any field in a frame
// from another site than the page that the page lets ask for payment (allow="payment").
// A card number: a run of digits written as cards are (one group of 13 to 19 digits, or 4-4-4-4,
// 4-6-5, 4-6-4, 4-4-4-4-3, as policy.mjs maskCards reads them) that passes the card checksum and
// starts and is as long as a card network's numbers are. The checksum alone passes about one
// random digit string in ten; the network's prefix and length spare IMEIs (15 digits from 35 or
// 86), EAN and ISBN codes (13 digits) and most order and tracking numbers. A gift or prepaid card
// on a card network counts like any other card.
// Not detected: a contenteditable box, a closed shadow root, a card drawn on a canvas, a card number
// split over unlabeled boxes, a field whose page doesn't answer in time.
//
// A saved card (spec server-mode B12): in a session whose browser has one, the browser's autofill
// list opens on any of a card's fields, the name on the card too, and a key (an arrow, then Enter)
// would pick the card. So there every key press an agent sends into a field with any cc-*
// autocomplete token (AUTOFILL_TOKENS), or into a card or payment frame, is refused; and a key that
// moves in or picks from the list (listKey: an arrow up or down, Page Up or Down, Enter) into any
// text field of a form whose fields name a card without a cc-* token (CARD_NAME: by name, id,
// placeholder, aria-label or label, as name="cardnumber"), since the browser's autofill knows card
// fields by those too. Only the person fills the saved card, during a hand-off. The list itself is
// the browser's own window, which no page click reaches. Not detected there: a card field the page
// names only by nearby text (no label, name, id, placeholder or aria-label) or in words CARD_NAME
// doesn't know (the browser's own field recognition is wider), besides the cases above.

// The autocomplete tokens of a card field.
export const CARD_TOKENS = ["cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"];
// Every card token the browser's card autofill opens on (a saved-card session's key rule).
export const AUTOFILL_TOKENS = [...CARD_TOKENS, "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-type"];

// The names a card field goes by without a cc-* token (a saved-card session's list-key rule), as a
// regular expression's source (it runs in the page, case-insensitive): the card number, the
// security code and the expiry, in English and a few other languages.
export const CARD_NAME = "card.?(?:number|num|no(?:[^a-z]|$)|nr)|cc.?(?:num|number|no(?:[^a-z]|$))|credit.?card|debit.?card|kartennummer|num[eé]ro.?de.?(?:la.?)?carte|n[uú]mero.?de.?(?:la.?)?tarjeta|numero.?(?:della.?)?carta|cvc|cvv|(?:^|[^a-z])csc(?:[^a-z]|$)|security.?code|card.?code|card.?verification|expir|exp.?(?:date|month|year|mm|yy)|mm.?\\/.?yy";
// Whether a key moves in or picks from an open list (the browser's autofill list among them),
// whatever is held with it: ArrowDown, ArrowUp, PageDown, PageUp, Enter.
export const listKey = (key) => /^(?:ArrowDown|ArrowUp|PageDown|PageUp|Enter|NumpadEnter)$/i.test(String(key ?? "").split("+").at(-1));

// [first digits from, to, lengths]: the card networks' number ranges.
const NETWORKS = [
  ["4", "4", [16, 19]], // Visa (13-digit Visa numbers are no longer issued)
  ["51", "55", [16]], ["2221", "2720", [16]], // Mastercard
  ["34", "34", [15]], ["37", "37", [15]], // American Express
  ["6011", "6011", [16, 17, 18, 19]], ["644", "649", [16, 17, 18, 19]], ["65", "65", [16, 17, 18, 19]], // Discover
  ["62", "62", [16, 17, 18, 19]], // UnionPay
  ["3528", "3589", [16, 17, 18, 19]], // JCB
  ["36", "36", [14, 15, 16, 17, 18, 19]], ["300", "305", [16, 17, 18, 19]], ["3095", "3095", [16, 17, 18, 19]], ["38", "39", [16, 17, 18, 19]], // Diners Club
  ["50", "50", [13, 14, 15, 16, 17, 18, 19]], ["56", "58", [13, 14, 15, 16, 17, 18, 19]], ["6304", "6304", [13, 16, 19]], ["6759", "6759", [13, 16, 19]], ["6761", "6763", [13, 16, 19]], // Maestro
  ["2200", "2204", [16, 17, 18, 19]], // Mir
  ["60", "60", [16]], ["81", "82", [16]], ["508", "508", [16]], // RuPay
  ["9792", "9792", [16]], // Troy
];

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

// Whether digits (digits only) is a card number: the checksum, a network's start and its length.
export function isCardNumber(digits) {
  const s = String(digits ?? "");
  if (!/^\d{13,19}$/.test(s) || !luhn(s)) return false;
  return NETWORKS.some(([from, to, lengths]) => {
    if (!lengths.includes(s.length)) return false;
    const head = s.slice(0, from.length);
    return head >= from && head <= to;
  });
}

// The card numbers in text, as their digits: each card-shaped run (policy.mjs maskCards' shapes)
// that is a card number.
const RUN = /(?<!\d)(?:\d[ \t\u00a0-]{0,3}){12,}\d(?!\d)/g;
const CARD_GROUPS = new Set(["4-4-4-4", "4-6-5", "4-6-4", "4-4-4-4-3"]);
export function cardNumbersIn(text) {
  const found = [];
  for (const [run] of String(text ?? "").matchAll(RUN)) {
    const parts = run.match(/\d+|\D+/g);
    for (let i = 0; i < parts.length;) {
      let hit = -1;
      if (/^\d/.test(parts[i])) {
        for (let j = Math.min(parts.length - 1, i + 8); j >= i && hit < 0; j--) {
          if (!/^\d/.test(parts[j])) continue;
          const groups = parts.slice(i, j + 1).filter((p) => /^\d/.test(p));
          const shape = groups.length === 1 ? groups[0].length >= 13 && groups[0].length <= 19 : CARD_GROUPS.has(groups.map((g) => g.length).join("-"));
          if (shape && isCardNumber(groups.join(""))) hit = j;
        }
      }
      if (hit < 0) i++;
      else { found.push(parts.slice(i, hit + 1).filter((p) => /^\d/.test(p)).join("")); i = hit + 1; }
    }
  }
  return found;
}
export const holdsCardNumber = (text) => cardNumbersIn(text).length > 0;

// The card token among a field's autocomplete tokens ("billing cc-number" -> "cc-number"), or "".
export const cardToken = (autocomplete) => String(autocomplete ?? "").toLowerCase().split(/\s+/).find((t) => CARD_TOKENS.includes(t)) || "";

// What each card field signal is called in a refusal.
const TOKEN_WORDS = { "cc-number": "a card number field", "cc-csc": "a card security code field", "cc-exp": "a card expiry field", "cc-exp-month": "a card expiry field", "cc-exp-year": "a card expiry field",
  "cc-name": "a name on card field", "cc-given-name": "a name on card field", "cc-additional-name": "a name on card field", "cc-family-name": "a name on card field", "cc-type": "a card type field" };
export const SIGNALS = {
  token: (t) => `${TOKEN_WORDS[t] || "a card field"} (autocomplete ${t})`,
  cardFrame: "a field inside a frame that holds card fields",
  payFrame: "a field inside another site's payment frame (allow=\"payment\")",
  cardForm: "a field of a form whose fields name a card",
  number: "the text holds a card number",
  secret: (name) => `${name} holds a card number`,
  key: (kind, field) => `${kind === "paste" ? "a paste" : "a digit key"} into ${field}`,
  savedCardKey: (key, field) => `${String(key).slice(0, 40)} into ${field} in a session with a saved card`,
};

// Whether a key press types into a field as a card's digits do, or pastes into it: a digit (with
// Shift or nothing held: Digit4, Numpad4, 4) or a paste: Cmd/Ctrl+V, with Shift and/or Alt held too
// in any order ("paste and match style": Meta+Shift+v), KeyV for v, and Shift+Insert.
export const cardKey = (key) => {
  const k = String(key ?? "");
  if (/^(?:Shift\+)?(?:Digit|Numpad)?[0-9]$/.test(k)) return "digit";
  const mods = k.split("+").slice(0, -1);
  const pasteMods = mods.some((m) => /^(?:Control|Meta|ControlOrMeta|Ctrl|Cmd|Command)$/i.test(m))
    && mods.every((m) => /^(?:Control|Meta|ControlOrMeta|Ctrl|Cmd|Command|Shift|Alt)$/i.test(m));
  if ((pasteMods && /^(?:v|KeyV)$/i.test(k.split("+").at(-1))) || /^Shift\+Insert$/i.test(k)) return "paste";
  return "";
};

// The one refusal, naming the signal that fired.
export const CARD_RULE = "Card details are the person's to enter: hand this step over with pairbrowse_status kind you, step payment, then wait with browser_wait_for.";
export const cardRefusal = (signal) => `Refused (${signal}). ${CARD_RULE}`;
