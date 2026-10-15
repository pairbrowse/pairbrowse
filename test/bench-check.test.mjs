// The bench's budget check (test/bench-check.mjs): pass, miss, missing metric, failed run, units.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkBudgets, formatCheck, metricAt } from "./bench-check.mjs";

const spec = { screenshots: true, budgets: { "click.p50": { max: 600, unit: "ms" }, "helperMemEnd.rss": { max: 260, unit: "MB", scale: 1048576 }, "idleAfterWork.perKind.helper": { max: 1, unit: "%" } } };
const good = { screenshots: true, click: { p50: 517 }, helperMemEnd: { rss: 210 * 1048576 }, idleAfterWork: { perKind: { helper: 0.4 } } };
const off = { screenshots: false, click: { p50: 9999 } };

test("metricAt reads dotted paths and stops at non-objects", () => {
  assert.equal(metricAt(good, "click.p50"), 517);
  assert.equal(metricAt(good, "click.p50.x"), undefined);
  assert.equal(metricAt(good, "nope.p50"), undefined);
});

test("all within budget passes; the screenshots-off run is not the one checked", () => {
  const r = checkBudgets([good, off], spec);
  assert.equal(r.pass, true);
  assert.deepEqual(r.rows.map((x) => [x.metric, x.value, x.pass]), [["click.p50", 517, true], ["helperMemEnd.rss", 210, true], ["idleAfterWork.perKind.helper", 0.4, true]]);
  assert.match(formatCheck(r), /all budgets met/);
});

test("a metric over its budget fails and is named", () => {
  const r = checkBudgets([{ ...good, click: { p50: 601 } }], spec);
  assert.equal(r.pass, false);
  assert.deepEqual(r.rows.filter((x) => !x.pass).map((x) => x.metric), ["click.p50"]);
  assert.match(formatCheck(r), /FAIL {2}click\.p50 +601 ms {2}\(budget <= 600 ms\)/);
  assert.match(formatCheck(r), /1 miss/);
});

test("exactly at the budget passes; scale converts before comparing", () => {
  const r = checkBudgets([{ ...good, click: { p50: 600 }, helperMemEnd: { rss: 261 * 1048576 } }], spec);
  assert.deepEqual(r.rows.map((x) => x.pass), [true, false, true]);
});

test("a missing metric, a failed run or no matching run fails", () => {
  const missing = checkBudgets([{ screenshots: true, click: { p50: 500 } }], spec);
  assert.equal(missing.pass, false);
  assert.match(formatCheck(missing), /missing/);
  const failed = checkBudgets([{ ...good, error: "boom\nstack" }], spec);
  assert.equal(failed.pass, false);
  assert.match(failed.error, /boom$/);
  assert.equal(checkBudgets([off], spec).pass, false);
  assert.equal(checkBudgets([good], { screenshots: true, budgets: {} }).pass, false);
});

test("the shipped budgets file names metrics the bench result has", () => {
  const shipped = JSON.parse(readFileSync(new URL("./bench-budgets.json", import.meta.url), "utf8"));
  const sample = { screenshots: true, click: { p50: 1 }, startup: { totalMs: 1 }, helperMemEnd: { rss: 1 }, idleAfterWork: { perKind: { helper: 0 } } };
  const r = checkBudgets([sample], shipped);
  assert.equal(r.rows.length, Object.keys(shipped.budgets).length);
  assert.ok(r.rows.every((x) => x.value !== null), JSON.stringify(r.rows));
});
