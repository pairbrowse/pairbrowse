// The host's approval cards, for the people who joined with a shared browser code (the approve
// role, liveview/invites.mjs). A joiner with approve gets each of this helper's own agents' asks
// on their channel (who asks, the button, the rule's reason, the site) and may answer it in their
// own browser; the first answer wins, the host's or any approve joiner's, and the card goes for
// everyone else (daemon/approvals.mjs). Drive and watch joiners get a notice only ("Waiting for
// <host> to approve"), never a way to answer.
//
// An answer counts only when, at the moment it arrives on that joiner's own channel (their invite's
// key, liveview/joiner-server.mjs): the invite still exists, still shares this browser and is
// approve now (read again, never as it was when the channel opened), the joiner is still let in,
// and it names an ask by the id this joiner was given for it. Each joiner gets its own id for each
// ask, an HMAC of their key, the ask's id and its call under a key that never leaves this helper,
// so an id seen by one joiner (or any other ask's) answers nothing for another, and nothing but
// that very call. Their own agent's asks are never here (approvals.mjs shareable).
import { createHmac, randomBytes } from "node:crypto";
import { joinerKeyOf, recentlySeen } from "./joiner-server.mjs";
import { roleOf } from "./invites.mjs";
import { cleanName } from "../join.mjs";

const ALIAS = /^ap-[0-9a-f]{32}$/;
const ANSWERS = new Set(["allow", "deny"]);

// clickApprovals: daemon/approvals.mjs (shareable, answerShared). invites: the invite store.
// joinRequests: who asked to join (join.mjs createApprovals: get). joiners: the live view's map.
// push: the joiners' channels (liveview/push.mjs broadcast). host(): the host's name.
export function createApprovalShare({ clickApprovals, invites, joinRequests, joiners, push, host = () => "The host", log = () => {}, random = randomBytes }) {
  const secret = random(32);
  const keyOf = (j) => joinerKeyOf(j.invite.id, j.joinerId);
  const aliasFor = (key, it) => `ap-${createHmac("sha256", secret).update(`${key}\0${it.id}\0${it.bind}`).digest("hex").slice(0, 32)}`;
  const sent = new Map(); // joiner key -> the last view sent (as JSON), so nothing goes twice

  // Where joiner j stands now: null (out, or not a shared browser code), else their role.
  function standing(j) {
    if (!j || joiners.get(keyOf(j)) !== j) return null;
    const inv = invites.get(j.invite.id);
    if (!inv || inv.share !== "code" || inv.mode !== "shared") return null;
    if (joinRequests?.get?.(j.invite.id, j.joinerId)?.state !== "approved") return null;
    return roleOf(inv);
  }

  // What joiner j sees: approve: the asks to answer; drive or watch: what waits, to read only.
  function viewFor(j) {
    const role = standing(j);
    if (!role) return null;
    const key = keyOf(j);
    const asks = clickApprovals?.shareable?.() || [];
    const name = String(host() || "The host").slice(0, 40);
    if (role === "approve") {
      return { role, host: name, items: asks.map((it) => ({ id: aliasFor(key, it), agent: { label: it.agent.label, color: it.agent.color }, target: it.target, reason: it.reason, site: it.tab.host, at: it.at })) };
    }
    return { role, host: name, waiting: asks.map((it) => ({ agent: it.agent.label, what: it.what || it.target, site: it.tab.host })) };
  }

  function sendTo(j, force = false) {
    const key = keyOf(j);
    const view = viewFor(j) || { role: null, host: String(host() || ""), items: [] };
    const sig = JSON.stringify(view);
    if (!force && sent.get(key) === sig) return;
    sent.set(key, sig);
    push.broadcast("approvals", view, { to: key });
  }

  return {
    // An approved joiner's channel opened: what waits now, at once.
    opened(j) { sendTo(j, true); },
    // An ask came or went, a role changed, someone was let in or taken out: everyone, again.
    changed() {
      for (const k of sent.keys()) if (!joiners.has(k)) sent.delete(k);
      for (const j of joiners.values()) sendTo(j);
    },
    // Joiners with the approve role in a shared browser session now (approvals.mjs surface).
    approvers() {
      let n = 0;
      for (const j of joiners.values()) if (recentlySeen(j) && standing(j) === "approve") n++;
      return n;
    },
    // One answer from joiner j's channel ({ id, answer }). Returns { code, body }.
    answer(body, j) {
      const role = standing(j);
      if (!role) return { code: 403, body: { error: "Only someone in a shared browser session can answer the host's approvals." } };
      if (role !== "approve") return { code: 403, body: { error: "Your invite can't answer the host's approvals (any more)." } };
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "id" && k !== "answer")) return { code: 400, body: { error: "An answer is { id, answer }." } };
      if (typeof body.id !== "string" || !ALIAS.test(body.id) || !ANSWERS.has(body.answer)) return { code: 400, body: { error: "An answer is { id, answer: \"allow\" | \"deny\" }." } };
      const key = keyOf(j);
      const it = (clickApprovals?.shareable?.() || []).find((x) => aliasFor(key, x) === body.id);
      if (!it) return { code: 404, body: { gone: true, error: "That request is gone (answered, or it timed out)." } };
      const by = cleanName(j.name);
      if (!clickApprovals.answerShared(it.id, body.answer, { by })) return { code: 404, body: { gone: true, error: "That request is gone (answered, or it timed out)." } };
      log(`approval: ${body.answer} by ${by}, who joined with invite ${j.invite.id} (can approve)`);
      return { code: 200, body: { ok: true } };
    },
  };
}
