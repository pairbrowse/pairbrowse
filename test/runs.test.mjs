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

// The runs MCP server as Claude Code starts it: JSON-RPC lines on stdin and stdout.
async function rpc(requests) {
  const { spawn } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "pairbrowse-rpc-"));
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "scripts", "runs.mjs")], { env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const lines = () => out.split("\n").filter(Boolean);
  const expected = requests.filter((r) => typeof r === "object" && r.id !== undefined).length;
  for (const r of requests) child.stdin.write(`${typeof r === "string" ? r : JSON.stringify(r)}\n`);
  const until = Date.now() + 10_000;
  while (lines().length < expected && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  // Its stdin closing ends it, as when Claude Code quits.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await exited;
  // Matched to requests by id.
  const byId = Object.fromEntries(lines().map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  return requests.filter((r) => typeof r === "object" && r.id !== undefined).map((r) => byId[r.id]);
}
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const text = (r) => r.result.content[0].text;

test("the runs server answers MCP requests and skips notifications and junk", async () => {
  const [init, list, ping, missing] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    "not json",
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    { jsonrpc: "2.0", id: 4, method: "resources/list" },
  ]);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "pairbrowse-runs");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["run_save", "run_list", "run_get", "review_save"]);
  assert.deepEqual(ping, { jsonrpc: "2.0", id: 3, result: {} });
  assert.equal(missing.error.code, -32601);
});

test("runs are saved and read back through the server; a review says what fails", async () => {
  const [none, saved, got, unknown, failed, passed, bad] = await rpc([
    call(1, "run_list", {}),
    call(2, "run_save", { name: "App listing", goal: "List it", left: ["Pricing"], drafted: ["Description"], notes: "Ask about logo", tabs: [{ title: "Partners", url: "https://partners.test/" }] }),
    call(3, "run_get", { name: "app listing" }),
    call(4, "run_get", { name: "nope" }),
    call(5, "review_save", { platform: "x", guidelinesUrl: "u", checks: [{ rule: "Icon 512px", ok: false, note: "it's 256" }, { rule: "Privacy URL", ok: true }] }),
    call(6, "review_save", { platform: "x", guidelinesUrl: "u", checks: [{ rule: "Icon 512px", ok: true }] }),
    call(7, "no_such_tool", {}),
  ]);
  assert.equal(text(none), "No saved runs.");
  assert.match(text(saved), /^Run "App listing" \(open, updated [^)]+\)\nGoal: List it\nDrafted by Claude: Description\nLeft: Pricing\nNotes: Ask about logo\nTabs when saved: Partners <https:\/\/partners\.test\/>$/);
  assert.equal(text(got), text(saved), "names match by their slug");
  assert.equal(text(unknown), 'No run named "nope".');
  assert.equal(text(failed), "Review FAILED. Fix these before submitting:\n- Icon 512px: it's 256");
  assert.match(text(passed), /^Review passed \(1 checks\)\. Submit is unlocked for 30 minutes/);
  assert.equal(bad.result.isError, true);
  assert.equal(text(bad), "Unknown tool no_such_tool");
});

test("an auto run reads back as the agent's own notes; a taken-over one points to its new run", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "pairbrowse-auto-"));
  mkdirSync(join(home, "runs"));
  const auto = { name: "shopify.com 2026-10-10 14:05", status: "in progress", source: "auto", session: "default", createdAt: "2026-10-10T12:05:00.000Z", updatedAt: new Date().toISOString(),
    done: ["Create your account <https://www.shopify.com/signup>: Filled **Email** = `ada@example.com`; Clicked **Continue**"], left: ["Company"], yourTurn: ["Enter the code from your phone"], drafted: [], tabs: [{ title: "Choose a password", url: "https://www.shopify.com/signup/2" }] };
  writeFileSync(join(home, "runs", "shopify-com-2026-10-10-14-05.json"), JSON.stringify(auto));
  writeFileSync(join(home, "runs", ".current.json"), JSON.stringify({ file: join(home, "runs", "shopify-com-2026-10-10-14-05.json"), session: "default" }));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "scripts", "runs.mjs")], { env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const ask = async (id, name, args) => {
    child.stdin.write(`${JSON.stringify(call(id, name, args))}\n`);
    const until = Date.now() + 10_000;
    while (!out.split("\n").filter(Boolean).some((l) => JSON.parse(l).id === id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    return text(JSON.parse(out.split("\n").filter(Boolean).find((l) => JSON.parse(l).id === id)));
  };
  const got = await ask(1, "run_get", { name: "shopify.com 2026-10-10 14:05" });
  assert.match(got, /^Run "shopify\.com 2026-10-10 14:05" \(in progress, updated [^)]+\)\nKept by PairBrowse automatically from what was done in the browser \(no run_save was called\): treat it as your own notes\.\nDone: Create your account <https:\/\/www\.shopify\.com\/signup>: Filled \*\*Email\*\* = `ada@example\.com`; Clicked \*\*Continue\*\*\nWaiting on the user: Enter the code from your phone\nLeft: Company\nTabs when saved: Choose a password <https:\/\/www\.shopify\.com\/signup\/2>$/);
  // The agent's run_save takes it over: one run under the agent's name.
  const saved = await ask(2, "run_save", { name: "Shopify signup", goal: "Open a store" });
  assert.match(saved, /^Run "Shopify signup" \(open/);
  assert.doesNotMatch(saved, /Kept by PairBrowse/);
  assert.match(saved, /Goal: Open a store\nDone: Create your account <https:\/\/www\.shopify\.com\/signup>: Filled/);
  assert.match(saved, /Waiting on the user: Enter the code from your phone\nLeft: Company\nTabs when saved: Choose a password/);
  assert.equal(await ask(3, "run_get", { name: "shopify.com 2026-10-10 14:05" }), 'Run "shopify.com 2026-10-10 14:05" was taken over by run "Shopify signup": run_get that one.');
  assert.doesNotMatch(await ask(4, "run_list", {}), /14:05/, "the merged run isn't listed");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await exited;
});
