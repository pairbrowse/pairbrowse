import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutput } from "../scripts/daemon/output.mjs";

const setup = (values = { SHOP_PW: "hunter2-secret" }) => {
  const dir = mkdtempSync(join(tmpdir(), "pb-output-"));
  return { dir, out: createOutput({ dir, secretValues: () => values }) };
};

test("passwords in results become their names, and the newest saved ones count", () => {
  const values = { SHOP_PW: "hunter2-secret" };
  const { out } = setup(values);
  assert.equal(out.mask("typed hunter2-secret twice: hunter2-secret"), "typed <secret>SHOP_PW</secret> twice: <secret>SHOP_PW</secret>");
  values.BANK_PW = "correct-horse";
  assert.equal(out.mask("correct-horse"), "<secret>BANK_PW</secret>", "a password saved after start is masked at once");
});

test("a password that starts with another saved one is masked whole", () => {
  const { out } = setup({ SHORT: "hunter2", LONG: "hunter2xyz9" });
  const masked = out.mask("a=hunter2 b=hunter2xyz9");
  assert.equal(masked, "a=<secret>SHORT</secret> b=<secret>LONG</secret>");
  assert.ok(!masked.includes("xyz9"));
});

test("snapshot files a result links to are masked; your own files and unlinked ones are left alone", () => {
  const { dir, out } = setup();
  const snap = join(dir, "page-2026-10-06T10-00-00-000Z.yml");
  const other = join(dir, "page-2026-10-06T11-00-00-000Z.yml");
  const mine = join(dir, "notes.txt");
  for (const f of [snap, other, mine]) writeFileSync(f, "password: hunter2-secret\n");
  out.maskLinkedFiles(`- [Snapshot](${snap}) and [mine](${mine})`);
  assert.equal(readFileSync(snap, "utf8"), "password: <secret>SHOP_PW</secret>\n");
  assert.equal(readFileSync(other, "utf8"), "password: hunter2-secret\n", "only linked files");
  assert.equal(readFileSync(mine, "utf8"), "password: hunter2-secret\n", "never a file that isn't Playwright's output");
});

test("a link can't reach outside the files folder", () => {
  const { dir, out } = setup();
  const outside = mkdtempSync(join(tmpdir(), "pb-outside-"));
  const name = "page-2026-10-06T10-00-00-000Z.yml";
  writeFileSync(join(outside, name), "hunter2-secret");
  out.maskLinkedFiles(`[x](${join(outside, name)}) [y](../${name})`);
  assert.equal(readFileSync(join(outside, name), "utf8"), "hunter2-secret");
  assert.ok(!existsSync(join(dir, name)));
});

test("a long snapshot is cut at a line and the whole of it saved where Claude is told", () => {
  const { dir, out } = setup();
  const short = "x".repeat(24_000 * 1.25);
  assert.equal(out.capSnapshot(short), short, "a little over isn't cut");
  const lines = Array.from({ length: 4000 }, (_, i) => `- line ${i} ${"y".repeat(10)}`).join("\n");
  const capped = out.capSnapshot(lines);
  assert.ok(capped.length < lines.length);
  const head = capped.split("\n```\n")[0];
  assert.ok(head.length <= 24_000 && lines.startsWith(`${head}\n`), "whole lines only");
  const file = capped.match(/The whole snapshot is in (\S+)\.$/)[1];
  assert.equal(join(dir, file.split(/[\\/]/).pop()), file);
  assert.equal(readFileSync(file, "utf8"), lines);
  assert.match(capped, /about \d+ tokens/);
});

test("at start, old snapshot files are masked and those over an hour old are swept", () => {
  const { dir, out } = setup();
  const fresh = join(dir, "console-2026-10-06T10-00-00-000Z.log");
  const old = join(dir, "page-2026-10-01T10-00-00-000Z.yml");
  const mine = join(dir, "page-old-notes.yml");
  for (const f of [fresh, old, mine]) writeFileSync(f, "hunter2-secret");
  const longAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
  utimesSync(old, longAgo, longAgo);
  utimesSync(mine, longAgo, longAgo);
  out.start();
  assert.equal(readFileSync(fresh, "utf8"), "<secret>SHOP_PW</secret>");
  assert.ok(!existsSync(old));
  assert.equal(readFileSync(mine, "utf8"), "hunter2-secret", "not Playwright's name: kept and untouched");
});

test("a files folder that isn't there doesn't stop the helper", () => {
  const out = createOutput({ dir: join(tmpdir(), "pb-missing-", String(Date.now())), secretValues: () => ({}) });
  assert.doesNotThrow(() => out.start());
  assert.doesNotThrow(() => out.maskLinkedFiles("[x](page-2026-10-06T10-00-00-000Z.yml)"));
});
