// Shared helpers (scripts/util.mjs) with behaviour worth a check of their own.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageLoaded, spend, within } from "../scripts/util.mjs";

// A stand-in page: readyState answers in turn (a function throws or hangs), load states as given.
function fakePage(answers, states = {}) {
  const calls = [];
  return {
    calls,
    evaluate: async () => {
      calls.push("ask");
      const a = answers.shift();
      if (a === "hang") return new Promise(() => {});
      if (a === "throw") throw new Error("Execution context was destroyed");
      return a;
    },
    waitForLoadState: (state) => { calls.push(state); return states[state] === "never" ? new Promise(() => {}) : Promise.resolve(); },
  };
}

test("a page that says it's complete (restored by Back) isn't waited for", async () => {
  const page = fakePage(["complete"], { load: "never" });
  const t0 = Date.now();
  await pageLoaded(page, { maxMs: 4000 });
  assert.ok(Date.now() - t0 < 200, "no wait for a load event that never comes again");
  assert.deepEqual(page.calls, ["ask"]);
});

test("no answer right after the move: a short wait for domcontentloaded, then asked again", async () => {
  const page = fakePage(["throw", "complete"], { load: "never" });
  const t0 = Date.now();
  await pageLoaded(page, { maxMs: 4000, dclMs: 500 });
  assert.ok(Date.now() - t0 < 400);
  assert.deepEqual(page.calls, ["ask", "domcontentloaded", "ask"]);
  const hung = fakePage(["hang", "complete"], { load: "never" });
  await pageLoaded(hung, { maxMs: 4000, probeMs: 50, dclMs: 500 });
  assert.deepEqual(hung.calls, ["ask", "domcontentloaded", "ask"]);
});

test("a page still loading waits for its load event, up to the bound", async () => {
  const page = fakePage(["loading"]);
  await pageLoaded(page, { maxMs: 4000 });
  assert.deepEqual(page.calls, ["ask", "load"]);
  const slow = fakePage(["throw", "interactive"], { domcontentloaded: "never", load: "never" });
  const t0 = Date.now();
  await pageLoaded(slow, { maxMs: 150, probeMs: 50, dclMs: 50 });
  const ms = Date.now() - t0;
  assert.ok(ms >= 150 && ms < 1000, `bounded: ${ms} ms`);
  assert.deepEqual(slow.calls, ["ask", "domcontentloaded", "ask", "load"]);
});

test("within: the value, or null when the time is up; its timer never outlives the wait", async () => {
  const { within } = await import("../scripts/util.mjs");
  assert.equal(await within(1000, Promise.resolve(7)), 7);
  assert.equal(await within(20, new Promise(() => {})), null);
  await assert.rejects(within(1000, Promise.reject(new Error("no"))), /no/);
  // A settled wait leaves no timer behind: the event loop has nothing of ours left to run.
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  for (let i = 0; i < 200; i++) await within(60_000, Promise.resolve(i));
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `${after - before} timers left running`);
});

test("bounded: a page read gives up quietly with its fallback", async () => {
  const { bounded } = await import("../scripts/util.mjs");
  assert.equal(await bounded(Promise.resolve(3), 0), 3);
  assert.equal(await bounded(Promise.reject(new Error("gone")), 0), 0);
  assert.equal(await bounded(new Promise(() => {}), "x", 20), "x");
  assert.equal(await bounded(Promise.resolve(null), false), false);
});

// Files read while they may be written (tabs.json, the people file, reviews/latest.json that the
// guard reads at every call, playbooks, facts, the native install records, the host capture) go
// through the one atomic write: a reader sees the old file or the new one, never half of one.
test("state files are written atomically, through writeJsonAtomic", async () => {
  const { readFileSync } = await import("node:fs");
  // Every module (macos-app.mjs writes an app bundle's own strings file, util.mjs is the one write).
  const { readdirSync } = await import("node:fs");
  const all = readdirSync(new URL("../scripts/", import.meta.url), { recursive: true }).filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith("dev/") && !["util.mjs", "native/macos-app.mjs"].includes(f));
  assert.ok(all.includes("runner/playbooks.mjs") && all.includes("native/install.mjs"));
  for (const f of all) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /writeFileSync\([^;]*JSON\.stringify/, `${f} writes JSON in place`);
  }
  const { writeJsonAtomic, readJson } = await import("../scripts/util.mjs");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "pb-atomic-")), "x.json");
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
});

test("every config.json key the code reads has its default (or is one of the older names)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { DEFAULT_CONFIG } = await import("../scripts/paths.mjs");
  const dir = new URL("../scripts/", import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".mjs") && !f.startsWith("dev/")).map((f) => join(dir, f));
  const read = new Set();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bconfig\??\.([a-zA-Z]+)\b/g)) read.add(m[1]);
  // Still read, never written (browser/choice.mjs browserChoice, browser-args.mjs); browserProfile is
  // set by the launch (launch.mjs: the session's profile's engine layer for native-engine.mjs), and so
  // is virtualDisplay (the helper's Xvfb geometry, spec E7) and measuredBackend (the backend the
  // launch measured or kept, decision 10) and webrtcExit (the proxy's exit the helper's probe read
  // for the launch, daemon/network.mjs), never in config.json; json, mjs and map are file names
  // and a rule name (profiles/map.mjs "config.map"), not keys.
  const older = new Set(["browserEngine", "executablePath", "browserProfile", "virtualDisplay", "measuredBackend", "webrtcExit", "chromeArgs", "chromeSandbox", "json", "mjs", "map"]);
  for (const k of read) assert.ok(Object.hasOwn(DEFAULT_CONFIG, k) || older.has(k), `config.${k} has no default in DEFAULT_CONFIG`);
});

test("spend: a sliding window per holder, n at once, nothing counted when refused", () => {
  const j = {};
  for (let i = 0; i < 3; i++) assert.equal(spend(j, "x", 3, { t: 1000 + i }), true);
  assert.equal(spend(j, "x", 3, { t: 1500 }), false, "the fourth in a second");
  assert.equal(j.x.length, 3);
  assert.equal(spend(j, "x", 3, { t: 2001 }), true, "the first has left the window");
  assert.equal(spend(j, "ops", 5, { t: 0, n: 5, windowMs: 60_000 }), true);
  assert.equal(spend(j, "ops", 5, { t: 1, n: 1, windowMs: 60_000 }), false);
  assert.equal(spend(j, "ops", 5, { t: 60_001, n: 5, windowMs: 60_000 }), true);
  assert.equal(spend({ y: "junk" }, "y", 1), true, "a field that isn't a list starts empty");
});

// A wait with no bound (tabs.mjs saveNow's default deadline, Infinity) waits; Node fired such a timer
// after 1 ms with a TimeoutOverflowWarning, so a tab title read gave up at once.
test("within: Infinity or a wait past a timer's range waits for the promise, never fires early; NaN or less is no wait", async () => {
  const warned = [];
  const onWarn = (w) => warned.push(w.name);
  process.on("warning", onWarn);
  try {
    const slow = new Promise((r) => setTimeout(() => r("done"), 30));
    assert.equal(await within(Infinity, slow), "done");
    assert.equal(await within(2 ** 40, new Promise((r) => setTimeout(() => r("late"), 20))), "late");
    assert.equal(await within(NaN, new Promise(() => {})), null);
    assert.equal(await within(-5, new Promise(() => {})), null);
    await new Promise((r) => setImmediate(r));
    assert.ok(!warned.includes("TimeoutOverflowWarning"), warned.join(", "));
  } finally { process.off("warning", onWarn); }
});
