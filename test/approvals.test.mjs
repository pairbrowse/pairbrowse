import "./helpers/home.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createClickApprovals, routeConnection, APPROVAL_ID, ARM_MS } from "../scripts/daemon/approvals.mjs";
import { approvalAsk, HOOK_MARK } from "../scripts/guard.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every store a test made: what it left waiting is withdrawn after it (no reading left running).
const made = [];
afterEach(() => { for (const ca of made.splice(0)) for (const it of ca.pending()) ca.withdraw(it.id, "test over"); });
const PAY = { element: "Pay: Place order", target: "e5" };
const KEYS = ["agent", "at", "id", "kind", "reason", "tab", "target"];

// A page as the helper sees it: its card calls recorded, its answers handed out by the test.
function fakePage(url = "https://shop.example/checkout") {
  const page = { calls: [], answers: null, closed: false, url: () => url, isClosed: () => page.closed };
  return page;
}
function setup({ front = null, surfaces = {}, sharing = false, guests = 0, person = () => true, waitMs = 120_000, clock = null, docked = null, targetOf = null } = {}) {
  const logs = [];
  const intervals = new Set();
  let fronted = front;
  let fronts = 0;
  const hud = {
    call: async (page, value, kind) => {
      page.calls.push([kind, value]);
      if (kind === "approval") return true;
      if (kind === "approval-answers") { const a = page.answers; page.answers = null; return a || { a: null, ids: page.calls.filter(([k]) => k === "approval").map(([, v]) => v.id).join(","), dismissed: "" }; }
      return true;
    },
    sparkColor: () => "#20c997",
    sparkPage: () => null,
  };
  const collaboration = { participants: new Map([["p1", { label: "Alice · Codex" }]]) };
  const lv = { sharing: () => sharing, guestViewers: () => guests, pageClients: () => surfaces, tabIndex: async () => 2 };
  const ca = createClickApprovals({
    hud, presence: { byPerson: person }, collaboration, liveView: () => lv, frontPage: async () => { fronts++; return fronted; },
    mask: (t) => t.replace(/secret123/g, "••••"), log: (t) => logs.push(t), waitMs,
    ...(clock ? { now: clock } : {}),
    ...(docked ? { docked } : {}),
    ...(targetOf ? { targetOf } : {}),
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); intervals.add(h); return h; },
    clearInterval: (h) => { intervals.delete(h); clearInterval(h); },
  });
  made.push(ca);
  return { ca, logs, intervals, lv, setFront: (p) => { fronted = p; }, fronts: () => fronts };
}

test("routeConnection: a hook's line to onHook, an agent's MCP stream to onOther, read whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-rt-"));
  const path = join(dir, "s.sock");
  const hooks = [], lines = [];
  let others = 0;
  const server = net.createServer((sock) => routeConnection(sock, {
    onHook: (s, line) => { hooks.push(line); s.end('{"answer":"none"}\n'); },
    onOther: (s) => { others++; setTimeout(() => createInterface({ input: s }).on("line", (l) => lines.push(l)), 20); },
  }));
  await new Promise((r) => server.listen(path, r));
  try {
    const hook = net.connect(path);
    await new Promise((r) => hook.on("connect", r));
    hook.write(`${HOOK_MARK},"op":"approval","v":1}\n`);
    await sleep(100);
    assert.deepEqual(hooks, [`${HOOK_MARK},"op":"approval","v":1}`]);
    hook.destroy();

    const mcp = net.connect(path);
    await new Promise((r) => mcp.on("connect", r));
    mcp.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    await sleep(100);
    // One whose first bytes could start either way, split across two writes.
    const split = net.connect(path);
    await new Promise((r) => split.on("connect", r));
    split.write('{"params"');
    await sleep(50);
    split.write(':{"x":1},"jsonrpc":"2.0","id":2,"method":"initialize"}\n');
    await sleep(150);
    assert.equal(others, 2);
    assert.deepEqual(lines.sort(), ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', '{"params":{"x":1},"jsonrpc":"2.0","id":2,"method":"initialize"}'].sort());
    // A probe that sends nothing calls neither.
    const probe = net.connect(path);
    await new Promise((r) => probe.on("connect", r));
    probe.destroy();
    await sleep(50);
    assert.equal(others, 2);
    assert.equal(hooks.length, 1);
    mcp.destroy(); split.destroy();
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open(): the item's contract, a random id, the agent's name and tab, masked text", async () => {
  const page = fakePage();
  const { ca } = setup({ front: page });
  ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "pays secret123", target: "Place order" }, participant: "p1", client: "codex-mcp-client" });
  assert.equal(r.shown, true);
  assert.deepEqual(Object.keys(r.item).sort(), KEYS);
  assert.match(r.item.id, APPROVAL_ID);
  assert.deepEqual(r.item.agent, { label: "Alice · Codex", color: "#20c997" });
  assert.deepEqual(r.item.tab, { id: 2, host: "shop.example", target: "" }, "no target lookup given: empty");
  assert.equal(r.item.kind, "click");
  assert.equal(r.item.reason, "pays ••••", "masked like titles");
  assert.deepEqual(ca.pending(), [r.item]);
  assert.deepEqual(page.calls[0], ["approval", { id: r.item.id, who: "Alice · Codex", color: "#20c997", target: "Place order", reason: "pays ••••", terminal: false }], "Codex: no terminal asks too");
  const again = await ca.open({ tool: "browser_click", input: { ...PAY, target: "e6" }, ask: { reason: "r", target: "t" }, participant: "p1" });
  assert.notEqual(again.item.id, r.item.id);
  // No participant (Claude Code with several sessions): named for the app, no tab guessed.
  const { ca: other } = setup({ surfaces: { approve: 1 } });
  const lone = await other.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  assert.deepEqual(lone.item.agent, { label: "Claude Code", color: "#e9763f" });
  assert.deepEqual(lone.item.tab, { id: -1, host: "", target: "" });
});

test("nowhere to ask: nothing kept, nothing waits", async () => {
  const page = fakePage();
  for (const opts of [{ front: null }, { front: page, sharing: true }, { front: page, guests: 1 }]) {
    const { ca, intervals } = setup(opts);
    ca.participant("p1", { client: "codex-mcp-client", tab: () => page });
    const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1" });
    assert.deepEqual(r, { shown: false }, JSON.stringify(opts));
    assert.deepEqual(ca.pending(), []);
    assert.equal(intervals.size, 0);
  }
  // Another agent's tab in front: never shown there.
  const mine = fakePage(), theirs = fakePage();
  const { ca } = setup({ front: theirs });
  ca.participant("p1", { client: "codex-mcp-client", tab: () => mine });
  assert.deepEqual(await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1" }), { shown: false });
  assert.equal(theirs.calls.length, 0);
});

test("answers: once only; site counts as Allow and says there is no per-site memory; withdraw; arrived", async () => {
  const { ca, logs } = setup({ surfaces: { approve: 1 } });
  const changes = [];
  ca.onChange((c) => changes.push(c));
  let r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  assert.equal(ca.answer(r.item.id, "nope", "x"), false, "not an answer");
  assert.equal(ca.answer(r.item.id, "site", "the live view"), true);
  assert.equal(ca.answer(r.item.id, "allow", "the live view"), false, "answered already");
  assert.equal(await r.answer, "site");
  assert.ok(logs.some((l) => /site from the live view \(no per-site memory exists: treated as Allow\)/.test(l)));
  assert.deepEqual(changes.map((c) => c.op), ["add", "withdraw"]);
  assert.deepEqual(changes[1].item, { id: r.item.id, answer: "allow", by: "The host" }, "the cards that go hear who answered");
  assert.equal(ca.arrived("browser_click", { target: "e5", element: "Pay: Place order" }), null, "an allow lets the call through");

  // Denied in the browser: the same call arriving anyway is refused.
  r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  ca.answer(r.item.id, "deny", "the page");
  assert.equal(await r.answer, "deny");
  assert.equal(ca.arrived("browser_click", PAY), "denied");
  assert.equal(ca.arrived("browser_click", PAY), null, "once");

  // A new ask for the same call clears the old answer.
  r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  ca.answer(r.item.id, "deny", "the page");
  const next = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  // The call arrives while it still waits: the terminal's yes, the card withdrawn.
  assert.equal(ca.arrived("browser_click", PAY), "withdrawn");
  assert.equal(await next.answer, "withdrawn");
  assert.deepEqual(ca.pending(), []);
  assert.equal(ca.arrived("browser_click", PAY), null, "the old deny went with the new ask");

  r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  assert.equal(ca.withdraw(r.item.id, "test"), true);
  assert.equal(await r.answer, "withdrawn");
  assert.equal(ca.withdraw(r.item.id, "test"), false);
});

test("an ask with no answer expires", async () => {
  const { ca } = setup({ surfaces: { approve: 1 }, waitMs: 50 });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  assert.equal(await r.answer, "expired");
  assert.deepEqual(ca.pending(), []);
});

test("the in-page card: only a person's click in that tab, armed, counts; its reading stops once nothing shows", async () => {
  let t = 1_000_000;
  let personNow = true;
  const page = fakePage(), other = fakePage();
  const { ca, intervals, logs } = setup({ front: page, person: () => personNow, clock: () => t });
  ca.participant("p1", { client: "codex-mcp-client", tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1" });
  const id = r.item.id;
  assert.equal(intervals.size, 1, "read while the card shows");
  const answerIn = (p, kind, at) => { p.answers = { a: { t: at, kind, what: id, next: null }, ids: id, dismissed: "" }; };
  const tick = () => sleep(400); // one POLL_MS read
  // Too soon after it showed.
  answerIn(page, "approval-allow", t + ARM_MS - 100);
  t += ARM_MS + 50;
  await tick();
  assert.equal(ca.pending().length, 1);
  // Not a person's own click (an agent acting, input replayed).
  personNow = false;
  answerIn(page, "approval-allow", t);
  await tick();
  assert.equal(ca.pending().length, 1);
  personNow = true;
  // From another tab: that page isn't read at all, and its answer wouldn't count.
  answerIn(other, "approval-allow", t);
  await tick();
  assert.equal(ca.pending().length, 1);
  assert.ok(logs.filter((l) => /didn't count/.test(l)).length >= 2);
  // A person's click.
  answerIn(page, "approval-allow", t);
  await tick();
  assert.equal(await r.answer, "allow");
  assert.deepEqual(ca.pending(), []);
  assert.ok(page.calls.some(([k, v]) => k === "approval-off" && v === id), "the card came down");
  assert.equal(intervals.size, 0, "no reading once nothing shows");
});

test("the in-page card dismissed with ×: the ask stays for the terminal, and the reading stops", async () => {
  const page = fakePage();
  const { ca, intervals } = setup({ front: page });
  ca.participant("p1", { client: "claude-code", tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "claude-code" });
  assert.equal(page.calls[0][1].terminal, true, "Claude Code: the terminal asks too");
  page.answers = { a: null, ids: "", dismissed: r.item.id };
  await sleep(400);
  assert.equal(ca.pending().length, 1);
  assert.equal(intervals.size, 0);
  ca.withdraw(r.item.id, "test");
});

test("Codex: its only card gone with no approvals page open hands the step over at once; with one open it waits", async () => {
  for (const how of ["dismissed", "navigated", "closed"]) {
    const page = fakePage();
    const { ca, intervals, logs } = setup({ front: page });
    ca.participant("p1", { client: "codex-mcp-client", tab: () => page });
    const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "codex-mcp-client" });
    if (how === "dismissed") page.answers = { a: null, ids: r.item.id, dismissed: r.item.id };
    else if (how === "navigated") page.answers = { a: null, ids: "", dismissed: "" };
    else page.closed = true;
    assert.equal(await Promise.race([r.answer, sleep(1000).then(() => "still waiting")]), "terminal", how);
    assert.deepEqual(ca.pending(), []);
    assert.equal(intervals.size, 0);
    assert.ok(logs.some((l) => /no place left to ask/.test(l)), how);
  }
  const page = fakePage();
  const { ca, lv } = setup({ front: page });
  ca.participant("p1", { client: "codex-mcp-client", tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "codex-mcp-client" });
  lv.pageClients = () => ({ approve: 1 });
  page.answers = { a: null, ids: "", dismissed: r.item.id };
  await sleep(400);
  assert.equal(ca.pending().length, 1, "the browser's approval page can still answer it");
  ca.withdraw(r.item.id, "test");
});

test("only the browser's approval page counts as a place to ask: a lone strip or right dock doesn't", async () => {
  for (const surfaces of [{ strip: 1 }, { right: 1 }, { left: 1, picker: 2 }]) {
    const { ca } = setup({ surfaces });
    assert.deepEqual(await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } }), { shown: false }, JSON.stringify(surfaces));
  }
  const { ca } = setup({ surfaces: { approve: 1 } });
  assert.equal((await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } })).shown, true);
});

test("the card's tab behind another: read each tick as the join card is, with no lookup of the tab in front", async () => {
  const page = fakePage(), other = fakePage();
  const { ca, setFront, fronts } = setup({ front: page });
  ca.participant("p1", { client: "claude-code", tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "claude-code" });
  const asked = fronts(); // open() looks once, to place the card
  setFront(other);
  const reads = () => page.calls.filter(([k]) => k === "approval-answers").length;
  await sleep(700);
  assert.ok(reads() >= 1, "one page call per tick, wherever the tab is");
  assert.equal(fronts(), asked, "the reading never asks which tab is in front");
  assert.equal(ca.pending().length, 1, "still waiting: a card on a tab behind gives no answer");
  ca.withdraw(r.item.id, "test");
});

test("someone comes to look while a card shows: every card comes down at once and the reading stops", async () => {
  for (const how of ["sharing", "guests"]) {
    for (const client of ["claude-code", "codex-mcp-client"]) {
      const page = fakePage();
      let sharing = false, guests = 0;
      const { ca, intervals, lv, logs } = setup({ front: page });
      lv.sharing = () => sharing;
      lv.guestViewers = () => guests;
      ca.participant("p1", { client, tab: () => page });
      const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client });
      assert.equal(intervals.size, 1);
      if (how === "sharing") sharing = true; else guests = 1;
      await sleep(400); // one tick
      assert.ok(page.calls.some(([k, v]) => k === "approval-off" && v === r.item.id), `${how} ${client}: the card came down`);
      assert.equal(intervals.size, 0, `${how} ${client}: no reading left running`);
      assert.ok(logs.some((l) => /someone else is looking/.test(l)));
      if (client === "claude-code") {
        assert.equal(ca.pending().length, 1, "Claude Code: the terminal still asks");
        ca.withdraw(r.item.id, "test");
      } else {
        assert.equal(await Promise.race([r.answer, sleep(500).then(() => "still waiting")]), "terminal", "Codex: handed to the user");
      }
    }
  }
});

test("cover(): every shown card comes down at once, before any tick", async () => {
  for (const client of ["claude-code", "codex-mcp-client"]) {
    const page = fakePage();
    const ticks = [], logs = [];
    // No interval ever fires here: what cover() does, it does by itself.
    const ca = createClickApprovals({
      hud: { call: async (pg, value, kind) => { pg.calls.push([kind, value]); return true; }, sparkColor: () => "#20c997", sparkPage: () => null },
      presence: { byPerson: () => true }, collaboration: { participants: new Map() },
      liveView: () => ({ sharing: () => false, guestViewers: () => 0, pageClients: () => ({}), tabIndex: async () => 0 }),
      frontPage: async () => page, log: (t) => logs.push(t),
      setInterval: (fn) => { ticks.push(fn); return { unref() {} }; }, clearInterval: () => {},
    });
    made.push(ca);
    ca.participant("p1", { client, tab: () => page });
    const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client });
    assert.equal(r.shown, true);
    assert.equal(ticks.length, 1, "the reading was set up but has not ticked");
    ca.cover();
    assert.ok(page.calls.some(([k, v]) => k === "approval-off" && v === r.item.id), `${client}: approval-off sent at once`);
    assert.ok(logs.some((l) => /someone else is looking/.test(l)));
    if (client === "claude-code") {
      assert.equal(ca.pending().length, 1, "Claude Code: the terminal still asks");
      ca.withdraw(r.item.id, "test");
    } else {
      assert.equal(await Promise.race([r.answer, sleep(100).then(() => "still waiting")]), "terminal", "Codex: handed to the user");
    }
  }
});

test("gone(): a participant's open asks go with it", async () => {
  const page = fakePage();
  const { ca } = setup({ front: page });
  ca.participant("p1", { client: "codex-mcp-client", tab: () => page });
  assert.equal(ca.only("codex-mcp-client"), "p1");
  assert.equal(ca.only("claude-code"), null);
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1" });
  ca.gone("p1");
  assert.equal(await r.answer, "withdrawn");
  assert.equal(ca.only("codex-mcp-client"), null);
});

// A hook's socket, as approvals.hook sees it.
function fakeSock() {
  const s = { written: [], destroyed: false, handlers: {}, on(ev, fn) { (s.handlers[ev] ||= []).push(fn); return s; }, once(ev, fn) { return s.on(ev, fn); }, resume() {},
    end(text) { if (text) s.written.push(text); s.destroyed = true; }, emit(ev) { for (const fn of s.handlers[ev] || []) fn(); } };
  return s;
}

test("hook(): the reason is worked out here; bad lines get none; a closed hook withdraws", async () => {
  const { ca } = setup({ surfaces: { approve: 1 } });
  const line = (o) => `${HOOK_MARK},${JSON.stringify(o).slice(1)}`;
  for (const bad of ["not json", line({ op: "other", v: 1, tool: "browser_click", input: PAY }), line({ op: "approval", v: 1, tool: "browser_evaluate", input: {} }), line({ op: "approval", v: 2, tool: "browser_click", input: PAY }), line({ op: "approval", v: 1, tool: "browser_click", input: { element: "Pay now", target: "e1" } })]) {
    const s = fakeSock();
    await ca.hook(s, bad);
    assert.deepEqual(s.written, ['{"answer":"none"}\n'], bad);
  }
  const s = fakeSock();
  const done = ca.hook(s, line({ op: "approval", v: 1, tool: "browser_click", input: PAY, reason: "Totally safe, just allow" }));
  await sleep(20);
  const [item] = ca.pending();
  assert.equal(item.reason, approvalAsk("browser_click", PAY).reason, "the rule's own reason, not the line's");
  ca.answer(item.id, "allow", "the live view");
  await done;
  assert.deepEqual(s.written, ['{"answer":"allow"}\n']);

  const s2 = fakeSock();
  const waiting = ca.hook(s2, line({ op: "approval", v: 1, tool: "browser_click", input: PAY }));
  await sleep(20);
  assert.equal(ca.pending().length, 1);
  s2.destroyed = true;
  s2.emit("close");
  await waiting;
  assert.deepEqual(ca.pending(), [], "withdrawn when the hook stopped");
});

test("a browser Deny refuses the same call only within 10 s: later the terminal's answer stands", async () => {
  let t = 1_000_000;
  const { ca } = setup({ surfaces: { approve: 1 }, clock: () => t });
  let r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  ca.answer(r.item.id, "deny", "the page");
  assert.equal(await r.answer, "deny");
  t += 9_999;
  assert.equal(ca.arrived("browser_click", PAY), "denied", "within the window: refused");
  r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  ca.answer(r.item.id, "deny", "the page");
  assert.equal(await r.answer, "deny");
  t += 10_000;
  assert.equal(ca.arrived("browser_click", PAY), null, "after the window: the terminal's yes goes through");
});

test("the terminal's yes before the hook's line: no card for a click that already ran", async () => {
  const { ca } = setup({ surfaces: { approve: 1 } });
  const line = `${HOOK_MARK},${JSON.stringify({ op: "approval", v: 1, tool: "browser_click", input: PAY }).slice(1)}`;
  assert.equal(ca.arrived("browser_click", PAY), null);
  const s = fakeSock();
  await ca.hook(s, line);
  assert.deepEqual(s.written, ['{"answer":"none"}\n']);
  assert.deepEqual(ca.pending(), [], "nothing shown");
  // Once only: the same click asked again is a new ask.
  const s2 = fakeSock();
  const waiting = ca.hook(s2, line);
  await sleep(20);
  assert.equal(ca.pending().length, 1);
  ca.answer(ca.pending()[0].id, "deny", "the live view");
  await waiting;
  assert.deepEqual(s2.written, ['{"answer":"deny"}\n']);
});

// The PairBrowse build with its own pages (docked): its approve page is the window's approval card,
// the one browser home of click approvals; the item names the tab's CDP target id for its window.
const T1 = "0123456789ABCDEF0123456789ABCDEF";
test("docked with the approval card there: no in-page card, the item names the tab's target", async () => {
  const page = fakePage();
  const asked = [];
  const { ca, logs, intervals } = setup({ front: page, surfaces: { approve: 1 }, docked: () => true, targetOf: async (p, ms) => { asked.push([p, ms]); return T1; } });
  ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "pays", target: "Place order" }, participant: "p1", client: "codex-mcp-client" });
  assert.equal(r.shown, true);
  assert.deepEqual(Object.keys(r.item).sort(), KEYS);
  assert.deepEqual(r.item.tab, { id: 2, host: "shop.example", target: T1 });
  assert.deepEqual(asked, [[page, 2000]], "asked once, bounded");
  assert.deepEqual(page.calls.filter(([k]) => k === "approval"), [], "no in-page card");
  assert.equal(intervals.size, 0, "nothing in a page to read");
  assert.match(logs.at(-1), /in the browser's approval card/);
  assert.deepEqual(ca.pending(), [r.item]);
  assert.equal(ca.answer(r.item.id, "allow", "the approval card"), true);
  assert.equal(await r.answer, "allow");
});

test("docked, the approval card not there: the in-page card as before; plain Chromium unchanged", async () => {
  for (const docked of [() => true, () => false]) {
    const page = fakePage();
    const { ca } = setup({ front: page, docked, targetOf: async () => T1 });
    ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
    const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "pays", target: "Place order" }, participant: "p1", client: "codex-mcp-client" });
    assert.equal(r.shown, true);
    assert.equal(page.calls.filter(([k]) => k === "approval").length, 1, "the in-page card");
    // The lookup only in the native build: plain Chromium never waits on it.
    assert.equal(r.item.tab.target, docked() ? T1 : "");
  }
  // Plain Chromium with its approval page open (the extension era's tab): the in-page card still shows.
  const page = fakePage();
  const { ca } = setup({ front: page, surfaces: { approve: 1 }, docked: () => false });
  ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "pays", target: "Place order" }, participant: "p1", client: "codex-mcp-client" });
  assert.equal(page.calls.filter(([k]) => k === "approval").length, 1);
  assert.equal(r.item.tab.target, "");
});

test("docked while joiners look: the approval card still asks (no in-page card either way)", async () => {
  const page = fakePage();
  const { ca } = setup({ front: page, surfaces: { approve: 1 }, sharing: true, docked: () => true, targetOf: async () => T1 });
  ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "pays", target: "Place order" }, participant: "p1", client: "codex-mcp-client" });
  assert.equal(r.shown, true);
  assert.deepEqual(page.calls, []);
  assert.equal(r.item.tab.target, T1);
});

test("the tab's target: a failed, odd or hung lookup is empty, and the ask isn't held up", async () => {
  const cases = [
    async () => { throw new Error("no CDP"); },
    async () => null,
    async () => "not a target id!",
    async () => "A".repeat(65),
    () => { throw new Error("sync throw"); },
  ];
  for (const targetOf of cases) {
    const page = fakePage();
    const { ca } = setup({ front: page, surfaces: { approve: 1 }, docked: () => true, targetOf });
    ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
    const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "codex-mcp-client" });
    assert.equal(r.shown, true);
    assert.equal(r.item.tab.target, "");
  }
  const page = fakePage();
  const { ca } = setup({ front: page, surfaces: { approve: 1 }, docked: () => true, targetOf: () => new Promise(() => {}) });
  ca.participant("p1", { client: "codex-mcp-client", remote: false, tab: () => page });
  const t0 = Date.now();
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "codex-mcp-client" });
  const took = Date.now() - t0;
  assert.ok(took >= 1900 && took < 3000, `bounded at 2 s (took ${took} ms)`);
  assert.equal(r.shown, true);
  assert.deepEqual(r.item.tab, { id: 2, host: "shop.example", target: "" });
  // No tab of the agent's own: nothing is looked up.
  let looked = 0;
  const { ca: lone } = setup({ surfaces: { approve: 1 }, docked: () => true, targetOf: async () => { looked++; return T1; } });
  const l = await lone.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" } });
  assert.equal(l.item.tab.target, "");
  assert.equal(looked, 0);
});

// An Allow is for the click in the tab it was asked in, on the origin that tab had then. A
// navigation (or another tab) between the ask and the click makes it a different click: refused,
// to be asked again. Claude Code's Allow comes back as the call itself (arrived); Codex's is
// checked by serve.mjs with the same sameWhere.
test("an Allow holds only in the same tab on the same origin", async () => {
  const { sameWhere, originOf } = await import("../scripts/daemon/approvals.mjs");
  const { ca } = setup({ surfaces: { approve: 1 } });
  let url = "https://shop.example/checkout";
  const page = fakePage();
  page.url = () => url;
  const other = fakePage("https://shop.example/checkout");
  ca.participant("p1", { client: "claude-code", tab: () => page });
  const ask = async () => { const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: "p1", client: "claude-code" }); ca.answer(r.item.id, "allow", "the page"); await r.answer; return r; };
  const r = await ask();
  assert.deepEqual(r.where, { page, origin: "https://shop.example" });
  url = "https://shop.example/checkout?step=2"; // same origin: still that click
  assert.equal(ca.arrived("browser_click", PAY, { page, url }), null);
  await ask();
  url = "https://evil.example/pay"; // the tab went to another site after Allow
  assert.equal(ca.arrived("browser_click", PAY, { page, url }), "moved");
  assert.deepEqual(ca.lastWhere(), { origin: "https://shop.example" });
  assert.equal(ca.arrived("browser_click", PAY, { page, url }), null, "used up: the next one asks again (the hook)");
  url = "https://shop.example/checkout";
  await ask();
  assert.equal(ca.arrived("browser_click", PAY, { page: other, url }), "moved", "another tab on the same address");
  await ask();
  page.closed = true;
  assert.equal(ca.arrived("browser_click", PAY, { page, url }), "moved", "the tab closed");
  assert.equal(ca.arrived("browser_click", PAY, null), null, "nothing remembered after a refusal");
  // The pure check, as serve.mjs uses it for Codex's Allow.
  page.closed = false;
  assert.equal(sameWhere({ page, origin: "https://shop.example" }, { page, url: "https://shop.example/x" }), true);
  assert.equal(sameWhere({ page, origin: "https://shop.example" }, { page, url: "https://shop.example.evil.example/" }), false);
  assert.equal(sameWhere({ page, origin: "https://shop.example" }, { page: null, url: "https://shop.example/" }), false);
  assert.equal(sameWhere(null, { page: null }), true, "asked with no tab known: nothing to hold it to");
  assert.equal(originOf("not a url"), "");
});

test("several Claude Code agents: an ask the hook can't tie to one is named as one of them, in no agent's color", async () => {
  const { ca } = setup({ surfaces: { approve: 1 } });
  ca.participant("p1", { client: "claude-code" });
  ca.participant("p2", { client: "claude-code" });
  assert.equal(ca.only("claude-code"), null);
  const r = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: null, client: "claude-code" });
  assert.equal(r.item.agent.label, "One of the Claude Code agents");
  assert.equal(r.item.agent.color, "#8699b1");
  ca.withdraw(r.item.id, "test");
  ca.gone("p2");
  const one = await ca.open({ tool: "browser_click", input: PAY, ask: { reason: "r", target: "t" }, participant: ca.only("claude-code"), client: "claude-code" });
  assert.equal(one.item.agent.label, "Alice · Codex", "one agent: its own name (the test's label for p1)");
});

// With several Claude Code agents here, the hook's ask is tied to the one whose bridge the same
// Claude Code process started (its parent among the hook's ancestors, nearest first): named and
// colored as that agent, shown on its tab.
test("several Claude Code agents: the hook's ancestors name the agent that asks", async () => {
  const { ca } = setup({ surfaces: { approve: 1 } });
  ca.participant("p1", { client: "claude-code", parent: 4001 });
  ca.participant("p2", { client: "claude-code", parent: 4002 });
  ca.participant("p3", { client: "codex", parent: 4003 });
  assert.equal(ca.whose("claude-code", [9001, 4002, 1]), "p2", "the hook's shell, then its Claude Code");
  assert.equal(ca.whose("claude-code", [9001, 4001, 4002]), "p1", "a Claude Code inside another's terminal: the inner one");
  assert.equal(ca.whose("claude-code", [9001, 4003]), null, "another app's process: no Claude Code agent of its own, and two here");
  assert.equal(ca.whose("claude-code", ["4001", -1, null]), null, "only process ids count");
  assert.equal(ca.whose("claude-code", undefined), null);
  ca.gone("p2");
  assert.equal(ca.whose("claude-code", []), "p1", "one agent: that one, as before");
  ca.participant("p4", { client: "claude-code", parent: 4001 });
  assert.equal(ca.whose("claude-code", [4001]), null, "two bridges of one process: no guess");
});

test("ancestors: the hook's parent first, then its parent's, as ps lists them", async () => {
  const { ancestors } = await import("../scripts/guard.mjs");
  const chain = await ancestors();
  assert.equal(chain[0], process.ppid);
  if (process.platform !== "win32") assert.ok(chain.length >= 2, chain.join(","));
  assert.equal(new Set(chain).size, chain.length);
});
