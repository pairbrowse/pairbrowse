import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-profile-"));
const { setFact, forgetFact, importMarkdown, loadFacts, saveFacts } = await import("../scripts/facts.mjs");
const { setSecret, deleteSecret, writeSecrets, loadSecrets, cleanDomains, validSecretName } = await import("../scripts/secrets.mjs");
const { SENSITIVE } = await import("../scripts/policy.mjs");

test("what you set beats what Claude was told or a form showed", () => {
  let d = setFact([], { label: "VAT number", value: "NL001", source: "form", site: "a.test" }).details;
  d = setFact(d, { label: "vat  number", value: "NL002", source: "you" }).details;
  assert.equal(d.length, 1, "labels match case- and space-insensitively");
  assert.equal(d[0].value, "NL002");
  d = setFact(d, { label: "VAT number", value: "NL003", source: "form" }).details;
  assert.equal(d[0].value, "NL002", "a form doesn't overwrite your value");
  d = setFact(d, { label: "VAT number", value: "NL004", source: "you" }).details;
  assert.equal(d[0].value, "NL004");
  assert.equal(forgetFact(d, "VAT NUMBER").length, 0);
  assert.ok(setFact([], { label: "", value: "x", source: "you" }).error);
  assert.ok(setFact([], { label: "VAT", value: "  ", source: "you" }).error, "no empty values");
});

test("old facts.md lines are imported", () => {
  const got = importMarkdown("# Company\n- Legal name: ReplyBay B.V.\n- VAT / tax ID:\n- Support email: support@replybay.ai\n");
  assert.deepEqual(got.map((x) => x.label), ["Legal name", "Support email"]);
  saveFacts(got.map((x) => ({ ...x, source: "you" })));
  assert.equal(loadFacts().length, 2);
});

test("an unreadable facts file is never overwritten", () => {
  const f = join(process.env.PAIRBROWSE_HOME, "broken-facts.json");
  writeFileSync(f, '{"details": [{"label": "Legal name", "value": "ReplyBay B.V."},');
  const logged = [];
  assert.deepEqual(loadFacts(f, (m) => logged.push(m)), []);
  assert.equal(logged.length, 1, "the problem is logged");
  assert.throws(() => saveFacts([{ label: "VAT", value: "NL1", source: "you" }], f), /can't be read/);
  assert.match(readFileSync(f, "utf8"), /ReplyBay/, "the file is left as it was");
  assert.deepEqual(loadFacts(join(process.env.PAIRBROWSE_HOME, "missing-facts.json")), [], "a missing file is just empty");
});

test("passwords: names, sites and values are checked", () => {
  const empty = { values: {}, domains: {} };
  assert.ok(setSecret(empty, { name: "shopify", value: "x", domains: "a.com" }).error, "name format");
  assert.ok(setSecret(empty, { name: "SHOPIFY_PW", value: "x", domains: "" }).error, "needs a site");
  assert.ok(setSecret(empty, { name: "SHOPIFY_PW", value: "x", domains: "not a site" }).error);
  assert.ok(setSecret(empty, { name: "SHOPIFY_PW", value: "a\nEVIL=1", domains: "a.com" }).error, "no line breaks");
  assert.ok(setSecret(empty, { name: "SHOPIFY_PW", value: "", domains: "a.com" }).error, "a new password needs a value");
  assert.deepEqual(cleanDomains("https://accounts.shopify.com/login, *.example.com").domains, ["accounts.shopify.com", "example.com"]);
  assert.equal(validSecretName("X_DOMAINS"), false);
  const one = setSecret(empty, { name: "SHOPIFY_PW", value: 'p"a ss#1', domains: "accounts.shopify.com" });
  const kept = setSecret(one, { name: "SHOPIFY_PW", value: "", domains: "shopify.com" });
  assert.equal(kept.values.SHOPIFY_PW, 'p"a ss#1', "empty value keeps the password, changes sites");
  assert.deepEqual(deleteSecret(kept, "SHOPIFY_PW").values, {});
});

test("passwords round-trip through a private file", { skip: process.platform === "win32" }, () => {
  const f = join(process.env.PAIRBROWSE_HOME, "secrets.env");
  writeFileSync(f, "");
  writeSecrets(f, setSecret({ values: {}, domains: {} }, { name: "META_PW", value: 'we"ird #pass', domains: "facebook.com" }));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const back = loadSecrets(f);
  assert.equal(back.values.META_PW, 'we"ird #pass');
  assert.deepEqual(back.domains.META_PW, ["facebook.com"]);
});

test("passwords and codes are never remembered from forms", () => {
  for (const l of ["Password", "Confirm password", "Passcode", "PIN", "Verification code", "One-time code", "Card number", "CVC", "IBAN", "API token"]) assert.ok(SENSITIVE.test(l), l);
  for (const l of ["Business name", "Email", "Country", "Website URL", "Postal code area"].slice(0, 4)) assert.ok(!SENSITIVE.test(l), l);
});
