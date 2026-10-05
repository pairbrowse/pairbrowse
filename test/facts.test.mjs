import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-facts-"));
const { createFacts, loadFacts, FACTS_FILE, cleanLabel, cleanValue } = await import("../scripts/facts.mjs");
const { paths } = await import("../scripts/paths.mjs");

// The password store as createFacts sees it.
function fakeSecrets(values = {}, domains = {}) {
  let current = { values, domains };
  return { get: () => current, save: (next) => { current = next; } };
}
const fresh = () => join(mkdtempSync(join(tmpdir(), "pb-facts-f-")), "facts.json");

test("details Claude is told are remembered, and saved passwords never are", () => {
  const changes = [];
  const file = fresh();
  const facts = createFacts({ secrets: fakeSecrets({ SHOP_PW: "hunter2-secret" }, { SHOP_PW: ["shop.test"] }), file, onChange: () => changes.push(1) });
  assert.deepEqual(facts.command({ action: "remember", details: { "Company name": "ReplyBay B.V.", Email: "a@replybay.test" } }), { text: "Remembered 2 detail(s)." });
  const partial = facts.command({ action: "remember", details: { Login: "hunter2-secret", City: "Utrecht" } });
  assert.equal(partial.text, "Saved the rest. Not saved: Login: looks like a saved password, not stored");
  assert.ok(!partial.error);
  const none = facts.command({ action: "remember", details: { Login: "hunter2-secret", "": "x" } });
  assert.equal(none.error, true);
  assert.match(none.text, /^Not saved: Login: looks like a saved password.*: A detail needs a short label and a value\.$/);
  assert.equal(changes.length, 3);
  const saved = JSON.parse(readFileSync(file, "utf8")).details;
  assert.deepEqual(saved.map((d) => [d.label, d.value, d.source]), [["Company name", "ReplyBay B.V.", "claude"], ["Email", "a@replybay.test", "claude"], ["City", "Utrecht", "claude"]]);
  assert.ok(!readFileSync(file, "utf8").includes("hunter2"));
});

test("get lists details and password names with their sites, never password values", () => {
  const facts = createFacts({ secrets: fakeSecrets({ SHOP_PW: "hunter2-secret", BANK: "correct-horse" }, { SHOP_PW: ["shop.test", "admin.shop.test"] }), file: fresh() });
  assert.match(facts.command({ action: "get" }).text, /^Nothing remembered yet\.\n\nSaved passwords \(type the NAME as the value\): SHOP_PW \(shop\.test, admin\.shop\.test\); BANK \(\)$/);
  facts.command({ action: "remember", details: { Phone: "+31 6 1234" } });
  facts.seenInForm("Postcode", "3511 AB", "shop.test");
  facts.seenInForm("Country", "NL", "");
  const text = facts.command({ action: "get" }).text;
  assert.match(text, /^Phone: \+31 6 1234\nPostcode: 3511 AB \(seen in a form on shop\.test\)\nCountry: NL \(seen in a form\)\n/);
  assert.ok(!text.includes("hunter2") && !text.includes("correct-horse"));
  const empty = createFacts({ secrets: fakeSecrets(), file: fresh() }).command({});
  assert.match(empty.text, /none\. The user adds them in the Profile panel/);
});

test("what the person set in the Profile panel isn't overwritten by Claude or a form", () => {
  const facts = createFacts({ secrets: fakeSecrets(), file: fresh() });
  assert.equal(facts.profile.setDetail("VAT number", "NL001"), null);
  facts.command({ action: "remember", details: { "vat  NUMBER": "NL999" } });
  facts.seenInForm("VAT number", "NL888", "x.test");
  assert.deepEqual(facts.summary().details.map((d) => [d.label, d.value, d.source]), [["VAT number", "NL001", "you"]]);
  assert.equal(facts.profile.setDetail("VAT number", "NL002"), null, "the person can change it");
  assert.equal(facts.summary().details[0].value, "NL002");
  assert.equal(facts.profile.setDetail("x".repeat(81), "v"), "A detail needs a short label and a value.");
  assert.equal(facts.profile.forgetDetail("vat number"), null);
  assert.deepEqual(facts.summary().details, []);
});

test("forget removes details by label, whatever the case or spacing", () => {
  const facts = createFacts({ secrets: fakeSecrets(), file: fresh() });
  facts.command({ action: "remember", details: { "Legal name": "A", City: "B" } });
  assert.deepEqual(facts.command({ action: "forget", labels: ["  LEGAL   name ", "Nope"] }), { text: "Forgot 2 detail(s)." });
  assert.deepEqual(facts.summary().details.map((d) => d.label), ["City"]);
});

test("an unreadable facts file is reported and left as it is", () => {
  const file = fresh();
  writeFileSync(file, "{ broken");
  const logs = [];
  const facts = createFacts({ secrets: fakeSecrets(), file, log: (m) => logs.push(m) });
  assert.match(logs[0], /can't be read; nothing is remembered/);
  const r = facts.command({ action: "forget", labels: ["x"] });
  assert.equal(r.error, true);
  assert.match(r.text, /isn't overwritten/);
  assert.equal(facts.profile.setDetail("City", "Utrecht"), r.text);
  assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("passwords set from the Profile panel go to the password store and are logged by name only", () => {
  const secrets = fakeSecrets();
  const logs = [];
  const facts = createFacts({ secrets, file: fresh(), log: (m) => logs.push(m) });
  assert.equal(facts.profile.setSecret({ name: "SHOP_PW", value: "hunter2-secret", domains: "shop.test" }), null);
  assert.equal(secrets.get().values.SHOP_PW, "hunter2-secret");
  assert.deepEqual(facts.summary().secrets, [{ name: "SHOP_PW", domains: ["shop.test"] }]);
  assert.ok(typeof facts.profile.setSecret({ name: "bad name", value: "x", domains: "" }) === "string");
  facts.profile.deleteSecret("SHOP_PW");
  assert.deepEqual(facts.summary().secrets, []);
  assert.deepEqual(logs, ["password SHOP_PW saved from the Profile panel", "password SHOP_PW deleted from the Profile panel"]);
});

test("an old facts.md is imported once into facts.json", () => {
  assert.equal(FACTS_FILE, join(process.env.PAIRBROWSE_HOME, "facts.json"));
  writeFileSync(paths.facts, "# Company\n- Legal name: ReplyBay B.V.\n* City : Utrecht\nnot a detail\n");
  const got = loadFacts();
  assert.deepEqual(got.map((d) => [d.label, d.value, d.source]), [["Legal name", "ReplyBay B.V.", "you"], ["City", "Utrecht", "you"]]);
  assert.ok(existsSync(FACTS_FILE));
  writeFileSync(paths.facts, "- Other: thing\n");
  assert.deepEqual(loadFacts().map((d) => d.label), ["Legal name", "City"], "facts.json wins once it's there");
});

test("labels and values are short single-line text", () => {
  assert.equal(cleanLabel("  Legal \n name "), "Legal name");
  assert.equal(cleanLabel(""), null);
  assert.equal(cleanLabel(null), null);
  assert.equal(cleanValue("line 1\r\nline 2\rline 3"), "line 1\nline 2\nline 3");
  assert.equal(cleanValue("a\u0000b"), null);
  assert.equal(cleanValue("x".repeat(2001)), null);
  assert.equal(cleanValue("tab\there"), "tab\there");
});
