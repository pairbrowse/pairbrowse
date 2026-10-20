// Card details are entered by a person, never by an agent (spec server-mode B13, 13.1): the rules
// that find a card number and a card field (scripts/rules/cards.mjs), the page reads behind them
// (scripts/runner/cards.mjs), and fast mode's steps, fill preflight and remembered details.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardPage } from "./helpers/card-page.mjs";

const { isCardNumber, cardNumbersIn, holdsCardNumber, cardToken, cardKey, cardRefusal, CARD_RULE, SIGNALS, CARD_TOKENS } = await import("../scripts/rules/cards.mjs");
const { cardFieldAt, focusedCardField } = await import("../scripts/runner/cards.mjs");
const { preflight } = await import("../scripts/runner.mjs");
const { press } = await import("../scripts/runner/steps/press.mjs");
const { handoff } = await import("../scripts/runner/steps/handoff.mjs");
const { createFacts } = await import("../scripts/facts.mjs");

test("a card number: the checksum, a card network's start and its length", () => {
  for (const n of ["4242424242424242", "4111111111111111", "5555555555554444", "2223003122003222", "378282246310005", "6011111111111117",
    "3530111333300000", "36227206271667", "6200000000000005", "4000056655665556"]) assert.ok(isCardNumber(n), n);
  // The checksum alone isn't enough: no network starts so, or not at that length.
  for (const n of ["1234567812345670", "490154203237518" /* an IMEI */, "9780306406157" /* an ISBN */, "4222222222222" /* 13-digit Visa, no longer issued */,
    "4242424242424241" /* checksum fails */, "42424242", ""]) assert.ok(!isCardNumber(n), n);
});

test("card numbers in text: written as cards are, also among other numbers; IMEIs, ISBNs and tracking numbers stay", () => {
  assert.deepEqual(cardNumbersIn("paid with 4242 4242 4242 4242 today"), ["4242424242424242"]);
  assert.deepEqual(cardNumbersIn("Order 12 4242-4242-4242-4242"), ["4242424242424242"]);
  assert.deepEqual(cardNumbersIn("3782 822463 10005"), ["378282246310005"]);
  assert.ok(holdsCardNumber("5555555555554444"));
  for (const t of ["IMEI 490154203237518", "ISBN 9780306406157", "USPS 9400111899223197428490", "Order 1234 5678 1234 5670", "+31 6 1234 5678", "0612345678", 42, null]) assert.ok(!holdsCardNumber(t), String(t));
});

test("card fields by autocomplete: number, security code and expiry refused; the name on the card and its type are not", () => {
  assert.deepEqual(CARD_TOKENS, ["cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"]);
  assert.equal(cardToken("billing cc-number"), "cc-number");
  assert.equal(cardToken("CC-EXP-MONTH"), "cc-exp-month");
  for (const a of ["cc-name", "cc-given-name", "cc-family-name", "cc-additional-name", "cc-type", "email", "", null]) assert.equal(cardToken(a), "", String(a));
});

test("a digit key or a paste is what types a card into a focused field", () => {
  for (const k of ["4", "Digit4", "Numpad7", "Shift+4"]) assert.equal(cardKey(k), "digit", k);
  for (const k of ["Meta+v", "Control+V", "ControlOrMeta+v", "Shift+Insert", "Meta+KeyV",
    "Meta+Shift+v", "Control+Shift+V", "ControlOrMeta+Shift+v", "Shift+Meta+v", "Meta+Alt+Shift+v", "Alt+Control+v", "Meta+Control+v", "Meta+Meta+v"]) assert.equal(cardKey(k), "paste", k);
  for (const k of ["Tab", "Enter", "a", "Meta+c", "ArrowDown", "F4", "Shift+v", "Alt+v", "Meta+Shift+c", "Control+Insert"]) assert.equal(cardKey(k), "", k);
});

test("the refusal names the signal and hands the step over", () => {
  assert.equal(cardRefusal(SIGNALS.number), `Refused (the text holds a card number). ${CARD_RULE}`);
  assert.match(CARD_RULE, /^Card details are the person's to enter: hand this step over with pairbrowse_status kind you, step payment/);
});

test("the page reads: a cc-* field, a field in a frame holding card fields, another site's payment frame; never the page's own frames or a plain field", async () => {
  const page = cardPage({ fields: {
    e1: { autocomplete: "cc-number" }, e2: { autocomplete: "cc-name" }, e3: { autocomplete: "cc-exp-year", tag: "SELECT" }, e4: { autocomplete: "email" },
    f1e1: { frame: { origin: "https://js.pay.example", cardFields: true } },
    f2e1: { frame: { origin: "https://pay.example", cardFields: false, allow: "payment *; fullscreen" } },
    f3e1: { frame: { origin: "https://shop.example", cardFields: false, allow: "payment" } },
    f4e1: { frame: { origin: "https://forms.example", cardFields: false, allow: "fullscreen" } },
  } });
  assert.equal(await cardFieldAt(page, "e1"), SIGNALS.token("cc-number"));
  assert.equal(await cardFieldAt(page, "e3"), SIGNALS.token("cc-exp-year"));
  assert.equal(await cardFieldAt(page, "f1e1"), SIGNALS.cardFrame);
  assert.equal(await cardFieldAt(page, "f2e1"), SIGNALS.payFrame);
  for (const t of ["e2", "e4", "f3e1", "f4e1", "e99", "", undefined]) assert.equal(await cardFieldAt(page, t), "", String(t));
  assert.equal(await focusedCardField(cardPage({ fields: { e1: { autocomplete: "cc-csc" } }, focused: "e1" })), SIGNALS.token("cc-csc"));
  assert.equal(await focusedCardField(cardPage({ fields: { e1: { autocomplete: "one-time-code" } }, focused: "e1" })), "");
  assert.equal(await focusedCardField(cardPage({})), "");
});

test("fast mode: a fill with a card number is refused before any step runs; digits or a paste into a focused card field are refused", async () => {
  assert.match(preflight([{ fill: { "Card number": "4242 4242 4242 4242" } }], "/tmp/uploads"), /^Step 1 \(fill\): Refused \(the text holds a card number\)\. Card details are the person's to enter/);
  assert.equal(preflight([{ fill: { "Order number": "1234 5678 1234 5670" } }], "/tmp/uploads"), null);
  const failed = [];
  const fail = (why) => { failed.push(why); return { failed: why }; };
  const page = cardPage({ fields: { e1: { autocomplete: "cc-number" } }, focused: "e1" });
  await press({ page, arg: "4", i: 0, steps: [{ press: "4" }], fail, run: {} });
  await press({ page, arg: "Meta+v", i: 0, steps: [{ press: "Meta+v" }], fail, run: {} });
  assert.deepEqual(failed, [cardRefusal(SIGNALS.key("digit", SIGNALS.token("cc-number"))), cardRefusal(SIGNALS.key("paste", SIGNALS.token("cc-number")))]);
});

test("fast mode's handoff step finishes when the person presses Done; a timeout or another end stops the run", async () => {
  const never = { first: () => ({ waitFor: () => new Promise(() => {}) }) };
  const page = { getByText: () => never };
  const statuses = [];
  const hooks = (ended) => ({ status: (text, kind) => statuses.push(kind), activity: () => {}, turnEnded: () => Promise.resolve(ended) });
  const fail = (why) => ({ failed: why });
  assert.equal(await handoff({ page, arg: { say: "Sign in", until: "Welcome" }, hooks: hooks({ id: "0123abcd", reason: "done" }), fail }), undefined);
  assert.deepEqual(statuses, ["you", "clear"]);
  assert.match((await handoff({ page, arg: { until: "Welcome" }, hooks: hooks({ id: "0123abcd", reason: "expired" }), fail })).failed, /^Nobody finished the step in time/);
  assert.match((await handoff({ page, arg: { until: "Welcome" }, hooks: hooks({ id: "0123abcd", reason: "tab-closed" }), fail })).failed, /ended before the step was done \(tab-closed\)/);
});

test("remembered details never keep a card number, from the agent or from a form", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pb-cards-")), "facts.json");
  const secrets = { get: () => ({ values: {}, domains: {} }), save() {} };
  const facts = createFacts({ secrets, file });
  const r = facts.command({ action: "remember", details: { "Gift card": "4242 4242 4242 4242", City: "Utrecht" } });
  assert.match(r.text, /Not saved: Gift card: holds a card number, not stored/);
  facts.seenInForm("Reference", "5555555555554444", "shop.example");
  assert.deepEqual(facts.summary().details.map((d) => d.label), ["City"]);
});
