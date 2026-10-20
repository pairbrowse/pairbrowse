// The audit trail (daemon/audit.mjs, spec server-mode B17): append-only JSON lines in an
// owner-only file, a fixed set of fields and words (no key, link, secret value or page content
// gets in), rotation at 1 MB, and a link or another file at its name refused.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createAudit, auditLine, tabPlace, KINDS, DETAILS, AUDIT_MAX_BYTES, CHANNEL_TYPES } = await import("../scripts/daemon/audit.mjs");
const { paths, HOME } = await import("../scripts/paths.mjs");

const posix = process.platform !== "win32";
const dir = () => mkdtempSync(join(tmpdir(), "pb-audit-"));
const linesOf = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const KEY = "a".repeat(64);

test("paths.audit is audit.jsonl in the home", () => {
  assert.equal(paths.audit, join(HOME, "audit.jsonl"));
  assert.equal(AUDIT_MAX_BYTES, 1024 * 1024);
});

test("append-only, 0600: each event one line with exactly t, kind, grant, session, tab, detail", () => {
  const file = join(dir(), "audit.jsonl");
  let t = 1_800_000_000_000;
  const audit = createAudit({ file, now: () => t++ });
  assert.equal(existsSync(file), false, "made on first use");
  assert.equal(audit.append({ kind: "minted", grant: "3fa1c2d9", session: "default", tab: "https://shop.example/checkout?token=abc#x", detail: "payment" }), true);
  const before = readFileSync(file, "utf8");
  assert.equal(audit.append({ kind: "notified", grant: "3fa1c2d9", detail: ["telegram", "ntfy"] }), true);
  assert.equal(audit.append({ kind: "redeemed", grant: "3fa1c2d9", session: "work_2" }), true);
  assert.equal(audit.append({ kind: "ended", grant: "3fa1c2d9", detail: "done" }), true);
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith(before), "earlier lines are never rewritten");
  const lines = linesOf(file);
  assert.equal(lines.length, 4);
  for (const l of lines) assert.deepEqual(Object.keys(l), ["t", "kind", "grant", "session", "tab", "detail"]);
  assert.deepEqual(lines[0], { t: 1_800_000_000_000, kind: "minted", grant: "3fa1c2d9", session: "default", tab: "https://shop.example/checkout", detail: "payment" });
  assert.deepEqual(lines[1].detail, ["telegram", "ntfy"]);
  assert.equal(lines[2].tab, null);
  assert.equal(lines[2].detail, null);
  assert.equal(auditLine({ kind: "redeemed", detail: [] }).line.detail, null, "an empty detail is written as null");
  if (posix) assert.equal(statSync(file).mode & 0o777, 0o600);
  // A second audit on the same file (a helper restart) appends after what is there.
  createAudit({ file, now: () => t }).append({ kind: "reuse", grant: "3fa1c2d9", detail: "redeem-key" });
  assert.equal(linesOf(file).length, 5);
  assert.ok(readFileSync(file, "utf8").startsWith(text));
});

test("a file made wider by hand is owner-only again at the next line, and when it rotates", { skip: !posix }, () => {
  const file = join(dir(), "audit.jsonl");
  writeFileSync(file, "");
  chmodSync(file, 0o644);
  const audit = createAudit({ file, maxBytes: 200 });
  assert.equal(audit.append({ kind: "redeemed", grant: "00000000" }), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // Widened again and full: it moves to .1 owner-only.
  chmodSync(file, 0o644);
  writeFileSync(file, "x".repeat(190), { flag: "a" });
  assert.equal(audit.append({ kind: "redeemed", grant: "00000001" }), true);
  assert.ok(existsSync(`${file}.1`));
  assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("unknown fields refused, and every value outside its rule: no key, link, secret or page text gets in", () => {
  const file = join(dir(), "audit.jsonl");
  const logged = [];
  const audit = createAudit({ file, log: (l) => logged.push(l) });
  const refused = [
    { kind: "minted", grant: "3fa1c2d9", key: KEY },
    { kind: "minted", link: "https://host/abc/" },
    { kind: "minted", t: 1 },
    { kind: "minted", text: "my password is hunter2" },
    { kind: "unknown-kind" },
    { kind: "minted", grant: KEY },
    { kind: "minted", grant: "3FA1C2D9" },
    { kind: "minted", session: "../etc" },
    { kind: "minted", tab: "file:///etc/passwd" },
    { kind: "minted", tab: "javascript:alert(1)" },
    { kind: "minted", tab: "not an address" },
    { kind: "minted", detail: "hunter2" },
    { kind: "minted", detail: "done" },
    { kind: "redeemed", detail: "payment" },
    { kind: "notified", detail: ["telegram", "telegram"] },
    { kind: "notified", detail: [KEY] },
    { kind: "ended", detail: { reason: "done" } },
    null, "minted", ["minted"],
  ];
  for (const e of refused) assert.equal(audit.append(e), false, JSON.stringify(e));
  assert.equal(existsSync(file), false, "nothing written");
  assert.equal(logged.length, refused.length);
  for (const l of logged) {
    assert.match(l, /^audit: refused a line \(/);
    assert.doesNotMatch(l, /hunter2|aaaaaaaa|https:|passwd|alert/, "named by field, never by value");
  }
  assert.match(logged[0], /unknown field "key"/);
  // A query, fragment or user name never reaches the file.
  assert.equal(tabPlace("https://user:pw@site.example:8443/reset/x?code=123456#frag"), "https://site.example:8443/reset/x");
  assert.equal(tabPlace("about:blank"), "about:blank");
  // A key or token in the path (the live view's and invite links' own addresses, a reset link) is "*".
  assert.equal(tabPlace(`http://127.0.0.1:5000/${KEY}/`), "http://127.0.0.1:5000/*/");
  assert.equal(tabPlace("https://site.example/reset/Zx9_-Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9L/done"), "https://site.example/reset/*/done");
  assert.equal(tabPlace("https://site.example/blog/short-post"), "https://site.example/blog/short-post");
  const keyed = createAudit({ file, log: () => {} });
  assert.equal(keyed.append({ kind: "minted", tab: `http://127.0.0.1:5000/${KEY}/` }), true);
  assert.equal(keyed.append({ kind: "minted", tab: `https://site.example/r/${"0123456789abcdef".repeat(2)}` }), true);
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /[0-9a-f]{32}/i, "no 32+ hex segment reaches the file");
  assert.deepEqual(linesOf(file).map((l) => l.tab), ["http://127.0.0.1:5000/*/", "https://site.example/r/*"]);
});

test("each kind takes only its own words; channels may grow with the notify table", () => {
  for (const kind of KINDS) {
    const words = (DETAILS[kind] || []).flatMap((w) => (w === "channels" ? CHANNEL_TYPES : [w]));
    for (const w of words) assert.ok(auditLine({ kind, detail: w }).line, `${kind} ${w}`);
    assert.ok(auditLine({ kind }).line, `${kind} with no detail`);
  }
  assert.ok(auditLine({ kind: "notify-failed", detail: "matrix" }).error);
  assert.ok(auditLine({ kind: "notify-failed", detail: "matrix" }, { channels: [...CHANNEL_TYPES, "matrix"] }).line);
  assert.ok(auditLine({ kind: "notified", detail: Array(9).fill(0).map((_, i) => `c${i}`) }, { channels: Array(9).fill(0).map((_, i) => `c${i}`) }).error, "at most 8 words");
});

test("rotation at 1 MB: the full file moves to .1 (one older generation) and a new one starts", () => {
  const file = join(dir(), "audit.jsonl");
  const audit = createAudit({ file, maxBytes: 400 });
  const ev = (i) => ({ kind: "ended", grant: i.toString(16).padStart(8, "0"), session: "default", tab: "https://a.example/", detail: "expired" });
  let n = 0;
  while (!existsSync(`${file}.1`)) assert.equal(audit.append(ev(n++)), true);
  const first = linesOf(`${file}.1`);
  assert.equal(linesOf(file).length, 1, "the line that didn't fit starts the new file");
  assert.ok(statSync(`${file}.1`).size <= 400 && statSync(file).size <= 400);
  // Filling the new file replaces .1 with it; nothing past one older generation is kept.
  while (linesOf(file).length < first.length) audit.append(ev(n++));
  audit.append(ev(n));
  assert.notDeepEqual(linesOf(`${file}.1`), first);
  assert.equal(existsSync(`${file}.2`), false);
  const all = [...linesOf(`${file}.1`), ...linesOf(file)];
  assert.ok(all.every((l, i) => i === 0 || parseInt(l.grant, 16) === parseInt(all[i - 1].grant, 16) + 1), "in order, none lost between the two");
  if (posix) assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600);
});

test("a link or a folder at the file's name is refused, never followed", { skip: !posix }, () => {
  const d = dir();
  const target = join(d, "elsewhere.txt");
  writeFileSync(target, "kept\n");
  const file = join(d, "audit.jsonl");
  symlinkSync(target, file);
  const logged = [];
  assert.equal(createAudit({ file, log: (l) => logged.push(l) }).append({ kind: "redeemed", grant: "00000000" }), false);
  assert.equal(readFileSync(target, "utf8"), "kept\n");
  assert.match(logged[0], /^audit: couldn't write .*audit\.jsonl \((?:ENOTFILE|ELOOP|EMLINK|EFTYPE)\)/);
  const folder = join(d, "folder.jsonl");
  mkdirSync(folder);
  assert.equal(createAudit({ file: folder, log: () => {} }).append({ kind: "redeemed" }), false);
});

test("a pipe at the file's name with no reader is refused at once, never waited on", { skip: !posix }, () => {
  const file = join(dir(), "audit.jsonl");
  execFileSync("mkfifo", [file]);
  const logged = [];
  const started = Date.now();
  assert.equal(createAudit({ file, log: (l) => logged.push(l) }).append({ kind: "redeemed", grant: "00000000" }), false);
  assert.ok(Date.now() - started < 1000, "returns promptly");
  assert.match(logged[0], /^audit: couldn't write .*audit\.jsonl \((?:ENOTFILE|ENXIO)\)/);
});

test("createAudit needs a file", () => {
  assert.throws(() => createAudit({}), /needs the audit file/);
});
