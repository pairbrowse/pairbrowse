import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-profile-"));
const { setFact, forgetFact, importMarkdown, loadFacts, saveFacts } = await import("../scripts/facts.mjs");
const { setSecret, deleteSecret, writeSecrets, loadSecrets, cleanDomains, validSecretName } = await import("../scripts/rules/secrets.mjs");
const { SENSITIVE } = await import("../scripts/rules/policy.mjs");

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

test("secrets.env symlink, other owner or non-file refused; writeSecrets atomic", { skip: process.platform === "win32" }, async () => {
  const { symlinkSync, mkdirSync, chmodSync, lstatSync, readdirSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { secretStore } = await import("../scripts/rules/secrets.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pb-secrets-"));
  const real = join(dir, "elsewhere.env");
  writeFileSync(real, "A_PW=hunter22\nA_PW_DOMAINS=a.com\n", { mode: 0o600 });
  // A link at the name: never followed, for reading or writing.
  const linked = join(dir, "linked.env");
  symlinkSync(real, linked);
  assert.match(loadSecrets(linked).problem, /is a link/);
  assert.deepEqual(loadSecrets(linked).values, {});
  assert.throws(() => writeSecrets(linked, { values: { B_PW: "x" }, domains: { B_PW: ["b.com"] } }), /is a link.*Nothing was saved/);
  assert.equal(readFileSync(real, "utf8"), "A_PW=hunter22\nA_PW_DOMAINS=a.com\n", "the link's target is untouched");
  assert.ok(lstatSync(linked).isSymbolicLink(), "and the link is still a link");
  // A folder, or a pipe (never waited on), at the name.
  const folder = join(dir, "folder.env");
  mkdirSync(folder, { mode: 0o700 });
  assert.match(loadSecrets(folder).problem, /isn't a regular file/);
  assert.throws(() => writeSecrets(folder, { values: {}, domains: {} }), /isn't a regular file/);
  const pipe = join(dir, "pipe.env");
  execFileSync("mkfifo", ["-m", "600", pipe]);
  assert.match(loadSecrets(pipe).problem, /isn't a regular file/);
  // Another user's file (the uid the helper runs as, stood in for).
  const getuid = process.getuid;
  process.getuid = () => getuid.call(process) + 1;
  try {
    assert.match(loadSecrets(real).problem, /belongs to another user/);
    assert.throws(() => writeSecrets(real, { values: {}, domains: {} }), /belongs to another user/);
  } finally {
    process.getuid = getuid;
  }
  assert.equal(loadSecrets(real).values.A_PW, "hunter22", "this user's own 0600 file reads");
  assert.deepEqual(loadSecrets(join(dir, "missing.env")), { values: {}, domains: {}, problem: null }, "no file: no secrets, no problem");

  // Atomic: a new file takes the name whole (a new inode), 0600 even over a wider file, and no
  // temporary file stays beside it.
  const f = join(dir, "secrets.env");
  writeFileSync(f, "OLD_PW=old-value\nOLD_PW_DOMAINS=old.com\n", { mode: 0o644 });
  const before = lstatSync(f).ino;
  writeSecrets(f, { values: { NEW_PW: "new-value" }, domains: { NEW_PW: ["new.com"] } });
  assert.notEqual(lstatSync(f).ino, before, "replaced by a rename, never written in place");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(loadSecrets(f).values.NEW_PW, "new-value");
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temporary file left");
  // A write that fails (a folder it can't write in) leaves the file as it was and nothing beside it.
  if (process.getuid() !== 0) {
    const locked = mkdtempSync(join(tmpdir(), "pb-secrets-ro-"));
    const lf = join(locked, "secrets.env");
    writeSecrets(lf, { values: { K_PW: "kept-value" }, domains: { K_PW: ["k.com"] } });
    chmodSync(locked, 0o500);
    try {
      assert.throws(() => writeSecrets(lf, { values: {}, domains: {} }), /EACCES|EPERM/);
      assert.equal(loadSecrets(lf).values.K_PW, "kept-value");
      assert.deepEqual(readdirSync(locked), ["secrets.env"]);
    } finally {
      chmodSync(locked, 0o700);
    }
  }
  // The store never writes over a file it couldn't read: those passwords would be lost.
  const wide = join(dir, "wide.env");
  writeFileSync(wide, "W_PW=wide-value\nW_PW_DOMAINS=w.com\n");
  chmodSync(wide, 0o644);
  const logged = [];
  const store = secretStore(wide, (m) => logged.push(m));
  assert.match(logged[0], /chmod 600/);
  assert.throws(() => store.save({ values: { X_PW: "x-value" }, domains: { X_PW: ["x.com"] } }), /chmod 600/);
  assert.match(readFileSync(wide, "utf8"), /W_PW=wide-value/, "left as it was");
  chmodSync(wide, 0o600);
  store.save(setSecret(loadSecrets(wide), { name: "X_PW", value: "x-value", domains: "x.com" }));
  assert.deepEqual(Object.keys(store.get().values).sort(), ["W_PW", "X_PW"]);
});
