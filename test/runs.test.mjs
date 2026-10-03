import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pairbrowse-"));
const { saveRun, listRuns, saveReview, latestReview } = await import("../scripts/runs.mjs");

test("runs accumulate done items and drop them from left", () => {
  saveRun({ name: "Shopify App Listing", goal: "List the app", left: ["Basics", "Pricing", "Screenshots"], yourTurn: ["Upload ID"] });
  const run = saveRun({ name: "Shopify App Listing", done: ["Basics"], tabs: [{ title: "Partners", url: "https://partners.shopify.com" }] });
  assert.deepEqual(run.done, ["Basics"]);
  assert.deepEqual(run.left, ["Pricing", "Screenshots"]);
  assert.deepEqual(run.yourTurn, ["Upload ID"]);
  assert.equal(run.tabs[0].url, "https://partners.shopify.com");
  assert.equal(listRuns()[0].goal, "List the app");
});

test("a review passes only when every check is ok or waived", () => {
  assert.equal(saveReview({ platform: "x", guidelinesUrl: "u", checks: [{ rule: "a", ok: true }, { rule: "b", ok: false }] }).passed, false);
  assert.equal(saveReview({ platform: "x", guidelinesUrl: "u", checks: [{ rule: "a", ok: true }, { rule: "b", ok: false, waived: true }] }).passed, true);
  assert.equal(saveReview({ platform: "x", guidelinesUrl: "u", checks: [] }).passed, false);
  assert.equal(latestReview().passed, false);
});

test("run names can't escape the runs folder", async () => {
  const { readdirSync } = await import("node:fs");
  saveRun({ name: "../../etc/passwd" });
  assert.ok(readdirSync(join(process.env.PAIRBROWSE_HOME, "runs")).includes("etc-passwd.json"));
});
