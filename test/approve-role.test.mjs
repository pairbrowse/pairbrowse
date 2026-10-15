// The approve role on the host's side: who sees the host's approval cards (approve joiners the
// asks, the others a notice), the first answer wins, an answer counts only from a joiner whose
// invite is approve right now, only for the very ask it was given, and only for the host's own
// agents' asks. Through the joiner port too: shared browser codes only, rate-limited.
import "./helpers/home.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClickApprovals } from "../scripts/daemon/approvals.mjs";
import { createApprovalShare } from "../scripts/liveview/approval-share.mjs";
import { joinerKeyOf } from "../scripts/liveview/joiner-server.mjs";
import { createInvites, startLiveView } from "../scripts/liveview.mjs";
import { createApprovals, newJoinerId } from "../scripts/join.mjs";
import { approvalAsk } from "../scripts/guard.mjs";

const PAY = { element: "Pay: Place order", target: "e5" };
const SEND = { element: "Send: Send message", target: "e9" };
const made = [];
afterEach(() => { for (const ca of made.splice(0)) for (const it of ca.pending()) ca.withdraw(it.id, "test over"); });

function setup() {
  const invites = createInvites();
  const requests = createApprovals();
  const joiners = new Map();
  const pushed = [];
  const push = { broadcast: (event, data, { to = null } = {}) => pushed.push({ to, event, data: JSON.parse(JSON.stringify(data)) }) };
  const activity = [];
  let share = null;
  const lv = { pageClients: () => ({}), approveJoiners: () => share.approvers(), sharing: () => true, guestViewers: () => 0 };
  const hud = { call: async () => true, sparkColor: () => "#20c997", sparkPage: () => null, addActivity: (text, who, page, from) => activity.push({ text, who, from }) };
  const ca = createClickApprovals({ hud, presence: { byPerson: () => true }, collaboration: { participants: new Map() }, liveView: () => lv, hostName: () => "Bob" });
  made.push(ca);
  share = createApprovalShare({ clickApprovals: ca, invites, joinRequests: requests, joiners, push, host: () => "Bob" });
  ca.onChange(() => share.changed()); // as the live view wires it
  // Someone let in with this invite, as the joiner port keeps them.
  const join = (inv, name) => {
    const joinerId = newJoinerId();
    const r = requests.check(inv, joinerId, name);
    requests.approve(r.entry.id);
    const j = { invite: invites.match(inv.key), joinerId, name, seen: Date.now() };
    joiners.set(joinerKeyOf(inv.id, joinerId), j);
    share.opened(j);
    return j;
  };
  const last = (j) => pushed.filter((p) => p.to === joinerKeyOf(j.invite.id, j.joinerId) && p.event === "approvals").at(-1)?.data;
  const ask = (input = PAY, extra = {}) => ca.open({ tool: "browser_click", input, ask: approvalAsk("browser_click", input), client: "codex", ...extra });
  return { invites, requests, joiners, pushed, activity, ca, share, join, last, ask };
}

test("approve joiners get the host's asks to answer; drive and watch joiners a notice; nobody else", async () => {
  const s = setup();
  const alex = s.join(s.invites.create({ role: "approve", label: "Alex", share: "code" }), "Alex");
  const dee = s.join(s.invites.create({ role: "drive", label: "Dee", share: "code" }), "Dee");
  const wes = s.join(s.invites.create({ role: "watch", label: "Wes", share: "code" }), "Wes");
  const fay = s.join(s.invites.create({ role: "drive", label: "Fay", share: "code", mode: "follow" }), "Fay");
  assert.equal(s.share.approvers(), 1, "one joiner can approve");
  assert.deepEqual(s.last(alex), { role: "approve", host: "Bob", items: [] });
  const r = await s.ask();
  assert.equal(r.shown, true, "an approve joiner in the session is a place to answer");
  const view = s.last(alex);
  assert.equal(view.items.length, 1);
  const item = view.items[0];
  assert.match(item.id, /^ap-[0-9a-f]{32}$/);
  assert.notEqual(item.id, r.item.id, "the joiner's own id for it, never the host's");
  assert.deepEqual(Object.keys(item).sort(), ["agent", "at", "id", "reason", "site", "target"]);
  assert.equal(item.target, "Place order");
  assert.ok(item.reason.length > 0);
  for (const j of [dee, wes]) {
    const v = s.last(j);
    assert.equal(v.role, j === dee ? "drive" : "watch");
    assert.deepEqual(v.waiting, [{ agent: r.item.agent.label, what: "Pay: Place order", site: "" }], "a notice, no id to answer with");
    assert.equal(v.items, undefined);
  }
  assert.deepEqual(s.last(fay), { role: null, host: "Bob", items: [] }, "a follow code's joiner gets nothing");
  assert.ok(!JSON.stringify(s.pushed).includes(r.item.id), "the host's own ids never cross");
});

test("first answer wins: a joiner's Allow ends the ask, names them, and the card goes for everyone", async () => {
  const s = setup();
  const alex = s.join(s.invites.create({ role: "approve", label: "Alex", share: "code" }), "Alex");
  const cat = s.join(s.invites.create({ role: "approve", label: "Cat", share: "code" }), "Cat");
  const withdrawn = [];
  s.ca.onChange((c) => { if (c.op === "withdraw") withdrawn.push(c.item); });
  const r = await s.ask();
  const id = s.last(alex).items[0].id;
  assert.deepEqual(s.share.answer({ id, answer: "allow" }, alex), { code: 200, body: { ok: true } });
  assert.equal(await r.answer, "allow");
  assert.deepEqual(withdrawn, [{ id: r.item.id, answer: "allow", by: "Alex" }], "the host's card hears who");
  assert.deepEqual(s.activity.at(-1), { text: "Allowed by Alex: Place order", who: "Alex", from: "approval" });
  assert.deepEqual(s.last(alex).items, []);
  assert.deepEqual(s.last(cat).items, [], "gone for the other approver too");
  // Cat's own id for it, a moment late: gone.
  const late = s.share.answer({ id: s.pushed.filter((p) => p.to === joinerKeyOf(cat.invite.id, cat.joinerId) && p.data.items?.length).at(-1).data.items[0].id, answer: "deny" }, cat);
  assert.equal(late.code, 404);
  // The host answers first: a joiner's answer after it is gone too, and the Activity log names the host.
  const r2 = await s.ask(SEND);
  const id2 = s.last(alex).items[0].id;
  assert.equal(s.ca.answer(r2.item.id, "deny", "the browser's approve page"), true);
  assert.equal(await r2.answer, "deny");
  assert.equal(s.share.answer({ id: id2, answer: "allow" }, alex).code, 404);
  assert.match(s.activity.at(-1).text, /^Denied by Bob: /);
});

test("an answer is bound to the joiner and the ask: another's id, another ask's, a bad shape count for nothing", async () => {
  const s = setup();
  const alex = s.join(s.invites.create({ role: "approve", label: "Alex", share: "code" }), "Alex");
  const cat = s.join(s.invites.create({ role: "approve", label: "Cat", share: "code" }), "Cat");
  const pay = await s.ask(PAY);
  const send = await s.ask(SEND);
  const alexIds = s.last(alex).items.map((i) => i.id);
  const catIds = s.last(cat).items.map((i) => i.id);
  assert.equal(new Set([...alexIds, ...catIds]).size, 4, "each joiner, each ask: an id of its own");
  // Alex's id sent on Cat's channel: nothing.
  assert.equal(s.share.answer({ id: alexIds[0], answer: "allow" }, cat).code, 404);
  for (const bad of [null, [], { id: alexIds[0] }, { id: alexIds[0], answer: "site" }, { id: alexIds[0], answer: "terminal" }, { id: "ap-x", answer: "allow" }, { id: alexIds[0], answer: "allow", also: 1 }]) {
    assert.equal(s.share.answer(bad, alex).code, 400, JSON.stringify(bad));
  }
  // Alex's answer for the send ask leaves the pay ask waiting.
  const sendId = s.last(alex).items.find((i) => i.target === "Send message").id;
  assert.equal(s.share.answer({ id: sendId, answer: "deny" }, alex).code, 200);
  assert.equal(await send.answer, "deny");
  assert.equal(s.ca.pending().length, 1);
  assert.equal(s.ca.pending()[0].id, pay.item.id);
});

test("the role is read again at every answer: revoked, back to drive or taken out, the answer is refused", async () => {
  const s = setup();
  const inv = s.invites.create({ role: "approve", label: "Alex", share: "code" });
  const alex = s.join(inv, "Alex");
  const r = await s.ask();
  const id = s.last(alex).items[0].id;
  // Back to drive: no cards, a notice instead; the old id answers nothing.
  s.invites.setRole(inv.id, "drive");
  s.share.changed();
  assert.equal(s.last(alex).role, "drive");
  assert.equal(s.last(alex).waiting.length, 1);
  assert.equal(s.share.answer({ id, answer: "allow" }, alex).code, 403);
  assert.equal(s.share.approvers(), 0);
  // Approve again: the same ask, answerable.
  s.invites.setRole(inv.id, "approve");
  s.share.changed();
  assert.equal(s.last(alex).items[0].id, id, "the same id for the same ask");
  // Taken out (Remove): refused.
  const reqId = s.requests.get(inv.id, alex.joinerId).id;
  s.requests.remove(reqId);
  assert.equal(s.share.answer({ id, answer: "allow" }, alex).code, 403);
  // Revoked: refused, and nobody is left to answer.
  s.requests.approve(reqId); // (a removed one never comes back: still refused)
  assert.equal(s.share.answer({ id, answer: "allow" }, alex).code, 403);
  const bea = s.join(s.invites.create({ role: "approve", label: "Bea", share: "code" }), "Bea");
  const beaId = s.last(bea).items[0].id;
  s.invites.revoke(bea.invite.id);
  assert.equal(s.share.answer({ id: beaId, answer: "allow" }, bea).code, 403);
  assert.equal(s.ca.pending().length, 1, "still waiting");
  s.ca.withdraw(r.item.id, "test");
});

test("a joiner's own agent's asks never reach the approvers, and answerShared refuses them", async () => {
  const s = setup();
  const alex = s.join(s.invites.create({ role: "approve", label: "Alex", share: "code" }), "Alex");
  s.ca.participant("p-remote", { client: "claude-code", remote: true });
  const r = await s.ask(PAY, { participant: "p-remote" });
  assert.equal(r.shown, true);
  assert.deepEqual(s.last(alex).items, [], "not shared");
  assert.equal(s.ca.answerShared(r.item.id, "allow", { by: "Alex" }), false);
  assert.equal(s.ca.pending().length, 1);
});

// ---- through the joiner port ----
function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
const who = (id, name) => ({ "x-pairbrowse-joiner": id, "x-pairbrowse-name": name, "x-pairbrowse-app": "claude-code" });

test("the joiner port's approval route: shared browser codes only, approve only, rate-limited, never before approval", async () => {
  const invites = createInvites();
  let view = null;
  const hud = { call: async () => true, sparkColor: () => "#20c997", sparkPage: () => null, addActivity: () => {} };
  const ca = createClickApprovals({ hud, presence: { byPerson: () => true }, collaboration: { participants: new Map() }, liveView: () => view, hostName: () => "Bob" });
  made.push(ca);
  view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, tunnelHost: () => "quiet-river.trycloudflare.com", clickApprovals: ca });
  try {
    const gport = view.guestPort;
    const a = invites.create({ role: "approve", label: "Alex", share: "code" });
    const f = invites.create({ role: "drive", label: "Fay", share: "code", mode: "follow" });
    const d = invites.create({ role: "drive", label: "Dee", share: "code" });
    const alex = newJoinerId(), fay = newJoinerId(), dee = newJoinerId();
    const body = { id: `ap-${"0".repeat(32)}`, answer: "allow" };
    // Before the host lets them in: a join request, nothing else.
    assert.equal((await request(gport, "POST", `/${a.key}/approval`, { headers: who(alex, "Alex"), body })).json?.waiting, true);
    for (const [k, id, name] of [[f.key, fay, "Fay"], [d.key, dee, "Dee"]]) await request(gport, "POST", `/${k}/approval`, { headers: who(id, name), body });
    for (const e of view.approvals.pending()) view.approvals.approve(e.id);
    assert.equal((await request(gport, "POST", `/${f.key}/approval`, { headers: who(fay, "Fay"), body })).status, 403, "a follow code");
    assert.equal((await request(gport, "POST", `/${d.key}/approval`, { headers: who(dee, "Dee"), body })).status, 403, "a drive code");
    assert.equal(view.approveJoiners(), 0, "not seen yet");
    assert.equal((await request(gport, "POST", `/${a.key}/approval`, { headers: who(alex, "Alex"), body })).status, 404, "nothing waits");
    assert.equal(view.approveJoiners(), 1);
    assert.equal((await request(gport, "POST", `/${a.key}/approval`, { headers: who(alex, "Alex"), body: "{" })).status, 400);
    assert.equal((await request(gport, "POST", `/${a.key}/approval`, { headers: who(alex, "Alex"), body: { ...body, pad: "x".repeat(1200) } })).status, 413);
    // At most 10 a minute.
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await request(gport, "POST", `/${a.key}/approval`, { headers: who(alex, "Alex"), body })).status === 429) limited++;
    assert.ok(limited >= 3, `rate-limited (${limited})`);
    // The owner key never works there.
    assert.equal((await request(gport, "POST", `/${view.url.split("/").at(-2)}/approval`, { headers: who(alex, "Alex"), body })).status, 404);
  } finally {
    view.close();
  }
});

// ---- a joiner's side ----
function joinerSide({ docked = false, surfaces = {}, person = () => true, sharing = false } = {}) {
  let t = 1_000_000;
  const sent = [];
  const pages = [];
  const page = () => { const p = { calls: [], answers: null, closed: false, isClosed: () => p.closed, url: () => "chrome-extension://x/screen/index.html#a" }; pages.push(p); return p; };
  const screen = {
    pages: () => pages,
    call: async (p, arg, kind) => {
      p.calls.push([kind, arg]);
      if (kind === "approval") return true;
      if (kind === "approval-answers") { const a = p.answers; p.answers = null; return a || { a: null, ids: p.calls.filter(([k]) => k === "approval").map(([, v]) => v.id).filter((id) => !p.calls.some(([k, x]) => k === "approval-off" && x === id)).join(","), dismissed: "" }; }
      return true;
    },
  };
  const lv = { pageClients: () => surfaces, sharing: () => sharing, guestViewers: () => 0 };
  const intervals = new Set();
  const hud = { call: async () => true, sparkColor: () => "#20c997", sparkPage: () => null };
  const ca = createClickApprovals({ hud, presence: { byPerson: person }, collaboration: { participants: new Map() }, liveView: () => lv, docked: () => docked, now: () => t,
    screen, sendAnswer: async (id, answer) => { sent.push({ id, answer }); return { code: 200, body: { ok: true } }; },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); intervals.add(h); return h; }, clearInterval: (h) => { intervals.delete(h); clearInterval(h); } });
  made.push(ca);
  return { ca, sent, page, pages, intervals, tick: (ms) => { t += ms; }, now: () => t };
}
const hostAsk = (id = `ap-${"a".repeat(32)}`) => ({ id, agent: { label: "Claude Code", color: "#e9763f" }, target: "Place order", reason: '"Pay: Place order" pays: a final action (pay)', site: "shop.example", at: 1 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a joiner's side: the host's ask on the picture pages, Allow by a person's click goes back on the channel", async () => {
  const s = joinerSide();
  const p = s.page();
  const changes = [];
  s.ca.onChange((c) => changes.push(c));
  s.ca.fromHost({ host: "Bob", items: [hostAsk()] });
  await wait(20);
  const shown = p.calls.find(([k]) => k === "approval")?.[1];
  assert.deepEqual(shown, { id: hostAsk().id, who: "Bob's Claude Code", color: "#e9763f", target: "Place order", reason: hostAsk().reason, site: "shop.example", host: "Bob" });
  assert.equal(changes[0].op, "add");
  assert.equal(changes[0].item.from, "Bob", "the approve page hears whose ask it is");
  assert.equal(changes[0].item.agent.label, "Bob's Claude Code");
  // Too soon after it showed: refused, nothing sent.
  p.answers = { a: { kind: "approval-allow", what: hostAsk().id, t: s.now() + 100 }, ids: hostAsk().id, dismissed: "" };
  s.tick(150);
  await wait(400);
  assert.deepEqual(s.sent, []);
  s.tick(1000);
  p.answers = { a: { kind: "approval-allow", what: hostAsk().id, t: s.now() }, ids: hostAsk().id, dismissed: "" };
  await wait(400);
  assert.deepEqual(s.sent, [{ id: hostAsk().id, answer: "allow" }]);
  assert.ok(p.calls.some(([k, v]) => k === "approval-off" && v === hostAsk().id), "the card goes here at once");
  assert.deepEqual(s.ca.pending(), []);
  // The host still lists it a moment: not shown again.
  s.ca.fromHost({ host: "Bob", items: [hostAsk()] });
  assert.deepEqual(s.ca.pending(), []);
  s.ca.fromHost({ host: "Bob", items: [] });
});

test("a joiner's side: not a person's click (an agent here acting) counts for nothing; the host ending it takes the card down", async () => {
  const s = joinerSide({ person: () => false });
  const p = s.page();
  s.ca.fromHost({ host: "Bob", items: [hostAsk()] });
  await wait(20);
  s.tick(1000);
  p.answers = { a: { kind: "approval-allow", what: hostAsk().id, t: s.now() }, ids: hostAsk().id, dismissed: "" };
  await wait(400);
  assert.deepEqual(s.sent, [], "an agent's click never answers");
  assert.equal(s.ca.pending().length, 1);
  // Answered on the host's side (or by another approver): gone here.
  s.ca.fromHost({ host: "Bob", items: [] });
  assert.deepEqual(s.ca.pending(), []);
  assert.ok(p.calls.some(([k]) => k === "approval-off"));
  // Out of the session: everything goes.
  s.ca.fromHost({ host: "Bob", items: [hostAsk(`ap-${"b".repeat(32)}`)] });
  s.ca.fromHost(null);
  assert.deepEqual(s.ca.pending(), []);
  await wait(350);
  assert.equal(s.intervals.size, 0, "nothing left reading");
});

test("a joiner's side: the browser's own approval card is the place when it's there; the approve page's answers go to the host; × only hides", async () => {
  const s = joinerSide({ docked: true, surfaces: { approve: 1 } });
  const p = s.page();
  s.ca.fromHost({ host: "Bob", items: [hostAsk(), hostAsk(`ap-${"c".repeat(32)}`)] });
  await wait(20);
  assert.equal(p.calls.filter(([k]) => k === "approval").length, 0, "no card on the picture pages: the bubble lists it");
  assert.equal(s.ca.pending().length, 2);
  assert.equal(s.ca.answer(hostAsk().id, "site", "the live view"), true, "the bubble's answer");
  await wait(10);
  assert.deepEqual(s.sent, [{ id: hostAsk().id, answer: "allow" }], "site is a plain allow");
  assert.equal(s.ca.answer(`ap-${"c".repeat(32)}`, "terminal", "the live view"), true);
  await wait(10);
  assert.equal(s.sent.length, 1, "hidden here only: nothing sent");
  assert.deepEqual(s.ca.pending(), []);
  // Nobody can answer the host's ask as if it were this side's own.
  assert.equal(s.ca.answerShared(`ap-${"c".repeat(32)}`, "allow", { by: "x" }), false);
  assert.equal(s.ca.arrived("browser_click", PAY), null);
});

test("a joiner's side: no card on the picture pages while someone else looks at this browser", async () => {
  const s = joinerSide({ sharing: true });
  const p = s.page();
  s.ca.fromHost({ host: "Bob", items: [hostAsk()] });
  await wait(400);
  assert.equal(p.calls.filter(([k]) => k === "approval").length, 0);
  assert.equal(s.ca.pending().length, 1, "still listed for this browser's own approve page");
  s.ca.fromHost(null);
});
