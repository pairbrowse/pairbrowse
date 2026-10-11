// The browser's Settings page's routes (GET config.json, POST config; liveview.mjs over
// liveview/settings.mjs): the owner's only, three fields of config.json and nothing else, each
// validated, written through a temp file and a rename, applied to the running config at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-config-route-"));
process.env.PAIRBROWSE_HOME = home;
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");
const { createSettings, readSettings, applySettings } = await import("../scripts/liveview/settings.mjs");
const { createTimeline } = await import("../scripts/daemon/timeline.mjs");
const { DEFAULT_CONFIG, paths } = await import("../scripts/paths.mjs");

const TOKEN = "eyJhIjoiY2xvdWRmbGFyZS10dW5uZWwtdG9rZW4tc2VjcmV0LXZhbHVlIn0";
const ON_DISK = { sharing: { tunnel: { kind: "cloudflare", token: TOKEN, hostname: "pb.example.org" }, guestPort: 0 }, joinHosts: ["share.example.org"], participantName: "Ann" };
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
// Stand-in file checks: BRAVE is an executable file, /opt/notes.txt a file that isn't.
const exists = (p) => p === BRAVE || p === "/opt/notes.txt";
const executable = (p) => p === BRAVE;

function request(port, method, path, { body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (raw !== undefined) req.write(raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
function readStream(port, path) {
  return new Promise((resolve) => {
    let text = "";
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); resolve({ text: () => text, close: () => req.destroy() }); });
    req.on("error", () => {});
  });
}
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A helper's worth of the route: config.json on disk with a tunnel token and join hosts, the
// running config read from it, the settings dep as daemon.mjs builds it.
async function setup({ file = ON_DISK, native = true, inUse = "pairbrowse", timeline = null } = {}) {
  mkdirSync(home, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(file, null, 2));
  const config = { ...DEFAULT_CONFIG, ...file };
  const state = { inUse };
  const settings = createSettings({ config, native, browserInUse: () => state.inUse, exists, executable });
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, settings, timeline, layoutDefaults: () => config.layout });
  view.setSession({ name: "default", where: "Local" });
  const key = view.url.split("/").at(-2);
  return { config, state, view, key, invites, onDisk: () => readFileSync(paths.config, "utf8") };
}

test("GET config.json: exactly the five keys, the choice as browserChoice reads it", async () => {
  const { view, key } = await setup();
  try {
    const r = await request(view.port, "GET", `/${key}/config.json`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body).sort(), ["browser", "chosen", "layout", "native", "timeline"]);
    assert.deepEqual(body, { browser: "pairbrowse", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 }, native: true, chosen: false });
    assert.ok(!r.text.includes(TOKEN) && !r.text.includes("share.example.org") && !r.text.includes("Ann"), "no other setting in the answer");
  } finally { view.close(); }
  // The same reading, without the server.
  assert.deepEqual(readSettings({}, { native: false }), { browser: "chromium", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 }, native: false, chosen: false });
  assert.deepEqual(readSettings({ browserEngine: "pairbrowse", executablePath: "/x/PairBrowse.app/Contents/MacOS/pairbrowse" }, { native: true }).chosen, true, "the older names count as chosen");
  assert.equal(readSettings({ browserEngine: "chromium", executablePath: "/fake/chrome" }, { native: true }).browser, "/fake/chrome");
  assert.equal(readSettings({ browserEngine: "chromium" }, { native: true }).browser, "chromium");
  assert.deepEqual(readSettings({ timeline: false, timelineCap: 12, layout: { left: "rail", strip: 1000 } }).timeline, { on: false, cap: 12 });
  assert.deepEqual(readSettings({ layout: { left: "rail", strip: 1000 } }).layout, { left: "open", right: "open", strip: 88 }, "an invalid layout reads as the fallback");
  assert.equal(readSettings({ timelineCap: 500 }).timeline.cap, 200);
});

test("watch and drive links get 403; the join-code port never serves the settings", async () => {
  const { view, key, invites, onDisk } = await setup();
  const before = onDisk();
  try {
    for (const role of ["watch", "drive"]) {
      const k = invites.create({ role, label: role }).key;
      assert.equal((await request(view.port, "GET", `/${k}/config.json`)).status, 403, `${role}: GET`);
      assert.equal((await request(view.port, "POST", `/${k}/config`, { body: { browser: "chromium" } })).status, 403, `${role}: POST`);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) {
      assert.notEqual((await request(view.guestPort, "GET", `/${k}/config.json`)).status, 200);
      assert.notEqual((await request(view.guestPort, "POST", `/${k}/config`, { body: { browser: "chromium" } })).status, 200);
    }
    assert.equal(onDisk(), before, "nothing written");
  } finally { view.close(); }
});

test("POST config merges what's given into config.json alone; the tunnel token and join hosts stay byte for byte", async () => {
  const { view, key, config, state, onDisk } = await setup();
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  try {
    let r = await request(view.port, "POST", `/${key}/config`, { body: { browser: "chromium" } });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual(body, { browser: "chromium", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 }, native: true, chosen: true, restart: true });
    assert.equal(onDisk(), JSON.stringify({ ...ON_DISK, browser: "chromium" }, null, 2), "only that key changed");
    assert.ok(onDisk().includes(TOKEN));
    assert.ok(!r.text.includes(TOKEN));
    assert.equal(config.browser, "chromium", "the running config too");
    // No restart while the chosen browser is the one running, or with no window open.
    state.inUse = "chromium";
    r = await request(view.port, "POST", `/${key}/config`, { body: { timeline: { cap: 50 } } });
    assert.equal(JSON.parse(r.text).restart, false);
    state.inUse = null;
    r = await request(view.port, "POST", `/${key}/config`, { body: { browser: BRAVE } });
    assert.equal(r.status, 200, "an executable path of your own");
    assert.equal(JSON.parse(r.text).browser, BRAVE);
    assert.equal(JSON.parse(r.text).restart, false, "no window open: nothing to restart");
    state.inUse = "chromium";
    assert.equal(JSON.parse((await request(view.port, "GET", `/${key}/config.json`)).text).browser, BRAVE);
    r = await request(view.port, "POST", `/${key}/config`, { body: { layout: { left: "rail" }, timeline: { on: false } } });
    assert.equal(JSON.parse(r.text).restart, true, "still another browser than the one running");
    assert.deepEqual(JSON.parse(onDisk()), { ...ON_DISK, browser: BRAVE, timelineCap: 50, timeline: false, layout: { left: "rail", right: "open", strip: 88 } });
    assert.ok(!existsSync(`${paths.config}.tmp`), "the temp file was renamed into place");
    await wait(50);
    const seen = eventsIn(owner.text(), "config");
    assert.equal(seen.length, 4, "one config event per successful POST");
    assert.equal(seen.at(-1).browser, BRAVE);
    assert.ok(!owner.text().includes(TOKEN));
  } finally { owner.close(); view.close(); }
});

test("a guest's stream never gets the config event", async () => {
  const { view, key, invites } = await setup();
  const guest = await readStream(view.port, `/${invites.create({ role: "drive", label: "D" }).key}/events?panel=1`);
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  try {
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { browser: "chromium" } })).status, 200);
    await wait(50);
    assert.equal(eventsIn(owner.text(), "config").length, 1);
    assert.equal(eventsIn(guest.text(), "config").length, 0);
    assert.ok(!guest.text().includes("chosen"));
  } finally { guest.close(); owner.close(); view.close(); }
});

test("every invalid body is refused with 409 and writes nothing; a body that isn't JSON is 400", async () => {
  const { view, key, config, onDisk } = await setup({ native: false, file: { ...ON_DISK, browser: "chromium" } });
  const before = onDisk();
  const running = JSON.stringify(config);
  try {
    for (const bad of [{ foo: 1 }, { chosen: true }, { native: true }, { browser: "../x" }, { browser: "chromium-ish" }, { browser: "/nowhere/chromium" }, { browser: "/opt/notes.txt" },
      { browser: "pairbrowse" }, { browser: 7 }, { browser: `/a/${"x".repeat(1100)}` }, { browser: "/a/b\nc" }, { timeline: { cap: 0 } }, { timeline: { cap: 201 } }, { timeline: { cap: 88.5 } },
      { timeline: { on: "yes" } }, { timeline: true }, { timeline: { on: true, extra: 1 } }, { layout: { strip: 20 } }, { layout: { left: "big" } }, { layout: { foo: 1 } }, { layout: [] }, [], [{ browser: "chromium" }], null, "chromium",
      { browser: "chromium", foo: 1 }, { timeline: { on: false }, layout: { strip: 20 } }]) {
      const r = await request(view.port, "POST", `/${key}/config`, { body: bad });
      assert.equal(r.status, 409, JSON.stringify(bad).slice(0, 80));
      assert.ok(JSON.parse(r.text).error, JSON.stringify(bad).slice(0, 80));
    }
    const noBuild = await request(view.port, "POST", `/${key}/config`, { body: { browser: "pairbrowse" } });
    assert.match(JSON.parse(noBuild.text).error, /no PairBrowse browser build for this computer/);
    assert.match(JSON.parse((await request(view.port, "POST", `/${key}/config`, { body: { foo: 1 } })).text).error, /Unknown setting "foo"/);
    assert.match(JSON.parse((await request(view.port, "POST", `/${key}/config`, { body: { browser: "/nowhere/chromium" } })).text).error, /isn't an executable file/);
    const nj = await request(view.port, "POST", `/${key}/config`, { raw: "{" });
    assert.equal(nj.status, 400);
    assert.ok(JSON.parse(nj.text).error);
    assert.equal(onDisk(), before, "nothing written");
    assert.equal(JSON.stringify(config), running, "nothing applied");
  } finally { view.close(); }
  // The same checks, without the server: only the keys given come back.
  assert.deepEqual(applySettings({ timeline: { cap: 5 } }, {}, { native: true }), { fields: { timelineCap: 5 } });
  assert.deepEqual(applySettings({ layout: { strip: 120 } }, { layout: { left: "rail" } }, { native: true }), { fields: { layout: { left: "rail", right: "open", strip: 120 } } });
  assert.deepEqual(applySettings({}, {}, {}), { fields: {} });
});

test("a config.json that can't be written: an error, nothing applied", async () => {
  const config = { ...DEFAULT_CONFIG };
  const settings = createSettings({ config, native: true, save: () => { throw new Error("disk full"); } });
  const r = settings.write({ browser: "chromium" });
  assert.match(r.error, /Couldn't write config\.json: disk full/);
  assert.equal(config.browser, null);
});

test("timeline on/off and cap take effect at once, without a restart", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pb-config-tl-")), "timeline");
  const live = { config: null };
  const store = createTimeline({ dir: () => dir, enabled: () => live.config.timeline !== false, cap: () => live.config.timelineCap });
  const { view, key, config } = await setup({ timeline: store });
  live.config = config;
  try {
    const jpeg = (n) => Buffer.from([0xff, 0xd8, 0xff, n]).toString("base64");
    for (let i = 0; i < 8; i++) await store.record({ data: jpeg(i), caption: `c${i}` });
    assert.equal(JSON.parse((await request(view.port, "GET", `/${key}/timeline.json`)).text).cards.length, 8);
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { timeline: { on: false } } })).status, 200);
    assert.equal(store.enabled, false, "off at once");
    const off = await request(view.port, "GET", `/${key}/timeline.json`);
    assert.equal(off.status, 404);
    assert.match(off.text, /timeline: false/);
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { timeline: { on: true, cap: 5 } } })).status, 200);
    assert.equal(store.enabled, true);
    await store.record({ data: jpeg(9), caption: "next" });
    const cards = JSON.parse((await request(view.port, "GET", `/${key}/timeline.json`)).text).cards;
    assert.equal(cards.length, 5, "trimmed to the new cap at the next picture");
    assert.equal(cards.at(-1).caption, "next");
  } finally { view.close(); }
});

test("no settings dep: both routes answer 404", async () => {
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank" });
  const key = view.url.split("/").at(-2);
  try {
    assert.equal((await request(view.port, "GET", `/${key}/config.json`)).status, 404);
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { browser: "chromium" } })).status, 404);
  } finally { view.close(); }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
