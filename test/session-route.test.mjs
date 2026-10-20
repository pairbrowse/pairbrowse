// The session card's routes (POST session: rename and save) over the live view, and the helper's
// own rename and save of the open session (scripts/daemon/context.mjs renameCurrent, saveTabs)
// with a fake browser in a throwaway home.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { sleep } from "./helpers/util.mjs";

const home = mkdtempSync(join(tmpdir(), "pb-sr-"));
process.env.PAIRBROWSE_HOME = home;
writeFileSync(join(home, "config.json"), "{}");
mkdirSync(join(home, "run"), { recursive: true });
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");
const sessions = await import("../scripts/sessions.mjs");

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

test("POST session rename with from: a saved session that isn't open, renamed without the open session's checks", async () => {
  const invites = createInvites();
  const calls = [];
  let listed = [{ name: "work" }, { name: "old-s" }];
  const sessionOps = {
    state: () => ({ canRename: true, canSave: true, savedAt: "", canRenameSaved: true }),
    current: () => "work",
    rename: async (name, from) => {
      calls.push(from === undefined ? ["rename", name] : ["rename", name, from]);
      if (from === "busy-s") return { error: "Session \"busy-s\" is open in another browser; close it there, then rename it." };
      if (from !== undefined) listed = listed.map((s) => (s.name === from ? { name } : s));
      return { ok: true, name, from: from ?? "work", restarting: from === undefined };
    },
    save: async () => ({ ok: true }),
  };
  const picker = { state: () => ({ picking: false, sessions: listed }), pick: async () => ({ text: "x" }) };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, sessionOps, picker,
    recordState: () => ({ recording: true }), clickApprovals: { pending: () => [{ id: "x" }], onChange: () => () => {} }, layoutDefaults: { left: "open", right: "open", strip: 88 } });
  const key = view.url.split("/").at(-2);
  view.setSession({ name: "work", where: "Local" });
  const owner = await readStream(view.port, `/${key}/events?page=left`);
  try {
    // The owner's session event says this helper renames saved sessions (the page offers Rename on them).
    await sleep(50);
    assert.equal(eventsIn(owner.text(), "session")[0]?.canRenameSaved, true);
    // A recording and a waiting approval hold up the open session's rename, not a saved one's.
    let r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "new-s", from: " old-s " } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, name: "new-s", restarting: false }]);
    assert.deepEqual(calls.at(-1), ["rename", "new-s", "old-s"], "from trimmed");
    await sleep(50);
    assert.deepEqual(eventsIn(owner.text(), "sessions").at(-1)?.sessions.map((s) => s.name), ["work", "new-s"], "the open pages hear the new list");
    // from naming the open session: today's rename, with its checks.
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "work-2", from: "work" } });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "Stop the recording first."]);
    // The helper's refusal passes through.
    r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "z", from: "busy-s" } });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "Session \"busy-s\" is open in another browser; close it there, then rename it."]);
    // A from that isn't a name: refused before the helper is asked.
    const n = calls.length;
    for (const bad of [5, "", "   ", null, "x".repeat(41), ["a"]]) {
      r = await request(view.port, "POST", `/${key}/session`, { body: { op: "rename", name: "q", from: bad } });
      assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "from is a saved session's name."], JSON.stringify(bad));
    }
    assert.equal(calls.length, n);
    // Only the owner.
    const w = invites.create({ role: "drive", label: "D" });
    assert.equal((await request(view.port, "POST", `/${w.key}/session`, { body: { op: "rename", name: "q", from: "new-s" } })).status, 403);
  } finally { owner.close(); view.close(); }
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

test("renameSaved: a saved session that isn't open is renamed in place; nothing restarts", { timeout: 30_000 }, async () => {
  const { hostname } = await import("node:os");
  const { symlinkSync } = await import("node:fs");
  sessions.createSession("open-o");
  sessions.createSession("kept-a");
  writeFileSync(sessions.tabsFile("kept-a"), JSON.stringify({ tabs: [{ url: "https://a.test/" }] }));
  writeFileSync(sessions.peopleFile("kept-a"), JSON.stringify({ people: [] }));
  mkdirSync(sessions.timelineDir("kept-a"), { recursive: true });
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "runs", "kept-run.json"), JSON.stringify({ name: "kept run", session: "kept-a" }));
  sessions.createSession("other-z");
  const notes = [], order = [];
  const context = await makeContext({ notes, order });
  await context.getContext();
  await context.sessionCommand({ action: "use", name: "open-o" });
  assert.ok(await until(() => !context.isSwitching() && !context.isRestoring()));
  const before = launched.length;
  for (const [from, to, why] of [
    ["default", "x1", /default session keeps its name/], ["clean-7", "x1", /clean session/], ["nope", "x1", /No session "nope"/], ["../x", "x1", /No session/],
    ["kept-a", "a b", /letters, numbers/], ["kept-a", "default", /keeps for itself/], ["kept-a", "clean-9", /keeps for itself/],
    ["kept-a", "other-z", /already exists/], ["kept-a", "OPEN-O", /already exists/],
  ]) assert.match(context.renameSaved(from, to).error || "", why, `${from} -> ${to}`);
  assert.deepEqual(context.renameSaved("kept-a", "kept-a"), { ok: true, name: "kept-a", from: "kept-a", restarting: false });
  // A browser has its profile open (a live lock on this computer): refused; a lock left by a
  // process that is gone doesn't count.
  const lock = join(sessions.profileDir("kept-a"), "SingletonLock");
  symlinkSync(`${hostname()}-${process.pid}`, lock);
  assert.match(context.renameSaved("kept-a", "kept-b").error || "", /open in another browser/);
  rmSync(lock);
  symlinkSync(`${hostname()}-999999999`, lock);
  assert.deepEqual(context.renameSaved("kept-a", "kept-b"), { ok: true, name: "kept-b", from: "kept-a", restarting: false });
  for (const of of [sessions.profileDir, sessions.tabsFile, sessions.peopleFile, sessions.timelineDir]) {
    assert.equal(existsSync(of("kept-a")), false, `${of.name}: old gone`);
    assert.equal(existsSync(of("kept-b")), true, `${of.name}: new there`);
  }
  assert.equal(JSON.parse(readFileSync(join(home, "runs", "kept-run.json"), "utf8")).session, "kept-b", "its runs follow");
  assert.deepEqual(order.at(-1), ["renamed", "kept-a", "kept-b"]);
  assert.match(notes.at(-1), /renamed the saved browser session "kept-a" to "kept-b".*pairbrowse_session use kept-b/);
  assert.equal(context.sessionName(), "open-o", "the open session stays");
  await sleep(100);
  assert.equal(launched.length, before, "nothing restarted");
  assert.equal(sessions.currentSession(), "open-o");
  // The open session named as from: today's rename (the browser restarts on it).
  assert.deepEqual(context.renameSaved("open-o", "open-p"), { ok: true, name: "open-p", from: "open-o", restarting: true });
  assert.ok(await until(() => context.sessionName() === "open-p" && !context.isSwitching()));
  // While the browser switches (it may be opening that very session): refused.
  const going = context.sessionCommand({ action: "use", name: "kept-b" });
  assert.match(context.renameSaved("kept-b", "kept-c").error || "", /switching sessions/);
  await going;
});

// The browser profiles' routes (spec server-mode D14, step 38; liveview/routes/profiles.mjs over
// daemon/sessions/profile-owner.mjs with a store of its own): the owner's alone, never an invite
// link's or a join code's; a file over 1 MiB refused before a byte is parsed; an import, an
// assignment, an export and a check that has no build to check on.
test("profile routes owner-only; invite keys and join-code port 403; upload over 1 MiB refused", async () => {
  const { createProfileOwner } = await import("../scripts/daemon/sessions/profile-owner.mjs");
  const { createProfileStore } = await import("../scripts/profiles/store.mjs");
  const { fromConfig } = await import("../scripts/profiles/map.mjs");
  const store = createProfileStore({ dir: mkdtempSync(join(tmpdir(), "pb-sr-store-")) });
  sessions.createSession("pr-saved");
  const st = { session: "pr-open", contextPromise: Promise.resolve(), profile: null, engine: null };
  sessions.createSession("pr-open");
  const owner = createProfileOwner(st, { config: { browser: "pairbrowse-open" }, store, platform: "linux", configSettings: (native) => fromConfig({ browser: "pairbrowse-open" }, { native, platform: "linux" }) });
  let imports = 0;
  const profiles = { ...owner, importFile: (...a) => { imports++; return owner.importFile(...a); } };
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, sessionOps: { state: () => ({}), profiles } });
  const key = view.url.split("/").at(-2);
  const upload = (k, body, query = "", port = view.port) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/${k}/profile-import${query}`, headers: { host: `127.0.0.1:${port}`, "content-type": "application/octet-stream" } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (e) => (e.code === "EPIPE" || e.code === "ECONNRESET" ? resolve({ status: 413, text: "" }) : reject(e)));
    req.end(body);
  });
  try {
    let r = await request(view.port, "GET", `/${key}/profiles.json`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).current, "pr-open");
    // An import: the device file's settings, its source and license; a dry run first writes nothing.
    const device = readFileSync(new URL("./fixtures/profiles/engine-device-1.json", import.meta.url));
    r = await upload(key, device, "?file=phone.json&source=my%20phone&license=own-capture&dryRun=1");
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).dryRun, true);
    assert.equal(store.list().length, 0);
    r = await upload(key, device, "?file=phone.json&source=my%20phone&license=own-capture&name=phone");
    assert.equal(r.status, 200, r.text);
    const made = JSON.parse(r.text);
    assert.equal(made.name, "phone");
    assert.ok(made.items.some((i) => i.status === "unsupported"), "another device's hardware reported, not taken");
    // Refused with the check named, nothing made.
    r = await upload(key, device, "?file=phone.json&license=own-capture");
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /refused at the provenance check/);
    // Over 1 MiB: 413, never parsed (the import isn't asked).
    const n = imports;
    r = await upload(key, Buffer.alloc(1024 * 1024 + 1, 0x20), "?source=x&license=MIT");
    assert.equal(r.status, 413);
    assert.equal(imports, n, "not read past the cap");
    // Assign: a saved session that isn't open; the open one refused.
    r = await request(view.port, "POST", `/${key}/profiles`, { body: { op: "assign", session: "pr-saved", profile: "phone" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(sessions.readAssignment("pr-saved").profileId, made.id);
    r = await request(view.port, "POST", `/${key}/profiles`, { body: { op: "assign", session: "pr-open", profile: "phone" } });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /is open now/);
    r = await request(view.port, "POST", `/${key}/profiles`, { body: { op: "remove", profile: "phone" } });
    assert.equal(r.status, 409);
    r = await request(view.port, "POST", `/${key}/profiles`, { raw: "{" });
    assert.equal(r.status, 400);
    // Export: the sealed file's text.
    r = await request(view.port, "GET", `/${key}/profile-export?profile=phone`);
    assert.equal(r.status, 200);
    const exported = JSON.parse(r.text);
    assert.equal(JSON.parse(exported.text).format, "pairbrowse-profile");
    assert.match(exported.sha256, /^[0-9a-f]{64}$/);
    // A check with no native build in use: refused, saying why.
    r = await request(view.port, "POST", `/${key}/profiles`, { body: { op: "validate", profile: "phone" } });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /native PairBrowse build/);
    // Nobody but the owner, never on the join-code port.
    const count = store.list().length;
    for (const k of [invites.create({ role: "watch", label: "W" }).key, invites.create({ role: "drive", label: "D" }).key]) {
      assert.equal((await request(view.port, "GET", `/${k}/profiles.json`)).status, 403);
      assert.equal((await upload(k, device, "?source=x&license=MIT")).status, 403);
      assert.equal((await request(view.port, "POST", `/${k}/profiles`, { body: { op: "assign", session: "pr-saved", profile: "default" } })).status, 403);
      assert.equal((await request(view.port, "GET", `/${k}/profile-export?profile=phone`)).status, 403);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) {
      assert.notEqual((await request(view.guestPort, "GET", `/${k}/profiles.json`)).status, 200);
      assert.notEqual((await upload(k, device, "?source=x&license=MIT", view.guestPort)).status, 200);
    }
    assert.equal(store.list().length, count, "nothing imported through them");
    assert.equal(sessions.readAssignment("pr-saved").profileId, made.id);
  } finally { view.close(); }
  const bare = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank" });
  try { assert.equal((await request(bare.port, "GET", `/${bare.url.split("/").at(-2)}/profiles.json`)).status, 404, "no profiles part given"); } finally { bare.close(); }
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
