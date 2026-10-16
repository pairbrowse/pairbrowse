// A plugin update handed over to the helper (scripts/handoff.mjs): the bridge's version hello on
// the private socket, the helper's answer (a restart only when idle and only to a strictly newer
// plain version), what pairbrowse_status says while it waits, and the bridge's side
// (launcher/daemon-connect.mjs connectLocal) against helpers old and new.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "pb-ho-"));
process.env.PAIRBROWSE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { parseVersion, isNewer, helloLine, readAnswer, askVersion, busyReason, createVersionHandoff, waitGone, pendingLine, VERSION_MAX, PERSON_QUIET_MS } = await import("../scripts/handoff.mjs");
const { HOOK_MARK } = await import("../scripts/hookline.mjs");
const { routeConnection } = await import("../scripts/daemon/approvals.mjs");
const { statusLine } = await import("../scripts/daemon/serve/tools/status.mjs");
const { createDownloads } = await import("../scripts/daemon/toolstab.mjs");
const { connectLocal, BRIDGE_VERSION } = await import("../scripts/launcher/daemon-connect.mjs");
const { paths } = await import("../scripts/paths.mjs");

test("versions: plain x.y.z only, compared part by part, strictly newer", () => {
  assert.deepEqual(parseVersion("0.16.1"), [0, 16, 1]);
  assert.deepEqual(parseVersion("10.0.123"), [10, 0, 123]);
  for (const bad of ["", "0.16", "0.16.1.2", "v0.16.1", "0.16.1-beta", "0.16.1+b", "01.2.3", "1.02.3", " 1.2.3", "1.2.3\n", "1.2.x", "1234567.0.0", null, 1, {}, ["1.2.3"], "9".repeat(VERSION_MAX + 1)]) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
  }
  assert.equal(isNewer("0.16.2", "0.16.1"), true);
  assert.equal(isNewer("0.17.0", "0.16.9"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.16.10", "0.16.9"), true, "numbers, not text");
  assert.equal(isNewer("0.16.1", "0.16.1"), false, "equal is not newer");
  assert.equal(isNewer("0.16.0", "0.16.1"), false);
  assert.equal(isNewer("0.9.0", "0.16.0"), false, "numbers, not text");
  assert.equal(isNewer("99.0.0", ""), false, "a helper with no version of its own: nothing compares");
  assert.equal(isNewer("0.16.2-rc", "0.16.1"), false);
});

test("the hello is one line with the hooks' mark, routed as a single line, never as an agent", async () => {
  const line = helloLine("0.16.2");
  assert.ok(line.startsWith(HOOK_MARK));
  assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
  assert.deepEqual(JSON.parse(line), { pairbrowse: "hook", op: "version", v: 1, version: "0.16.2" });
  const sock = new EventEmitter();
  Object.assign(sock, { pause() {}, unshift() {}, destroy() {} });
  const got = await new Promise((resolve) => {
    routeConnection(sock, { onHook: (s, l) => resolve(["hook", l]), onOther: () => resolve(["other"]) });
    sock.emit("data", Buffer.from(line));
  });
  assert.deepEqual(got, ["hook", line.trimEnd()]);
});

test("the bridge reads only an exact yes as a restart", () => {
  assert.deepEqual(readAnswer('{"restart":true}'), { restart: true });
  assert.deepEqual(readAnswer('{"restart":false,"why":"an agent is connected"}'), { restart: false, why: "an agent is connected" });
  for (const other of ['{"answer":"none"}', '{"restart":"true"}', '{"restart":1}', "[true]", "true", "", null, "garbage", '{"ok":false,"why":"unknown request"}']) {
    assert.deepEqual(readAnswer(other).restart, false, String(other));
  }
});

const IDLE = { agents: 0, people: 0, shared: 0, joined: false, recording: false, approvals: 0, downloads: 0, personAt: 0 };
test("idle means nobody and nothing uses the helper; each one alone keeps it", () => {
  const now = 1_000_000_000;
  assert.equal(busyReason({ ...IDLE, now }), null);
  assert.equal(busyReason({ ...IDLE, personAt: now - PERSON_QUIET_MS, now }), null, "two minutes quiet");
  const busy = {
    agents: [{ agents: 1 }, /an agent is connected/], agents2: [{ agents: 2 }, /2 agents are connected/],
    people: [{ people: 1 }, /people are in/], shared: [{ shared: 1 }, /people are in/],
    joined: [{ joined: true }, /joined another session/], recording: [{ recording: true }, /recording/],
    approvals: [{ approvals: 1 }, /approval is waiting/], downloads: [{ downloads: 1 }, /download/],
    person: [{ personAt: now - 5000 }, /used the browser in the last 2 minutes/], personEdge: [{ personAt: now - PERSON_QUIET_MS + 1 }, /last 2 minutes/],
  };
  for (const [name, [s, why]] of Object.entries(busy)) assert.match(busyReason({ ...IDLE, ...s, now }) || "", why, name);
});

// A socket as answer() sees one: what it wrote, whether it ended.
function fakeSock() {
  const s = new EventEmitter();
  Object.assign(s, { destroyed: false, written: "", resume() {}, end(text, cb) { this.written += text || ""; this.destroyed = true; if (cb) setImmediate(cb); } });
  return s;
}
const hello = (version, extra = {}) => JSON.stringify({ pairbrowse: "hook", op: "version", v: 1, version, ...extra });

test("the helper: a newer bridge while idle stops it; otherwise it stays and says why", async () => {
  let state = { ...IDLE };
  let stops = 0;
  const lines = [];
  const lock = join(home, "test.lock");
  writeFileSync(lock, "1");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(lock, old, old);
  const h = createVersionHandoff({ own: "0.16.1", state: () => state, stop: () => { stops++; }, lock, log: (l) => lines.push(l) });
  const ask = (line) => { const s = fakeSock(); return { handled: h.answer(s, line), s, answer: s.written ? JSON.parse(s.written) : null }; };

  // Not a version hello: not handled here (the opener's and the approvals' lines go on).
  assert.equal(h.answer(fakeSock(), '{"pairbrowse":"hook","op":"approval","v":1}'), false);
  assert.equal(h.answer(fakeSock(), "not json"), false);
  assert.equal(h.answer(fakeSock(), hello("1.0.0", { pad: "x".repeat(600) })), false, "over the line cap");

  // Equal, older, malformed: no restart, nothing remembered.
  for (const [v, why] of [["0.16.1", "same version"], ["0.16.0", "not newer"], ["0.16.2-rc", "unknown request"], ["x".repeat(40), "unknown request"]]) {
    const r = ask(hello(v));
    assert.equal(r.handled, true);
    assert.deepEqual(r.answer, { restart: false, why }, v);
  }
  assert.deepEqual(ask(JSON.stringify({ pairbrowse: "hook", op: "version", v: 2, version: "9.9.9" })).answer, { restart: false, why: "unknown request" });
  assert.equal(h.note(), "");

  // Newer while in use: stays, says why, remembers the newest.
  state = { ...IDLE, agents: 1 };
  assert.deepEqual(ask(hello("0.16.2")).answer, { restart: false, why: "an agent is connected" });
  assert.deepEqual(ask(hello("0.17.0")).answer, { restart: false, why: "an agent is connected" });
  ask(hello("0.16.3"));
  assert.equal(h.note(), pendingLine("0.17.0"));
  assert.equal(h.note(), "PairBrowse 0.17.0 is installed; this browser moves to it the next time a session starts while nobody is using the browser.");
  assert.equal(stops, 0, "never a restart while in use");
  state = { ...IDLE, personAt: Date.now() - 1000 };
  assert.match(ask(hello("0.16.2")).answer.why, /last 2 minutes/);
  // state() failing: no restart.
  const broken = createVersionHandoff({ own: "0.16.1", state: () => { throw new Error("boom"); }, stop: () => { stops++; } });
  const b = fakeSock();
  broken.answer(b, hello("0.16.2"));
  assert.equal(JSON.parse(b.written).restart, false);
  assert.equal(stops, 0);

  // Idle: yes, the lock freshened, then the stop once the answer is out.
  state = { ...IDLE };
  const r = ask(hello("0.16.2"));
  assert.deepEqual(r.answer, { restart: true });
  assert.ok(Date.now() - statSync(lock).mtimeMs < 5000, "the lock is fresh: a helper started meanwhile leaves");
  await new Promise((res) => setImmediate(res));
  assert.equal(stops, 1);
  // A second bridge meanwhile: also yes (it waits for the stop too), but no second stop.
  assert.deepEqual(ask(hello("0.16.2")).answer, { restart: true });
  await new Promise((res) => setTimeout(res, 350));
  assert.equal(stops, 1);
  assert.ok(lines.some((l) => /stopping so it starts the new one/.test(l)), "logged");
  assert.ok(lines.some((l) => /but an agent is connected: staying on 0\.16\.1/.test(l)), "logged");
});

test("pairbrowse_status says the waiting version on its own line", () => {
  const sel = { source: "default", instance: null };
  const sandbox = { on: true, reason: null, refused: null };
  assert.equal(statusLine(sel, [], sandbox), "ok");
  assert.equal(statusLine(sel, [], sandbox, ""), "ok");
  assert.equal(statusLine(sel, [], sandbox, pendingLine("0.17.0")), `ok\n${pendingLine("0.17.0")}`);
});

test("downloads in progress count, in any session, until done, failed or an hour old", () => {
  let session = "a";
  const d = createDownloads({ session: () => session });
  assert.equal(d.inProgress(), 0);
  const one = d.add({ name: "a.pdf" });
  session = "b";
  const two = d.add({ name: "b.pdf" });
  assert.equal(d.inProgress(), 2);
  d.failed(one);
  assert.equal(d.inProgress(), 1);
  assert.equal(d.inProgress(Date.now() + 61 * 60_000), 0, "a download that never said it ended doesn't hold forever");
  d.done(two, join(home, "missing-file"));
  assert.equal(d.inProgress(), 0);
});

test("waitGone: until the socket stops answering and the lock's process is gone, bounded", async () => {
  let t = 0;
  const clock = { now: () => t, nap: async (ms) => { t += ms; } };
  let up = 3;
  assert.equal(await waitGone({ reachable: async () => up-- > 0, holder: () => 0, ...clock }), true);
  let alive = 2;
  assert.equal(await waitGone({ reachable: async () => false, holder: () => 4242, alive: () => alive-- > 0, ...clock }), true);
  t = 0;
  assert.equal(await waitGone({ reachable: async () => true, holder: () => 0, ms: 1000, ...clock }), false, "bounded");
  assert.ok(t >= 1000 && t < 1300);
});

// ---- the bridge's side, against helpers on the test home's socket ----

function fakeRuntime() {
  mkdirSync(join(paths.runtime, "node_modules", "@playwright", "mcp"), { recursive: true });
  writeFileSync(join(paths.runtime, "package-lock.json"), readFileSync(join(root, "runtime", "package-lock.json")));
}
// A helper on paths.socket: answer(line) gives its answer to a single line (null: none; it never
// answers an agent's connection's bytes, it just keeps it).
async function fakeHelper(answer) {
  mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
  rmSync(paths.socket, { force: true });
  const seen = [];
  const conns = new Set();
  const server = net.createServer((c) => {
    conns.add(c);
    c.on("close", () => conns.delete(c));
    c.on("error", () => {});
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0 || !buf.startsWith(HOOK_MARK)) return;
      seen.push(buf.slice(0, i));
      const a = answer(buf.slice(0, i));
      if (a !== null) c.end(`${a}\n`);
    });
  });
  await new Promise((r) => server.listen(paths.socket, r));
  return { seen, close: () => new Promise((r) => { for (const c of conns) c.destroy(); server.close(r); }) };
}

test("askVersion: the line out, the answer read back, the socket closed", async () => {
  const h = await fakeHelper(() => '{"restart":true}');
  try {
    const s = net.connect(paths.socket);
    await new Promise((r) => s.once("connect", r));
    assert.deepEqual(await askVersion(s, "1.2.3"), { restart: true });
    assert.equal(s.destroyed, true);
    assert.deepEqual(JSON.parse(h.seen[0]), { pairbrowse: "hook", op: "version", v: 1, version: "1.2.3" });
  } finally { await h.close(); }
});

test("the bridge says this copy's own version", () => {
  assert.equal(BRIDGE_VERSION, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  assert.ok(parseVersion(BRIDGE_VERSION), "a plain release version");
});

test("connectLocal: an older helper's no, a silent one and a helper in use are connected to as before", async () => {
  fakeRuntime();
  const starts = [];
  const start = () => { starts.push(1); return { exitCode: null }; };
  for (const [name, answer, slow] of [["old helper", '{"answer":"none"}', false], ["in use", '{"restart":false,"why":"an agent is connected"}', false], ["silent", null, true]]) {
    const h = await fakeHelper(() => answer);
    try {
      const t = Date.now();
      const s = await connectLocal(() => {}, { version: "99.0.0", agent: null, start });
      s.destroy();
      assert.equal(h.seen.length, 1, name);
      assert.deepEqual(JSON.parse(h.seen[0]), { pairbrowse: "hook", op: "version", v: 1, version: "99.0.0" });
      if (slow) assert.ok(Date.now() - t >= 1400 && Date.now() - t < 4000, `bounded wait for a silent helper (${Date.now() - t} ms)`);
    } finally { await h.close(); }
  }
  assert.deepEqual(starts, [], "nothing started");
});

test("connectLocal: a yes waits for the old helper to go, then starts this copy's and connects to it", async () => {
  fakeRuntime();
  const said = [];
  let oldGoneAt = 0;
  let startedAt = 0;
  let next = null;
  writeFileSync(paths.daemonLock, String(process.pid)); // the old helper holds the lock (a live pid)
  const old = await fakeHelper(() => {
    // The old helper stops a moment after its yes: socket first, then the lock at its exit.
    setTimeout(async () => { await old.close(); setTimeout(() => { rmSync(paths.daemonLock, { force: true }); oldGoneAt = Date.now(); }, 300); }, 200);
    return '{"restart":true}';
  });
  const start = ({ agent }) => {
    startedAt = Date.now();
    assert.equal(agent, null);
    fakeHelper(() => '{"restart":false,"why":"same version"}').then((h) => { next = h; });
    return { exitCode: null };
  };
  const s = await connectLocal((m) => said.push(m), { version: "99.0.0", agent: null, start });
  try {
    assert.ok(oldGoneAt > 0 && startedAt >= oldGoneAt, "started only after the old helper was gone");
    assert.ok(said.some((m) => /99\.0\.0 is installed; the helper restarts on it/.test(m)), said.join(" | "));
    assert.equal(next.seen.length, 0, "the new helper got the connection, not another hello");
  } finally { s.destroy(); await next?.close(); }
});
