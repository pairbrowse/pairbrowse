// The owner's own routes on the owner's port: people asking to join and named final clicks
// (approve), dev servers and join code addresses, the Profile panel, the goal log, invites, and
// recording. startLiveView (liveview.mjs) mounts them.
import { basename } from "node:path";
import { APPROVAL_ID, ANSWERS } from "../../daemon/approvals.mjs";
import { scrub } from "../../daemon/diagnostics.mjs";
import { json, plain, readJsonBody, NOT_JSON, BODY_MAX } from "../http.mjs";
import { roleOf } from "../invites.mjs";

const INVITE_ID = /^[0-9a-f]{8}$/;
// The invites as Settings lists them (GET invites.json, the invites event): never a key or a code.
// role: "watch", "drive" or "approve" (roleOf); mode: a join code's ("shared" or "follow"), else "".
// watching: a watch link's pages open now (watchingOf(id)), on watch links only.
export const inviteItems = (list, watchingOf = () => 0) => list.map((i) => ({ id: i.id, role: roleOf(i), label: i.label, share: i.share, mode: i.share === "code" ? i.mode : "", expires: i.expiresAt, ...(i.share === "watch" ? { watching: watchingOf(i.id) } : {}) }));

// approvals: who asked to join (createApprovals). clickApprovals: named final clicks, or null.
// joiners, push, stopJoinerKey(key), collaborationChanged(): the live view's joiners. devPanel,
// joinHost, profile, journal, makeInvite: the helper's parts, or null. invites: the invite store.
// broadcast(event, data), log. onRecord(on), recordState(), tools, mask: recording.
export function createOwnerRoutes({ approvals, clickApprovals, joiners, push, stopJoinerKey, collaborationChanged, log, devPanel, joinHost, profile, journal, invites, makeInvite, broadcast, onRecord, tools, mask, recordState, watchingOf = () => 0, invitesChanged = () => broadcast("invites", { items: inviteItems(invites.list(), watchingOf) }) }) {
  async function changeProfile({ req, res }) {
    const op = await readJsonBody(req, res, BODY_MAX.profile, { object: true });
    if (op === undefined) return;
    let error = null;
    if (op.op === "setDetail") error = profile.setDetail(op.label, op.value);
    else if (op.op === "forgetDetail") profile.forgetDetail(String(op.label || ""));
    else if (op.op === "setSecret") error = profile.setSecret({ name: op.name, value: op.value, domains: op.domains });
    else if (op.op === "deleteSecret") error = profile.deleteSecret(String(op.name || "")) || null;
    else error = "Unknown change.";
    const summary = profile.get();
    if (!error) broadcast("profile", summary);
    json(res, 200, { error, profile: summary });
  }

  return [
    // People asking to join with a code, for the owner to let in or not.
    { method: "GET", path: "joins.json", right: "approve", handler: ({ res }) => json(res, 200, approvals.pending()) },
    // Named final clicks waiting for an answer (daemon/approvals.mjs), for the owner only: the
    // browser's own pages list them and answer with POST approve { id, answer }.
    { method: "GET", path: "approvals.json", right: "approve", needs: () => clickApprovals, handler: ({ res }) => json(res, 200, { pending: clickApprovals.pending() }) },
    { method: "POST", path: "approve", right: "approve", handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, BODY_MAX.approve);
      if (given === undefined) return;
      if (given && typeof given === "object" && typeof given.answer === "string") {
        if (!(typeof given.id === "string" && APPROVAL_ID.test(given.id) && ANSWERS.has(given.answer))) return json(res, 400, { error: "An approval answer is { id, answer: allow, deny, terminal or site }." });
        if (!clickApprovals) return plain(res, 404);
        const ok = clickApprovals.answer(given.id, given.answer, "the live view");
        return json(res, ok ? 200 : 404, { ok });
      }
      const op = given;
      if (!op || typeof op !== "object" || Array.isArray(op)) return json(res, 400, { error: NOT_JSON });
      if (op.remove === true) {
        // Remove, after a yes: out at once (their channel, pictures and agent), and not back in.
        const gone = approvals.remove(op.id);
        if (!gone) return json(res, 404, { ok: false });
        joiners.delete(gone.key);
        push.end(gone.key);
        // By key: their agent may still be at work here after their own entry went.
        await stopJoinerKey(gone.key).catch(() => {});
        collaborationChanged();
        const { key: _k, ...request } = gone;
        return json(res, 200, { ok: true, request });
      }
      const done = op.allow === true ? approvals.approve(op.id) : approvals.deny(op.id);
      log(`join request ${String(op.id).slice(0, 12)}: ${op.allow === true ? "Allow" : "Deny"} from the side panel or a notification${done ? "" : ", but it wasn't waiting any more"}`);
      json(res, done ? 200 : 404, { ok: !!done, request: done });
    } },
    // Dev servers (devshare.mjs), for the owner only: what's open on localhost and shared, an
    // agent's question to share one; and the owner's answer, Share or Stop (a real click).
    { method: "POST", path: "dev", right: "approve", needs: () => devPanel, handler: async ({ req, res }) => {
      const v = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (v === undefined) return;
      const r = await devPanel.act(v);
      json(res, r.error ? 409 : 200, r);
    } },
    // A join code whose address this person hasn't allowed (daemon/follow.mjs): their Allow once,
    // Always allow or Cancel, and Remove for an allowed address. The owner only (the side panel,
    // the session picker), with a real click; agents have no tool for it.
    { method: "POST", path: "joinhost", right: "approve", needs: () => joinHost, handler: async ({ req, res }) => {
      const v = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (v === undefined) return;
      const r = await joinHost.act(v);
      json(res, r.error ? 409 : 200, r);
    } },
    // The Profile panel: remembered details in full, passwords by name and sites only.
    { method: "GET", path: "profile.json", right: "profile", needs: () => profile, handler: ({ res }) => json(res, 200, profile.get()) },
    { method: "POST", path: "profile", right: "profile", needs: () => profile, handler: changeProfile },
    // The Timeline: the goal log's lines (journal.mjs read, masked again there), read when the
    // owner opens it or presses Refresh; null while no run is open.
    { method: "GET", path: "journal.json", right: "journal", needs: () => journal, handler: ({ req, res }) => {
      // ?before=<n>: the page of done lines before index n (the checklist's older steps).
      const b = new URL(req.url, "http://x").searchParams.get("before");
      json(res, 200, journal(/^\d{1,6}$/.test(b || "") ? { before: Number(b) } : {}) ?? null);
    } },
    // The Share card (the side panel, the live view toolbar): the owner makes a join code or a
    // watch link with a real click, through the helper's own invite code. The code or link is in
    // this answer only: never broadcast, logged or kept in state.json.
    // { op: "revoke", id } (Settings' Invites, Revoke): that invite stops at once, as with
    // pairbrowse_invite revoke (anyone using it is out; a join code's tunnel goes with the last code).
    // { op: "stop_watch" } (the side panel's and the Handoff page's Stop all): every watch link
    // stops at once (their pages go dark; the public tunnel stops with the last of them).
    // { op: "role", id, role: "drive" | "approve" } (Settings' Invites): a shared browser code
    // switched between drive and approve, as with pairbrowse_invite set_role; the owner's click
    // is the OK approve needs. A joiner losing approve loses their cards at once (the role is
    // read again at every answer).
    { method: "POST", path: "invite", right: "invite", handler: async ({ req, res }) => {
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (op && typeof op === "object" && !Array.isArray(op) && op.op !== undefined) {
        if (op.op === "role") {
          if (Object.keys(op).some((k) => k !== "op" && k !== "id" && k !== "role") || (op.role !== "drive" && op.role !== "approve")) return json(res, 409, { error: 'A role change is { op: "role", id, role: "drive" | "approve" }.' });
          if (typeof op.id !== "string" || !INVITE_ID.test(op.id)) return json(res, 409, { error: "id is an invite's id, as invites.json lists it." });
          if (!invites.get(op.id)) return json(res, 404, { error: "No such invite (it may have expired or been revoked already). Reload the invite list." });
          let i;
          try { i = invites.setRole(op.id, op.role); } catch (e) { return json(res, 409, { error: e.message }); }
          log(`invite ${op.id} set to ${roleOf(i)} from PairBrowse's settings`);
          json(res, 200, { ok: true, id: i.id, role: roleOf(i) });
          invitesChanged();
          return;
        }
        if (op.op === "stop_watch") {
          if (Object.keys(op).some((k) => k !== "op")) return json(res, 409, { error: 'A stop of every watch link is { op: "stop_watch" }.' });
          const n = invites.revokeShare("watch");
          log(`${n} watch link(s) stopped from PairBrowse's side panel or settings`);
          return json(res, 200, { ok: true, stopped: n });
        }
        if (op.op !== "revoke" || Object.keys(op).some((k) => k !== "op" && k !== "id")) return json(res, 409, { error: 'An invite change is { op: "revoke", id } or { op: "role", id, role }.' });
        if (typeof op.id !== "string" || !INVITE_ID.test(op.id)) return json(res, 409, { error: "id is an invite's id, as invites.json lists it." });
        if (!invites.revoke(op.id)) return json(res, 404, { error: "No such invite (it may have expired or been revoked already). Reload the invite list." });
        log(`invite ${op.id} revoked from PairBrowse's settings`);
        return json(res, 200, { ok: true, id: op.id });
      }
      if (!makeInvite) return plain(res, 404);
      if (!op || typeof op !== "object" || Array.isArray(op)) return json(res, 409, { error: "Choose a join code or a watch link." });
      const { share, role, name, label, hours } = op; // role: "approve" makes an approve code (the Share card's third choice)
      const r = await makeInvite({ share, role, name, label, hours });
      json(res, r?.error ? 409 : 200, r);
      if (!r?.error) invitesChanged();
    } },
    // The invites out now, for Settings (Sharing, Invites): id, role, label, link or code, when it
    // ends (epoch ms). Never a key, a code or a link.
    { method: "GET", path: "invites.json", right: "invite", handler: ({ res }) => json(res, 200, { items: inviteItems(invites.list(), watchingOf) }) },
    // Record (the side panel): the browser as a video, saved in Downloads. The owner only.
    { method: "POST", path: "record", right: "record", handler: async ({ req, res }) => {
      const v = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (v === undefined) return;
      const r = await onRecord(v.on === true);
      // The file's name, never its folder or path (the Recordings list opens it by id).
      const item = r?.path ? tools?.recordings?.itemFor?.(r.path) || null : null;
      // The recorder's own sentence (no page text in it): masked, its folders hidden, its quotes kept.
      const text = r?.error ? scrub(r?.text || "", { mask, quotes: false }) : r?.path ? `Saved the recording as "${basename(r.path)}" in your downloads folder.` : "Recording the browser.";
      json(res, r?.error ? 409 : 200, { ...recordState(), text, ...(item ? { item } : {}) });
    } },
  ];
}
