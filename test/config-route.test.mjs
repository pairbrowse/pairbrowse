// The browser's Settings page's routes (GET config.json, POST config; liveview.mjs over
// liveview/settings.mjs): the owner's only, three fields of config.json and nothing else, each
// validated, written through a temp file and a rename, applied to the running config at once.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, realpathSync } from "node:fs";
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
async function setup({ file = ON_DISK, native = true, inUse = "pairbrowse", timeline = null, away = () => ({}) } = {}) {
  mkdirSync(home, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(file, null, 2));
  const config = { ...DEFAULT_CONFIG, ...file };
  const state = { inUse };
  // user: the test's home folder stand-in (downloads go inside it); vouch: BRAVE is an app this
  // computer vouches for (browserProblem's own checks: their test below).
  const settings = createSettings({ config, native, browserInUse: () => state.inUse, exists, executable, user: tmpdir(), vouch: async (p) => (p === BRAVE ? "" : "not vouched for"), away });
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, settings, timeline, layoutDefaults: () => config.layout });
  view.setSession({ name: "default", where: "Local" });
  const key = view.url.split("/").at(-2);
  return { config, state, view, key, invites, onDisk: () => readFileSync(paths.config, "utf8") };
}

// The fields every answer carries besides browser, timeline, layout, native and chosen, as a
// config with none of them set reads.
const MORE = { name: "", downloads: null, pictures: true, cookies: "accept", maxTabs: 20, askSession: true, report: true, settingsSection: false, away: { on: false, server: false, ready: false, publicLink: false, privateRoute: false } }; // report: on by default (PairBrowse's own address, paths.mjs)

test("GET config.json: exactly its fourteen keys, the choice as browserChoice reads it", async () => {
  const { view, key } = await setup();
  try {
    const r = await request(view.port, "GET", `/${key}/config.json`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body).sort(), ["askSession", "away", "browser", "chosen", "cookies", "downloads", "layout", "maxTabs", "name", "native", "pictures", "report", "settingsSection", "timeline"]);
    assert.deepEqual(body, { browser: "pairbrowse", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 }, ...MORE, name: "Ann", native: true, chosen: false });
    assert.ok(!r.text.includes(TOKEN) && !r.text.includes("share.example.org"), "no other setting in the answer");
  } finally { view.close(); }
  // The same reading, without the server.
  assert.deepEqual(readSettings({}, { native: false }), { browser: "pairbrowse-open", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 }, ...MORE, report: false, native: false, chosen: false }); // a raw config with no reportUrl: no report
  assert.deepEqual(readSettings({ browserEngine: "pairbrowse", executablePath: "/x/PairBrowse.app/Contents/MacOS/pairbrowse" }, { native: true }).chosen, true, "the older names count as chosen");
  assert.equal(readSettings({ browserEngine: "chromium", executablePath: "/fake/chrome" }, { native: true }).browser, "/fake/chrome");
  assert.equal(readSettings({ browserEngine: "chromium" }, { native: true }).browser, "pairbrowse-open");
  assert.deepEqual(readSettings({ timeline: false, timelineCap: 12, layout: { left: "rail", strip: 1000 } }).timeline, { on: false, cap: 12 });
  assert.deepEqual(readSettings({ layout: { left: "rail", strip: 1000 } }).layout, { left: "open", right: "open", strip: 88 }, "an invalid layout reads as the fallback");
  assert.equal(readSettings({ timelineCap: 500 }).timeline.cap, 200);
  // settingsSection: the browser's build has its settings as the engine settings' PairBrowse
  // section (its manifest's settingsSection, 580), a boolean and nothing more.
  assert.equal(readSettings({}, { settingsSection: true }).settingsSection, true);
  assert.equal(readSettings({}, { settingsSection: "yes" }).settingsSection, true);
  assert.equal(readSettings({}).settingsSection, false);
});

test("watch and drive links get 403; the join-code port never serves the settings", async () => {
  const { view, key, invites, onDisk } = await setup();
  const before = onDisk();
  try {
    for (const role of ["watch", "drive"]) {
      const k = invites.create({ role, label: role }).key;
      assert.equal((await request(view.port, "GET", `/${k}/config.json`)).status, 403, `${role}: GET`);
      assert.equal((await request(view.port, "POST", `/${k}/config`, { body: { browser: "pairbrowse-open" } })).status, 403, `${role}: POST`);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) {
      assert.notEqual((await request(view.guestPort, "GET", `/${k}/config.json`)).status, 200);
      assert.notEqual((await request(view.guestPort, "POST", `/${k}/config`, { body: { browser: "pairbrowse-open" } })).status, 200);
    }
    assert.equal(onDisk(), before, "nothing written");
  } finally { view.close(); }
});

test("POST config merges what's given into config.json alone; the tunnel token and join hosts stay byte for byte", async () => {
  const { view, key, config, state, onDisk } = await setup();
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  try {
    let r = await request(view.port, "POST", `/${key}/config`, { body: { browser: "pairbrowse-open" } });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual(body, { browser: "pairbrowse-open", timeline: { on: true, cap: 200 }, layout: { left: "open", right: "open", strip: 88 }, ...MORE, name: "Ann", native: true, chosen: true, restart: true });
    assert.equal(onDisk(), JSON.stringify({ ...ON_DISK, browser: "pairbrowse-open" }, null, 2), "only that key changed");
    assert.ok(onDisk().includes(TOKEN));
    assert.ok(!r.text.includes(TOKEN));
    assert.equal(config.browser, "pairbrowse-open", "the running config too");
    // No restart while the chosen browser is the one running, or with no window open.
    state.inUse = "pairbrowse-open";
    r = await request(view.port, "POST", `/${key}/config`, { body: { timeline: { cap: 50 } } });
    assert.equal(JSON.parse(r.text).restart, false);
    state.inUse = null;
    r = await request(view.port, "POST", `/${key}/config`, { body: { browser: BRAVE } });
    assert.equal(r.status, 200, "an executable path of your own");
    assert.equal(JSON.parse(r.text).browser, BRAVE);
    assert.equal(JSON.parse(r.text).restart, false, "no window open: nothing to restart");
    state.inUse = "pairbrowse-open";
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
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { browser: "pairbrowse-open" } })).status, 200);
    await wait(50);
    assert.equal(eventsIn(owner.text(), "config").length, 1);
    assert.equal(eventsIn(guest.text(), "config").length, 0);
    assert.ok(!guest.text().includes("chosen"));
  } finally { guest.close(); owner.close(); view.close(); }
});

test("every invalid body is refused with 409 and writes nothing; a body that isn't JSON is 400", async () => {
  const { view, key, config, onDisk } = await setup({ native: false, file: { ...ON_DISK, browser: "pairbrowse-open" } });
  const before = onDisk();
  const running = JSON.stringify(config);
  try {
    for (const bad of [{ foo: 1 }, { chosen: true }, { native: true }, { browser: "../x" }, { browser: "chromium-ish" }, { browser: "/nowhere/chromium" }, { browser: "/opt/notes.txt" },
      { browser: "pairbrowse" }, { browser: 7 }, { browser: `/a/${"x".repeat(1100)}` }, { browser: "/a/b\nc" }, { timeline: { cap: 0 } }, { timeline: { cap: 201 } }, { timeline: { cap: 88.5 } },
      { timeline: { on: "yes" } }, { timeline: true }, { timeline: { on: true, extra: 1 } }, { layout: { strip: 20 } }, { layout: { left: "big" } }, { layout: { foo: 1 } }, { layout: [] }, [], [{ browser: "pairbrowse-open" }], null, "chromium",
      { browser: "pairbrowse-open", foo: 1 }, { timeline: { on: false }, layout: { strip: 20 } }]) {
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
  const r = await settings.write({ browser: "pairbrowse-open" });
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
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { browser: "pairbrowse-open" } })).status, 404);
  } finally { view.close(); }
});

test("the settings the helper already honors: name, downloads, pictures, cookies, maxTabs, askSession", async () => {
  const { view, key, config, onDisk } = await setup();
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  const folder = mkdtempSync(join(tmpdir(), "pb-downloads-"));
  try {
    const body = { name: "  Ann   Lee ", downloads: folder, pictures: false, cookies: "reject", maxTabs: 8, askSession: false };
    const r = await request(view.port, "POST", `/${key}/config`, { body });
    assert.equal(r.status, 200, r.text);
    const got = JSON.parse(r.text);
    assert.deepEqual({ name: got.name, downloads: got.downloads, pictures: got.pictures, cookies: got.cookies, maxTabs: got.maxTabs, askSession: got.askSession },
      { name: "Ann Lee", downloads: folder, pictures: false, cookies: "reject", maxTabs: 8, askSession: false });
    assert.deepEqual(JSON.parse(onDisk()), { ...ON_DISK, participantName: "Ann Lee", downloadsDir: folder, screenshots: false, cookieChoice: "reject", maxTabs: 8, sessionPicker: false },
      "the names the helper reads, merged into the file");
    // The running config: what serve.mjs (screenshots), popups (cookieChoice), context.mjs
    // (maxTabs, downloadsDir) and follow.mjs (participantName) read at each use.
    assert.equal(config.screenshots, false);
    assert.equal(config.cookieChoice, "reject");
    assert.equal(config.maxTabs, 8);
    assert.equal(config.downloadsDir, folder);
    assert.equal(config.participantName, "Ann Lee");
    assert.equal(config.sessionPicker, false);
    // Back to the defaults: "" for no name, null for the Downloads folder.
    const back = JSON.parse((await request(view.port, "POST", `/${key}/config`, { body: { name: "", downloads: null } })).text);
    assert.equal(back.name, "");
    assert.equal(back.downloads, null);
    assert.equal(JSON.parse(onDisk()).participantName, null);
    assert.equal(JSON.parse(onDisk()).downloadsDir, null);
    await wait(50);
    const seen = eventsIn(owner.text(), "config");
    assert.equal(seen.length, 2, "a config event per change, for open pages");
    assert.equal(seen[0].cookies, "reject");
  } finally { owner.close(); view.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("the new settings refuse every bad value and write nothing", async () => {
  const { view, key, config, onDisk } = await setup();
  const before = onDisk();
  const running = JSON.stringify(config);
  const file = join(tmpdir(), `pb-not-a-folder-${process.pid}`);
  writeFileSync(file, "x");
  mkdirSync(join(home, "inside"), { recursive: true });
  try {
    for (const bad of [{ name: "x".repeat(41) }, { name: "<b>Ann</b>" }, { name: "Ann\u0007" }, { name: 7 }, { name: null },
      { downloads: "relative/folder" }, { downloads: "/nowhere/at/all" }, { downloads: file }, { downloads: home }, { downloads: join(home, "inside") }, { downloads: 5 }, { downloads: "/a\nb" },
      { pictures: "no" }, { pictures: 0 }, { cookies: "maybe" }, { cookies: true }, { maxTabs: 1 }, { maxTabs: 51 }, { maxTabs: 2.5 }, { maxTabs: "8" },
      { askSession: "yes" }, { askSession: null }, { report: true }, { reportUrl: "https://x.example/r" }, { name: "Ann", maxTabs: 1 }]) {
      const r = await request(view.port, "POST", `/${key}/config`, { body: bad });
      assert.equal(r.status, 409, JSON.stringify(bad));
      assert.ok(JSON.parse(r.text).error, JSON.stringify(bad));
    }
    assert.match(JSON.parse((await request(view.port, "POST", `/${key}/config`, { body: { downloads: join(home, "inside") } })).text).error, /PairBrowse's own folder/);
    assert.match(JSON.parse((await request(view.port, "POST", `/${key}/config`, { body: { report: true } })).text).error, /Unknown setting "report"/, "report is read only");
    assert.equal(onDisk(), before, "nothing written");
    assert.equal(JSON.stringify(config), running, "nothing applied");
  } finally { view.close(); rmSync(file, { force: true }); }
});

test("report: true only for a valid https reportUrl; the address is never in an answer", async () => {
  const cases = [["https://reports.example.org/v1/report", true], ["http://reports.example.org/r", false], ["https://user:pw@reports.example.org/r", false],
    ["https://reports.example.org/r?token=abc", false], ["https://reports.example.org/r#x", false], ["reports.example.org", false], [42, false], [null, false]];
  for (const [reportUrl, on] of cases) {
    const { view, key } = await setup({ file: { ...ON_DISK, reportUrl } });
    try {
      const r = await request(view.port, "GET", `/${key}/config.json`);
      assert.equal(JSON.parse(r.text).report, on, String(reportUrl));
      assert.ok(!r.text.includes("reports.example.org"), "never the address");
    } finally { view.close(); }
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));

test("downloads go only to an ordinary folder inside your home folder", async () => {
  const { downloadsProblem } = await import("../scripts/liveview/settings.mjs");
  const user = realpathSync(mkdtempSync(join(tmpdir(), "pb-user-")));
  const at = (...p) => join(user, ...p);
  assert.equal(downloadsProblem(at("Downloads"), user), "");
  assert.equal(downloadsProblem(at("Work", "Reports"), user), "");
  for (const [p, why] of [[user, /home folder itself|straight into your home/], [at("Library", "LaunchAgents"), /Library/], [at("library", "x"), /library/i], [at("AppData", "Roaming"), /AppData/],
    [at(".ssh"), /hidden/], [at("Work", ".git", "hooks"), /hidden/], [at(".config", "autostart"), /hidden/], ["/etc", /inside your home/], [join(user, "..", "other"), /inside your home/]]) {
    assert.match(downloadsProblem(p, user), why, p);
  }
});

test("a browser of your own: an app macOS vouches for; elsewhere a file only you or root can change", async () => {
  const { browserProblem } = await import("../scripts/liveview/settings.mjs");
  const ok = async () => true, no = async () => false;
  assert.equal(await browserProblem("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", { platform: "darwin", verify: ok }), "");
  assert.match(await browserProblem("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", { platform: "darwin", verify: no }), /signature doesn't verify/);
  assert.match(await browserProblem("/Users/me/Downloads/chrome", { platform: "darwin", verify: ok }), /isn't an app's program/);
  assert.match(await browserProblem("/x.app/Contents/Resources/run", { platform: "darwin", verify: ok }), /isn't an app's program/);
  const stat = (modes) => (p) => ({ mode: modes[p] ?? 0o755, uid: 0 });
  assert.equal(await browserProblem("/opt/brave/brave", { platform: "linux", stat: stat({}), uid: 1000 }), "");
  assert.match(await browserProblem("/tmp/x/brave", { platform: "linux", stat: stat({ "/tmp/x": 0o777 }), uid: 1000 }), /other accounts/);
  assert.match(await browserProblem("/opt/brave/brave", { platform: "linux", stat: stat({ "/opt/brave/brave": 0o757 }), uid: 1000 }), /other accounts/);
  assert.match(await browserProblem("/home/eve/brave", { platform: "linux", stat: () => ({ mode: 0o755, uid: 1001 }), uid: 1000 }), /another account/);
});

// The Away switch (spec server-mode decision 8): handoff.away, off by default, remembered in
// config.json (only that key of handoff changes), on only with a ready channel, and on a server
// always on (no switch).
test("away: on only with a ready channel, written into config.json's handoff alone; refused on a server", async () => {
  const handoff = { enabled: true, grantMinutes: 20, channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC" }] };
  const now = { server: false, enabled: true, channels: 0 };
  const { view, key, config, onDisk } = await setup({ file: { ...ON_DISK, handoff }, away: () => now });
  config.handoff = { ...DEFAULT_CONFIG.handoff, ...handoff, remindMinutes: 10 }; // as loadConfig fills it in
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  try {
    const get = async () => JSON.parse((await request(view.port, "GET", `/${key}/config.json`)).text).away;
    assert.deepEqual(await get(), { on: false, server: false, ready: false, publicLink: false, privateRoute: false });
    // No channel that can be used: refused, nothing written.
    const before = onDisk();
    let r = await request(view.port, "POST", `/${key}/config`, { body: { away: true } });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /hand-off channel first/);
    assert.equal(onDisk(), before);
    now.enabled = false; now.channels = 1;
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { away: true } })).status, 409, "a channel but hand-offs not enabled");
    // Ready: on, remembered in the file's handoff (its own fields kept as written, no filled-in defaults).
    now.enabled = true;
    assert.deepEqual(await get(), { on: false, server: false, ready: true, publicLink: false, privateRoute: false });
    r = await request(view.port, "POST", `/${key}/config`, { body: { away: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).away, { on: true, server: false, ready: true, publicLink: false, privateRoute: false });
    assert.deepEqual(JSON.parse(onDisk()).handoff, { ...handoff, away: true });
    assert.ok(onDisk().includes(TOKEN), "the rest of config.json as it was");
    assert.equal(config.handoff.away, true, "the running config too");
    assert.equal(config.handoff.remindMinutes, 10, "with its other fields as loaded");
    await wait(50);
    assert.ok(eventsIn(owner.text(), "config").some((c) => c.away?.on === true), "the owner's pages hear it");
    // Off again: always allowed.
    r = await request(view.port, "POST", `/${key}/config`, { body: { away: false } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(onDisk()).handoff.away, false);
    assert.equal(config.handoff.away, false);
    // Not a boolean.
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { away: "yes" } })).status, 409);
    // On a server: hand-offs always go to the channels; the switch can't change that.
    now.server = true;
    assert.deepEqual(await get(), { on: false, server: true, ready: true, publicLink: false, privateRoute: false });
    r = await request(view.port, "POST", `/${key}/config`, { body: { away: true } });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /runs on a server/);
  } finally { owner.close(); view.close(); }
  // Without the helper's state the switch reads off and not ready.
  assert.deepEqual(readSettings({}).away, { on: false, server: false, ready: false, publicLink: false, privateRoute: false });
  assert.deepEqual(applySettings({ away: true }, {}, {}).error ? "refused" : "taken", "refused");
});

// The public hand-off link (spec server-mode step 21b, handoff.publicLink): off by default, the
// Away switch offers it while no private route is set, written into config.json's handoff alone
// (away kept as it is), on a server too.
test("publicLink: off by default, written into config.json's handoff alone, on a server too; privateRoute says whether a tailnet link exists", async () => {
  const handoff = { enabled: true, away: true, channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC" }] };
  const now = { server: false, enabled: true, channels: 1, privateRoute: false };
  const { view, key, config, onDisk } = await setup({ file: { ...ON_DISK, handoff }, away: () => now });
  config.handoff = { ...DEFAULT_CONFIG.handoff, ...handoff };
  try {
    const get = async () => JSON.parse((await request(view.port, "GET", `/${key}/config.json`)).text).away;
    assert.deepEqual(await get(), { on: true, server: false, ready: true, publicLink: false, privateRoute: false });
    let r = await request(view.port, "POST", `/${key}/config`, { body: { publicLink: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).away.publicLink, true);
    assert.deepEqual(JSON.parse(onDisk()).handoff, { ...handoff, publicLink: true }, "only publicLink added; away as it was");
    assert.ok(onDisk().includes(TOKEN), "the rest of config.json as it was");
    assert.equal(config.handoff.publicLink, true, "the running config too");
    assert.equal(config.handoff.away, true);
    assert.equal((await request(view.port, "POST", `/${key}/config`, { body: { publicLink: "on" } })).status, 409, "not a boolean");
    now.privateRoute = true;
    assert.equal((await get()).privateRoute, true);
    // On a server: the same opt-in, and off again.
    now.server = true;
    r = await request(view.port, "POST", `/${key}/config`, { body: { publicLink: false } });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(onDisk()).handoff.publicLink, false);
    assert.equal(config.handoff.publicLink, false);
  } finally { view.close(); }
  assert.equal(readSettings({}).away.publicLink, false);
});
