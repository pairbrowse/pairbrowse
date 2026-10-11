// The session card's routes (POST session: rename and save) over the live view, and the helper's
// own rename and save of the open session (scripts/daemon/context.mjs renameCurrent, saveTabs)
// with a fake browser in a throwaway home.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const home = mkdtempSync(join(tmpdir(), "pb-sr-"));
process.env.PAIRBROWSE_HOME = home;
writeFileSync(join(home, "config.json"), "{}");
mkdirSync(join(home, "run"), { recursive: true });
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");
const sessions = await import("../scripts/sessions.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(port, method, path, { body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
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

test("POST session: the owner renames and saves through the helper; refusals pass through; nobody else", async () => {
  const invites = createInvites();
  const calls = [];
  let state = { canRename: true, canSave: true, savedAt: "" };
  let recording = false;
  let pending = [];
  const sessionOps = {
    state: () => state,
    rename: async (name) => { calls.push(["rename", name]); return name === "taken" ? { error: "Session \"taken\" already exists; choose another name." } : { ok: true, name, from: "client-x", restarting: true }; },
    save: async () => { calls.push(["save"]); return { ok: true, savedAt: "2026-10-11T10:00:00.000Z" }; },
  };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, sessionOps,
    recordState: () => ({ recording }), clickApprovals: { pending: () => pending, onChange: () => () => {} }, layoutDefaults: { left: "open", right: "open", strip: 88 } });
  const key = view.url.split("/").at(-2);
  view.setSession({ name: "client-x", where: "Local" });
  const owner = await readStream(view.port, `/${key}/events?page=left`);
  try {
    // The session card's fields ride on the owner's session event only.
    await sleep(50);
    assert.deepEqual(eventsIn(owner.text(), "session")[0], { name: "client-x", where: "Local", canRename: true, canSave: true, savedAt: "" });
    // The layout of the session moves with its name.
    await request(view.port, "POST", `/${key}/layout`, { body: { left: "rail" } });
    let r = await request(view.port, "POST", `/${key}/session`, { body: { op: "save" } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, savedAt: "2026-10-11T10:00:00.000Z" }]);
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "  client-y " } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, name: "client-y", restarting: true }]);
    assert.deepEqual(calls.at(-1), ["rename", "client-y"], "the name trimmed");
    view.setSession({ name: "client-y", where: "Local" });
    assert.deepEqual(view.layout(), { left: "rail", right: "open", strip: 88 }, "the renamed session keeps its layout");
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "taken" } });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "Session \"taken\" already exists; choose another name."]);
    r = await request(view.port, "POST", `/${key}/session`, { raw: "{" });
    assert.equal(r.status, 400);
    for (const bad of [{ op: "delete" }, [], "save", null, {}]) {
      r = await request(view.port, "POST", `/${key}/session`, { body: bad });
      assert.equal(r.status, 409, JSON.stringify(bad));
      assert.match(JSON.parse(r.text).error, /op: "rename", name/);
    }
    // Refused before the helper is asked: someone in the session, a recording, an approval.
    const n = calls.length;
    recording = true;
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "z1" } });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "Stop the recording first."]);
    recording = false;
    pending = [{ id: "x" }];
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "z2" } });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "An approval is waiting; answer it first."]);
    pending = [];
    const w = invites.create({ role: "watch", label: "W" });
    const guest = await readStream(view.port, `/${w.key}/events?panel=1`);
    await sleep(50);
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "z3" } });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "People are in this session; rename it once they have left."]);
    assert.equal(calls.length, n, "none of these reached the helper");
    // A guest's stream has the session without the owner's fields, before and after a change.
    state = { canRename: false, canSave: true, savedAt: "2026-10-11T10:00:00.000Z" };
    view.setSession({ name: "client-y", where: "Local" });
    await sleep(50);
    for (const e of eventsIn(guest.text(), "session")) assert.deepEqual(Object.keys(e).sort(), ["name", "where"]);
    assert.deepEqual(eventsIn(owner.text(), "session").at(-1), { name: "client-y", where: "Local", canRename: false, canSave: true, savedAt: "2026-10-11T10:00:00.000Z" });
    guest.close();
    // Nobody but the owner, never on the join-code port.
    for (const k of [w.key, invites.create({ role: "drive", label: "D" }).key]) {
      assert.equal((await request(view.port, "POST", `/${k}/session`, { body: { op: "save" } })).status, 403);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) assert.notEqual((await request(view.guestPort, "POST", `/${k}/session`, { body: { op: "save" } })).status, 200);
    // A state() that throws: the plain session, never a broken stream.
    state = null;
    sessionOps.state = () => { throw new Error("boom"); };
    view.setSession({ name: "client-y", where: "Local" });
    await sleep(30);
    assert.deepEqual(eventsIn(owner.text(), "session").at(-1), { name: "client-y", where: "Local" });
  } finally { owner.close(); view.close(); }
  const bare = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank" });
  try { assert.equal((await request(bare.port, "POST", `/${bare.url.split("/").at(-2)}/session`, { body: { op: "save" } })).status, 404, "no sessionOps given"); } finally { bare.close(); }
});

// ---- the helper's own rename and save, with a fake browser ----
const launched = [];
let slowGoto = 0;
function fakeContext(profile) {
  const ctx = new EventEmitter();
  ctx.profile = profile;
  ctx.pages = () => [];
  ctx.addInitScript = async () => {};
  const page = () => ({ on() {}, once() {}, url: () => "about:blank", isClosed: () => false, goto: async () => { if (slowGoto) await sleep(slowGoto); }, close: async () => {}, setContent: async () => {}, bringToFront: async () => {}, evaluate: async () => null, context: () => ctx });
  ctx.newPage = async () => page();
  ctx.browser = () => null;
  ctx.close = async () => { ctx.emit("close"); await sleep(50); };
  return ctx;
}
const chromium = { launchPersistentContext: async (profile) => { await sleep(20); const c = fakeContext(profile); launched.push(c); return c; } };
const quiet = () => {};
async function makeContext({ notes = [], order = [], picker = false, told = [], inTheWay = () => {} } = {}) {
  const { createContext } = await import("../scripts/daemon/context.mjs");
  return createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", sessionPicker: picker, display: "none" }, log: quiet, chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: (t) => notes.push(t), onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet, notify: (t) => told.push(t),
    beforeRename: async () => { await sleep(30); order.push(["before", existsSync(sessions.profileDir("client-x"))]); inTheWay(); },
    onRenamed: (from, to) => order.push(["renamed", from, to]),
  });
}
const until = async (ok, ms = 5000) => { for (let t = Date.now(); Date.now() - t < ms; await sleep(20)) if (ok()) return true; return false; };

test("rename: the browser closes, the session's files move, the same session reopens on the new name", { timeout: 30_000 }, async () => {
  sessions.createSession("client-x");
  writeFileSync(sessions.tabsFile("client-x"), JSON.stringify({ tabs: [] }));
  writeFileSync(sessions.peopleFile("client-x"), JSON.stringify({ people: [] }));
  mkdirSync(sessions.timelineDir("client-x"), { recursive: true });
  writeFileSync(join(sessions.timelineDir("client-x"), "index.json"), "{\"cards\":[]}");
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "runs", "a-run.json"), JSON.stringify({ name: "a run", session: "client-x" }));
  sessions.createSession("taken-z");
  const notes = [], order = [], told = [];
  let inTheWay = () => {};
  const context = await makeContext({ notes, order, told, inTheWay: () => inTheWay() });
  assert.deepEqual(context.renameCurrent("client-y"), { error: "The browser isn't open; open it first, then rename its session." });
  await context.getContext();
  assert.deepEqual(context.renameCurrent("client-y"), { error: "The default session keeps its name; start a named session to name it." });
  const r0 = await context.sessionCommand({ action: "use", name: "client-x" });
  assert.ok(!r0.error, r0.text);
  const before = launched.length;
  for (const [name, why] of [["../x", /letters, numbers/], ["a b", /letters, numbers/], ["clean-5", /keeps for itself/], ["default", /keeps for itself/], ["taken-z", /already exists/], ["TAKEN-Z", /already exists/]]) {
    assert.match(context.renameCurrent(name).error || "", why, name);
  }
  assert.deepEqual(context.renameCurrent("client-x"), { ok: true, name: "client-x", from: "client-x", restarting: false }, "the same name: nothing to do");
  const r = context.renameCurrent("client-y");
  assert.deepEqual(r, { ok: true, name: "client-y", from: "client-x", restarting: true }, "answered at once");
  assert.equal(launched.length, before, "nothing restarted yet");
  assert.ok(await until(() => launched.length === before + 1 && context.sessionName() === "client-y" && !context.isSwitching()));
  await context.getContext();
  assert.equal(launched.length, before + 1, "exactly one new browser");
  assert.equal(launched.at(-1).profile, sessions.profileDir("client-y"));
  for (const of of [sessions.profileDir, sessions.tabsFile, sessions.peopleFile, sessions.timelineDir]) {
    assert.equal(existsSync(of("client-x")), false, `${of.name}: old gone`);
    assert.equal(existsSync(of("client-y")), true, `${of.name}: new there`);
  }
  assert.equal(sessions.currentSession(), "client-y");
  assert.equal(readFileSync(join(home, "session"), "utf8").trim(), "client-y");
  assert.equal(JSON.parse(readFileSync(join(home, "runs", "a-run.json"), "utf8")).session, "client-y", "its runs follow");
  assert.deepEqual(order, [["before", true], ["renamed", "client-x", "client-y"]], "the timeline settled before the move");
  assert.match(notes.at(-1), /renamed this browser session "client-x" to "client-y".*pairbrowse_session use client-y/);
  // Save: the tabs file is written now; a clean session has nothing to save.
  writeFileSync(sessions.tabsFile("client-y"), "{}");
  assert.deepEqual(await context.saveTabs(), { ok: true });
  assert.ok(JSON.parse(readFileSync(sessions.tabsFile("client-y"), "utf8")).savedAt, "a fresh savedAt");
  // Something of that name on disk the session list doesn't show (a stray file where its profile
  // would go, an orphan tabs, people or timeline file): refused at once, nothing restarts.
  const stray = launched.length;
  writeFileSync(join(home, "sessions", "client-q"), "a file in the way");
  assert.deepEqual(context.renameCurrent("client-q"), { error: "Session \"client-q\" already exists; choose another name." });
  rmSync(join(home, "sessions", "client-q"));
  for (const of of [sessions.tabsFile, sessions.peopleFile]) {
    writeFileSync(of("client-q"), "{}");
    assert.match(context.renameCurrent("client-q").error || "", /already exists/, `an orphan ${of.name}`);
    rmSync(of("client-q"));
  }
  mkdirSync(sessions.timelineDir("client-q"), { recursive: true });
  assert.match(context.renameCurrent("client-q").error || "", /already exists/, "an orphan timeline");
  rmSync(sessions.timelineDir("client-q"), { recursive: true });
  assert.equal(launched.length, stray, "nothing restarted");
  // A move that fails (the file shows up after the check): the old session stays and reopens,
  // and the person hears it as well as the agent.
  inTheWay = () => writeFileSync(join(home, "sessions", "client-q"), "a file in the way");
  const n = launched.length;
  assert.equal(context.renameCurrent("client-q").ok, true);
  assert.ok(await until(() => launched.length === n + 1 && !context.isSwitching()));
  assert.equal(context.sessionName(), "client-y");
  assert.equal(launched.at(-1).profile, sessions.profileDir("client-y"));
  assert.ok(existsSync(sessions.profileDir("client-y")));
  assert.match(notes.at(-1), /didn't work.*reopened on "client-y"/);
  assert.match(told.at(-1), /didn't work; it reopened as "client-y"/);
  inTheWay = () => {};
  // A clean session: neither rename nor save.
  await context.sessionCommand({ action: "new" });
  assert.match(context.renameCurrent("x9").error, /clean session/);
  assert.match((await context.saveTabs()).error, /clean session/);
});

test("rename and save wait for tabs reopening; rename waits for the picker", { timeout: 30_000 }, async () => {
  sessions.createSession("pick-p");
  writeFileSync(sessions.tabsFile("pick-p"), JSON.stringify({ tabs: [{ url: "https://a.test/" }, { url: "https://b.test/" }] }));
  writeFileSync(join(home, "session"), "pick-p");
  slowGoto = 400;
  const context = await makeContext();
  await context.getContext();
  assert.ok(context.isRestoring(), "its tabs are reopening");
  assert.match(context.renameCurrent("pick-q").error, /reopening/);
  assert.match((await context.saveTabs()).error, /reopening/);
  assert.ok(await until(() => !context.isRestoring(), 10_000));
  slowGoto = 0;
  const picking = await makeContext({ picker: true });
  await picking.getContext();
  assert.ok(picking.picking(), "the picker shows");
  assert.match(picking.renameCurrent("pick-q").error, /picker/);
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
