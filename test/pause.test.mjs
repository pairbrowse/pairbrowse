import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPause, pressPause } from "../scripts/daemon/pause.mjs";
import { fieldOwner, leftAlone, OWN_MS } from "../scripts/daemon/fields.mjs";
import { sleep } from "./helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "./helpers/daemon.mjs";

test("pause agents: people pause and resume, agents hear who, and a long pause answers instead of hanging", async () => {
  const changes = [];
  const pause = createPause({ onChange: (v) => changes.push(v), replyMs: 300 });
  const start = pause.seq();
  assert.equal(await pause.wait(), null, "not paused: no wait");
  assert.ok(pause.pause("Alice"));
  assert.equal(pause.pause("Bob"), false, "already paused: Alice stays the one who paused");
  assert.deepEqual([pause.view().paused, pause.view().by], [true, "Alice"]);
  const t = Date.now();
  assert.deepEqual(await pause.wait(), { by: "Alice" }, "still paused after replyMs: says by whom");
  assert.ok(Date.now() - t >= 250);
  const waiting = pause.wait();
  setTimeout(() => pause.resume("Bob"), 100);
  assert.equal(await waiting, null, "resumed: the action goes on");
  assert.match(pause.noteAfter(start).text, /paused by Alice, then resumed by Bob/);
  assert.equal(pause.noteAfter(pause.noteAfter(start).n).text, "", "once");
  assert.equal(changes.length, 2);
  const ac = new AbortController();
  pause.pause("Alice");
  setTimeout(() => ac.abort(), 50);
  assert.deepEqual(await pause.wait(ac.signal), { by: "Alice" }, "a disconnected agent stops waiting");
  assert.match(pause.noteAfter(start).text, /Agents are paused/);
});

test("a joined helper mirrors the host's pause, and leaving lets its agents go", () => {
  const pause = createPause();
  pause.mirror({ paused: true, by: "Bob<script>" });
  assert.equal(pause.view().by, "Bobscript", "names are cleaned");
  pause.mirror({ paused: true, by: "Bob" });
  pause.mirror({ paused: false, resumedBy: "Alice" });
  assert.deepEqual([pause.view().paused, pause.view().resumedBy], [false, "Alice"]);
});

test("a field a person edited is theirs for a while; an agent's own typing never makes it so", () => {
  const now = 10_000_000;
  const byAgent = (t) => t >= now - 1000 && t <= now - 500;
  assert.equal(fieldOwner(null, { host: "Bob", now }), null);
  assert.equal(fieldOwner({ times: [now - 800], name: "Notes" }, { host: "Bob", byAgent, now }), null, "the agent typed it");
  assert.deepEqual(fieldOwner({ times: [now - 3000], name: "Notes" }, { host: "Bob", byAgent, now }), { who: "Bob", local: true, name: "Notes" });
  assert.equal(fieldOwner({ times: [now - OWN_MS - 1] }, { host: "Bob", now }), null, "long ago");
  assert.ok(fieldOwner({ times: [now - OWN_MS - 1], focused: true }, { host: "Bob", now }), "still at it (focused)");
  assert.equal(fieldOwner({ times: [now - 10_001], focused: true }, { host: "Bob", now }), null, "focused, but 10 s without typing");
  assert.equal(fieldOwner({ times: [now + 60_000] }, { host: "Bob", now }), null, "a time in the future counts for nothing");
  const remote = fieldOwner({ times: [now - 9000], rw: "Alice", rt: now - 1000, name: "Delivery instructions" }, { host: "Bob", now });
  assert.deepEqual(remote, { who: "Alice", local: false, name: "Delivery instructions" }, "latest edit wins");
  assert.equal(leftAlone(remote), "Alice is filling Delivery instructions; left it as they wrote it.");
});

test("pause this agent: one connection held, the others go on, people resume it, the global Resume too", async () => {
  const changes = [];
  const pause = createPause({ onChange: (v) => changes.push(v), replyMs: 300 });
  const start = pause.seq();
  assert.ok(pause.pauseOne("a1", "Alice<b>"));
  assert.equal(pause.pauseOne("a1", "Bob"), false, "a second pause of the same agent changes nothing");
  assert.deepEqual(pause.heldFor("a1"), { paused: true, by: "Aliceb" }, "names are cleaned");
  assert.deepEqual(pause.heldFor("a2"), { paused: false, by: "" });
  assert.equal(pause.view().paused, false, "the global pause stays off");
  assert.deepEqual(pause.agents().map(({ id, by }) => ({ id, by })), [{ id: "a1", by: "Aliceb" }]);
  assert.equal(typeof pause.agents()[0].at, "number");
  assert.deepEqual(await pause.wait(null, "a1"), { by: "Aliceb" }, "its action waits, then says by whom");
  const t = Date.now();
  assert.equal(await pause.wait(null, "a2"), null, "another agent waits for nothing");
  assert.ok(Date.now() - t < 100);
  assert.match(pause.noteAfter(start, "a1").text, /You were paused by Aliceb \(this agent only\)/);
  assert.equal(pause.noteAfter(start, "a2").text, "", "another agent hears nothing of it");
  assert.equal(pause.noteAfter(start).text, "");
  const waiting = pause.wait(null, "a1");
  setTimeout(() => pause.resumeOne("a1", "Bob"), 50);
  assert.equal(await waiting, null, "a person resumed it");
  assert.equal(pause.resumeOne("a1", "Bob"), false, "nothing left to resume");
  assert.match(pause.noteAfter(start, "a1").text, /You were paused by Aliceb, then resumed by Bob/);
  assert.equal(changes.length, 2);
  // The global Resume lets every agent paused on its own go too.
  pause.pauseOne("a1", "Alice");
  pause.pauseOne("a2", "Alice");
  const seen = pause.seq();
  assert.equal(pause.resume("Carol"), true, "resume() with only agents of their own held: true");
  assert.deepEqual(pause.agents(), []);
  assert.equal(pause.view().paused, false);
  assert.match(pause.noteAfter(seen, "a2").text, /then resumed by Carol/);
  assert.equal(pause.resume("Carol"), false, "nothing held: false");
  pause.pauseOne("a1", "Alice");
  pause.pause("Dee");
  assert.deepEqual(pause.heldFor("a2"), { paused: true, by: "Dee" }, "the global pause holds everyone");
  assert.deepEqual(pause.heldFor("a1"), { paused: true, by: "Dee" }, "global first");
  assert.ok(pause.resume("Dee"));
  assert.deepEqual(pause.agents(), [], "the global Resume clears every agent's own pause");
  assert.match(pause.noteAfter(seen).text, /^- Agents were paused by Dee, then resumed by Dee\./, "the global wording as before");
  // A connection that ends takes its pause with it.
  pause.pauseOne("a3", "Alice");
  const n = changes.length;
  pause.forget("a3");
  assert.equal(changes.length, n + 1, "forget calls onChange");
  assert.deepEqual(pause.heldFor("a3"), { paused: false, by: "" });
  pause.forget("a3");
  assert.equal(changes.length, n + 1, "and only when it held something");
});

test("pause this agent: many clicks on one agent never push a shared pause out before an idle agent reads it", () => {
  const pause = createPause();
  const idle = pause.seq();
  pause.pause("Alice");
  pause.resume("Alice");
  for (let i = 0; i < 30; i++) { pause.pauseOne("a1", "Bob"); pause.resumeOne("a1", "Bob"); pause.pauseOne(`x${i}`, "Bob"); }
  pause.resume("Carol"); // one "resumed" per agent paused on its own
  assert.match(pause.noteAfter(idle, "a2").text, /^- Agents were paused by Alice, then resumed by Alice\./, "the idle agent still hears the shared pause");
  assert.doesNotMatch(pause.noteAfter(idle, "a2").text, /You were paused/, "and nothing of the others' own");
  const a1 = pause.noteAfter(idle, "a1").text;
  assert.match(a1, /Agents were paused by Alice/);
  assert.match(a1, /You were paused by Bob, then resumed by Bob/, "its own, kept apart");
  pause.forget("a1");
  assert.equal(pause.noteAfter(pause.noteAfter(idle).n, "a1").text, "", "its own go with its connection");
});

test("resumeAgents lets every agent paused on its own go and leaves the shared pause alone", () => {
  let changes = 0;
  const pause = createPause({ onChange: () => changes++ });
  const seen = pause.seq();
  pause.pauseOne("a1", "Alice");
  pause.pauseOne("a2", "Alice");
  pause.mirror({ paused: true, by: "Host" });
  changes = 0;
  assert.equal(pause.resumeAgents("Me"), true);
  assert.deepEqual(pause.agents(), []);
  assert.deepEqual([pause.view().paused, pause.view().by], [true, "Host"], "the shared pause stays");
  assert.equal(changes, 1);
  assert.match(pause.noteAfter(seen, "a1").text, /then resumed by Me/);
  assert.equal(pause.resumeAgents("Me"), false, "nothing held: nothing changes");
  assert.equal(changes, 1);
});

test("the hold (a proxy's recheck) holds every agent; a host's state mirrored here never ends it, a person's Resume here does", () => {
  const press = (pause, opts) => pressPause(pause, { say: () => {}, ...opts });
  let pause = createPause();
  const seen = pause.seq();
  assert.equal(pause.hold("Proxy check"), true);
  assert.equal(pause.hold("Proxy check"), false, "held already");
  assert.deepEqual([pause.view().paused, pause.view().by], [true, "Proxy check"]);
  assert.deepEqual(pause.heldFor("a1"), { paused: true, by: "Proxy check" });
  assert.match(pause.noteAfter(seen, "a1").text, /Agents are paused \(paused by Proxy check\)/);
  // The host's next push in a session joined from here: not paused there. The hold stays.
  assert.equal(pause.mirror({ paused: false, resumedBy: "Host" }), false);
  pause.mirror({ paused: true, by: "Host" });
  pause.mirror({ paused: false, resumedBy: "Host" });
  assert.deepEqual([pause.view().paused, pause.view().by], [true, "Proxy check"], "the mirror cleared only the host's pause");
  assert.deepEqual(pause.heldFor("a1"), { paused: true, by: "Proxy check" });
  // A Resume pressed here in a joined session (forwarded to the host) lets it go at once.
  assert.deepEqual(press(pause, { paused: false, who: "Me", joined: true, canPause: () => true }), { ok: true });
  assert.equal(pause.view().paused, false);
  assert.deepEqual(pause.heldFor("a1"), { paused: false, by: "" });
  // Not joined: the global Resume ends it.
  pause = createPause();
  const from = pause.seq();
  pause.hold("Proxy check");
  assert.equal(pause.resume("Ann"), true);
  assert.deepEqual([pause.view().paused, pause.view().resumedBy], [false, "Ann"]);
  assert.match(pause.noteAfter(from).text, /Agents were paused by Proxy check, then resumed by Ann/);
  // Under a shared pause: agents hear nothing new until the last of the two ends.
  pause = createPause();
  pause.pause("Bob");
  const quiet = pause.seq();
  pause.hold("Proxy check");
  assert.equal(pause.noteAfter(quiet).text, "", "already held by Bob: nothing new for agents");
  assert.equal(pause.resume("Bob"), true);
  assert.equal(pause.view().paused, false, "one Resume ends both");
});

test("in a session joined from here, the global Resume also clears this helper's own per-agent pauses (a pause always has a visible way back)", () => {
  const press = (pause, opts) => { const said = []; const r = pressPause(pause, { say: (op) => said.push(op), ...opts }); return { r, said }; };
  const ids = (names) => (name) => names[name] || [];

  // A drive joiner: an agent paused here before joining, the host's pause mirrored.
  let pause = createPause();
  let seen = pause.seq();
  pause.pauseOne("a1", "Alice");
  pause.mirror({ paused: true, by: "Host" });
  let { r, said } = press(pause, { paused: false, who: "Me", joined: true, canPause: () => true });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(said, [{ op: "pause", paused: false }], "the Resume still goes to the host");
  assert.deepEqual(pause.agents(), [], "this helper's own paused agent goes at once");
  assert.equal(pause.view().paused, true, "the host decides the shared pause");
  assert.match(pause.noteAfter(seen, "a1").text, /then resumed by Me/);

  // Pause pressed while joined: forwarded, this helper's own pauses left alone.
  pause = createPause();
  pause.pauseOne("a1", "Alice");
  ({ r, said } = press(pause, { paused: true, who: "Me", joined: true, canPause: () => true }));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(said, [{ op: "pause", paused: true }]);
  assert.equal(pause.agents().length, 1);

  // A watcher, nothing shared paused: their Resume lets their own agents go, nothing is forwarded.
  pause = createPause();
  pause.pauseOne("a1", "Alice");
  ({ r, said } = press(pause, { paused: false, who: "Me", joined: true, canPause: () => false }));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(pause.agents(), []);
  assert.deepEqual(said, []);

  // A watcher while the host's pause holds: they can't resume it, their own agents still go.
  pause = createPause();
  pause.pauseOne("a1", "Alice");
  pause.mirror({ paused: true, by: "Host" });
  ({ r, said } = press(pause, { paused: false, who: "Me", joined: true, canPause: () => false }));
  assert.match(r.problem, /only drive participants/);
  assert.deepEqual(pause.agents(), []);
  assert.deepEqual(said, []);
  assert.equal(pause.view().paused, true);
  // A watcher's Pause: refused as before.
  ({ r, said } = press(createPause(), { paused: true, who: "Me", joined: true, canPause: () => false }));
  assert.match(r.problem, /only drive participants/);
  assert.deepEqual(said, []);

  // One agent by name while joined: never paused on its own, always resumable.
  pause = createPause();
  ({ r } = press(pause, { paused: true, who: "Me", agent: "Ann", joined: true, agentIds: ids({ Ann: ["a1"] }) }));
  assert.match(r.problem, /one agent can't be paused on its own/);
  assert.deepEqual(pause.agents(), []);
  pause.pauseOne("a1", "Alice");
  ({ r } = press(pause, { paused: false, who: "Me", agent: "Ann", joined: true, agentIds: ids({ Ann: ["a1"] }) }));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(pause.agents(), []);

  // Not joined: the global Resume clears the global pause and every own one; an unknown name is said.
  pause = createPause();
  seen = pause.seq();
  ({ r } = press(pause, { paused: true, who: "Me", agent: "Ann", agentIds: ids({ Ann: ["a1", "a2"] }) }));
  assert.deepEqual(r, { ok: true });
  assert.equal(pause.agents().length, 2);
  ({ r, said } = press(pause, { paused: true, who: "Me" }));
  assert.deepEqual([r, pause.view().paused, said], [{ ok: true }, true, []]);
  ({ r } = press(pause, { paused: false, who: "Me" }));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual([pause.view().paused, pause.agents()], [false, []]);
  assert.match(pause.noteAfter(seen, "a1").text, /then resumed by Me/);
  ({ r } = press(pause, { paused: true, who: "Me", agent: "Nobody", agentIds: ids({}) }));
  assert.equal(r.problem, 'No agent named "Nobody" works in this browser.');
});

// ---- "Pause this agent" end to end: the live view's route, the helper matching the name to the
// agent's connection, and serve holding that agent's acting calls only. Live: a real helper and a
// headless browser in a temporary home (PAIRBROWSE_TEST_RUNTIME).
import net from "node:net";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const textOf = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

async function agent(sockPath, name) {
  let sock;
  for (const end = Date.now() + 90_000; ; await sleep(100)) {
    sock = net.createConnection(sockPath);
    if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
    sock.destroy();
    if (Date.now() > end) throw new Error(`couldn't connect to ${sockPath}`);
  }
  sock.on("error", () => {});
  const waiting = new Map();
  createInterface({ input: sock }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m?.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = `${name}${++seq}`;
    waiting.set(id, resolve);
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1", pairbrowseParticipant: name } });
  sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { sock, tool: (tool, args = {}) => call("tools/call", { name: tool, arguments: args }) };
}

test("pause this agent through the live view: only that agent's next acting call waits, the global Resume lets it go", { skip: !runtime, timeout: 180_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const home = mkdtempSync(join(tmpdir(), "pb-pa-"));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false, sessionPicker: false }));
  const daemon = spawnDaemon(home);
  const agents = [];
  try {
    const a = await agent(join(home, "run", "browser.sock"), "Ann");
    const b = await agent(join(home, "run", "browser.sock"), "Ben");
    agents.push(a, b);
    assert.ok(!(await a.tool("browser_press_key", { key: "Shift" })).result?.isError, "Ann acts before the pause");
    const own = await b.tool("browser_tabs", { action: "new" }); // Ben works in a tab of his own
    assert.ok(!own.result?.isError, textOf(own));
    const live = textOf(await a.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
    assert.ok(live, "the live view's address");
    const post = async (body) => { const r = await fetch(`${live}pause`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    // The owner pauses Ann by the name the session list shows.
    let r = await post({ paused: true, who: "Ann · Claude Code" });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    r = await post({ paused: true, who: "Nobody · Claude Code" });
    assert.equal(r.status, 409);
    assert.match(r.body.problem, /No agent named "Nobody · Claude Code" works in this browser/);
    // The owner's stream says who is paused on their own, and by whom.
    const ac = new AbortController();
    let stream = "";
    const reading = fetch(`${live}events?panel=1`, { signal: ac.signal }).then(async (res) => { for await (const c of res.body) stream += Buffer.from(c).toString("utf8"); }).catch(() => {});
    for (const end = Date.now() + 5000; !/event: pause\n/.test(stream) && Date.now() < end; ) await sleep(50);
    ac.abort();
    await reading;
    const block = stream.split("\n\n").find((x) => x.startsWith("event: pause\n"));
    assert.ok(block, "a pause event on the owner's stream");
    const ev = JSON.parse(block.slice(block.indexOf("data: ") + 6));
    assert.equal(ev.perAgent, true);
    assert.equal(ev.paused, false, "the global pause stays off");
    assert.deepEqual(ev.agents.map((x) => x.who), ["Ann · Claude Code"]);
    assert.equal(typeof ev.agents[0].by, "string");
    assert.equal(typeof ev.agents[0].at, "number");
    // Ann's acting call waits; Ben's goes through at once.
    const annWaits = (async () => { const t = Date.now(); const res = await a.tool("browser_press_key", { key: "Shift" }); return { ms: Date.now() - t, res }; })();
    await sleep(300);
    const t = Date.now();
    const ben = await b.tool("browser_press_key", { key: "Shift" });
    assert.ok(!ben.result?.isError, textOf(ben));
    assert.ok(Date.now() - t < 3000, `Ben wasn't held (${Date.now() - t} ms)`);
    await sleep(2500);
    // The global Resume releases every agent paused on its own too.
    r = await post({ paused: false });
    assert.equal(r.status, 200);
    const ann = await annWaits;
    assert.ok(ann.ms >= 2500, `Ann waited (${ann.ms} ms)`);
    assert.ok(!ann.res.result?.isError, textOf(ann.res));
    assert.match(textOf(ann.res), /You were paused by [^\n]*, then resumed by/);
    assert.doesNotMatch(textOf(ben), /You were paused/, "Ben heard nothing of Ann's pause");
    // Paused and resumed by name: resuming one is the owner's too.
    assert.equal((await post({ paused: true, who: "Ann · Claude Code" })).status, 200);
    assert.equal((await post({ paused: false, who: "Ann · Claude Code" })).status, 200);
    const again = Date.now();
    assert.ok(!(await a.tool("browser_press_key", { key: "Shift" })).result?.isError);
    assert.ok(Date.now() - again < 3000, "resumed by name: Ann goes on at once");
  } finally {
    for (const s of agents) s.sock.destroy();
    await stopDaemon(daemon);
    rmSync(home, { recursive: true, force: true });
  }
});
