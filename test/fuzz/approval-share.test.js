// Property-based fuzzing of a joiner's answer to the host's approval cards
// (scripts/liveview/approval-share.mjs answer, daemon/approvals.mjs answerShared): whatever body
// arrives on an approve joiner's channel, nothing throws, and an ask is answered only by an exact
// { id, answer } whose id is the one this joiner was given for it and whose answer is allow or
// deny. Nothing else (another joiner's id, a near miss, an extra key, any other shape) answers
// anything, and a joiner without the approve role answers nothing. Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createClickApprovals } from "../../scripts/daemon/approvals.mjs";
import { createApprovalShare } from "../../scripts/liveview/approval-share.mjs";
import { joinerKeyOf } from "../../scripts/liveview/joiner-server.mjs";
import { createInvites } from "../../scripts/liveview.mjs";
import { createApprovals, newJoinerId } from "../../scripts/sharing/join.mjs";
import { approvalAsk } from "../../scripts/rules/decide.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property, runs = RUNS) => fc.assert(property, { numRuns: runs });
const PAY = { element: "Pay: Place order", target: "e5" };

// One host with two joiners (approve and drive) and one ask waiting, as the live view wires them.
function host() {
  const invites = createInvites();
  const requests = createApprovals();
  const joiners = new Map();
  const views = new Map();
  const push = { broadcast: (event, data, { to }) => { if (event === "approvals") views.set(to, data); } };
  let share = null;
  const lv = { pageClients: () => ({}), approveJoiners: () => share.approvers(), sharedJoiners: () => share.inSession(), sharing: () => true, guestViewers: () => 0 };
  const hud = { call: async () => true, sparkColor: () => "#20c997", sparkPage: () => null, addActivity: () => {} };
  const ca = createClickApprovals({ hud, presence: { byPerson: () => true }, collaboration: { participants: new Map() }, liveView: () => lv, hostName: () => "Bob",
    setInterval: () => null, clearInterval: () => {} });
  share = createApprovalShare({ clickApprovals: ca, invites, joinRequests: requests, joiners, push, host: () => "Bob" });
  ca.onChange(() => share.changed());
  const tab = { url: () => "https://shop.example/checkout", isClosed: () => false };
  ca.participant("p1", { client: "codex", tab: () => tab });
  const join = (role) => {
    const inv = invites.create({ role, label: role, share: "code" });
    const joinerId = newJoinerId();
    requests.approve(requests.check(inv, joinerId, role).entry.id);
    const j = { invite: invites.match(inv.key), joinerId, name: role, seen: Date.now() };
    joiners.set(joinerKeyOf(inv.id, joinerId), j);
    share.opened(j);
    return j;
  };
  const alex = join("approve");
  const dee = join("drive");
  const viewOf = (j) => views.get(joinerKeyOf(j.invite.id, j.joinerId));
  const ask = () => ca.open({ tool: "browser_click", input: PAY, ask: approvalAsk("browser_click", PAY), client: "codex", participant: "p1" });
  return { ca, share, alex, dee, viewOf, ask };
}
const hosts = [];
after(() => { for (const h of hosts) for (const it of h.ca.pending()) h.ca.withdraw(it.id, "test over"); });

const hexId = fc.stringMatching(/^ap-[0-9a-f]{32}$/);
const scalar = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.double());

test("arbitrary bodies never throw and never answer: only the joiner's own exact { id, answer } does", async () => {
  const h = host();
  hosts.push(h);
  const r = await h.ask();
  assert.equal(r.shown, true);
  const real = h.viewOf(h.alex).items[0].id;
  const nearMiss = fc.nat({ max: 31 }).chain((i) => fc.constantFrom(..."0123456789abcdef").filter((c) => c !== real[3 + i]).map((c) => `${real.slice(0, 3 + i)}${c}${real.slice(4 + i)}`));
  const body = fc.oneof(
    fc.anything(),
    fc.record({ id: fc.oneof(hexId, nearMiss, scalar, fc.constant(real.toUpperCase()), fc.constant(` ${real}`)), answer: fc.oneof(fc.constantFrom("allow", "deny", "site", "terminal", "Allow", ""), scalar) }),
    fc.record({ id: fc.constant(real), answer: fc.oneof(fc.constantFrom("site", "terminal", "ALLOW", "allow ", "deny\n"), scalar) }),
    fc.tuple(fc.string({ minLength: 1 }).filter((k) => k !== "id" && k !== "answer"), fc.anything()).map(([k, v]) => ({ id: real, answer: "allow", [k]: v })),
    fc.constant([real, "allow"]),
  );
  check(fc.property(body, fc.constantFrom("alex", "dee"), (b, who) => {
    const out = h.share.answer(b, who === "alex" ? h.alex : h.dee);
    assert.ok(out && Number.isInteger(out.code) && out.body && typeof out.body === "object");
    assert.notEqual(out.code, 200, JSON.stringify(b));
    assert.equal(h.ca.pending().length, 1, "still waiting");
  }));
  // The exact body answers it, once; the same body again answers nothing.
  assert.equal(h.share.answer({ id: real, answer: "deny" }, h.dee).code, 403, "a drive joiner: never");
  assert.deepEqual(h.share.answer({ id: real, answer: "deny" }, h.alex), { code: 200, body: { ok: true } });
  assert.equal(await r.answer, "deny");
  assert.equal(h.share.answer({ id: real, answer: "allow" }, h.alex).code, 404);
});

test("answerShared: arbitrary ids and answers never throw; only allow or deny for the waiting ask answers it", async () => {
  const h = host();
  hosts.push(h);
  let r = await h.ask();
  let answered = 0;
  await fc.assert(fc.asyncProperty(fc.oneof(fc.anything(), hexId, fc.constant("current")), fc.oneof(fc.anything(), fc.constantFrom("allow", "deny", "site", "terminal")), fc.anything(), async (id, a, opts) => {
    const asked = id === "current" ? r.item.id : id;
    const ok = h.ca.answerShared(asked, a, opts && typeof opts === "object" ? opts : {});
    assert.equal(ok, asked === r.item.id && (a === "allow" || a === "deny"), JSON.stringify([asked, a]));
    if (ok) {
      answered++;
      assert.equal(await r.answer, a);
      r = await h.ask();
    }
    assert.equal(h.ca.pending().length, 1);
  }), { numRuns: Math.min(RUNS, 2000) });
  assert.ok(answered > 0, "the real answer was tried too");
});
