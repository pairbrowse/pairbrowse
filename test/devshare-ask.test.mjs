import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-devask-"));
process.env.PAIRBROWSE_TEST_TUNNEL = "direct";
const { createSharing } = await import("../scripts/daemon/sharing.mjs");

// The helper's sharing part with stand-ins for the browser, and a stand-in live view that only
// records what the side panel would get.
function sharingWith(notes) {
  const panel = [];
  let live = null;
  const fakeLive = { url: "http://127.0.0.1:1/k/", port: 1, guestPort: 2, setStatus() {}, setSession() {}, setCollaboration() {}, setDev: (s) => panel.push(s), close() {} };
  const view = { currentUrl: () => "http://localhost:5199/app", getContext: async () => ({ pages: () => [] }), status: () => ({}), session: () => null, collaboration: () => ({}), secretDomains: () => [] };
  // Notes for the host's agent, dropped like the helper's when they no longer hold (daemon.mjs).
  const hostNote = (t) => notes.push(`note: ${t}`);
  hostNote.drop = (keep) => notes.splice(0, notes.length, ...notes.filter((n) => !n.startsWith("note: ") || keep(n.slice(6))));
  const sharing = createSharing({ config: {}, log() {}, host: "Me", view, notify: (t) => notes.push(`notify: ${t}`), hostNote, startLive: async (opts) => { live = opts; return fakeLive; } });
  return { sharing, panel, live: () => live };
}

test("a join request's note for the host's agent goes when the request is answered", async () => {
  const notes = [];
  const { sharing, live } = sharingWith(notes);
  try {
    const made = await sharing.inviteCommand({ action: "create", role: "drive", share: "code", name: "Bob" }, { who: "Claude Code" });
    const inviteId = made.text.match(/Invite (\w+) for/)[1];
    const r = sharing.approvals.check({ id: inviteId, role: "drive" }, "a".repeat(32), "Alice", "claude-code");
    live().onJoinRequest(r.entry);
    assert.match(notes.join("\n"), /Alice \(Claude Code\) wants to join your session/);
    // Answered by the agent itself: the request's note is gone (it would ask the agent to answer again).
    await sharing.inviteCommand({ action: "approve", id: r.entry.id }, { who: "Claude Code" });
    assert.doesNotMatch(notes.join("\n"), /wants to join/);
    // Answered by the user (side panel, notification): the same, and the agent hears the answer.
    const r2 = sharing.approvals.check({ id: inviteId, role: "drive" }, "b".repeat(32), "Carol", "claude-code");
    live().onJoinRequest(r2.entry);
    assert.match(notes.join("\n"), /Carol \(Claude Code\) wants to join/);
    sharing.approvals.deny(r2.entry.id);
    assert.doesNotMatch(notes.join("\n"), /wants to join/);
    assert.match(notes.join("\n"), /turned Carol \(Claude Code\) away/);
  } finally { sharing.endAll?.(); }
});

test("an agent's share_port is a question in the side panel: Yes shares, No doesn't", async () => {
  const notes = [];
  const { sharing, panel } = sharingWith(notes);
  try {
    const asked = sharing.inviteCommand({ action: "share_port" }, { who: "Codex" });
    await new Promise((r) => setTimeout(r, 50));
    const ask = panel.at(-1).asks[0];
    assert.deepEqual({ port: ask.port, who: ask.who }, { port: 5199, who: "Codex" }, "the current localhost tab's port, and who asks");
    assert.match(notes.join("\n"), /Codex wants to share localhost:5199/);
    assert.equal((await sharing.inviteCommand({ action: "list" })).text, "No invites.", "nothing shared before the answer");
    await sharing.devPanel.act({ op: "answer", id: ask.id, allow: true });
    const r = await asked;
    assert.match(r.text, /Shared the dev server localhost:5199/);
    assert.match((await sharing.inviteCommand({ action: "list" })).text, /dev server localhost:5199/);
    assert.deepEqual(panel.at(-1).asks, []);

    const again = sharing.inviteCommand({ action: "share_port", port: 3000 }, { who: "Claude Code" });
    await new Promise((r) => setTimeout(r, 50));
    await sharing.devPanel.act({ op: "answer", id: panel.at(-1).asks[0].id, allow: false });
    const no = await again;
    assert.equal(no.error, true);
    assert.match(no.text, /said no: localhost:3000 stays private/);
    assert.doesNotMatch((await sharing.inviteCommand({ action: "list" })).text, /localhost:3000/);

    // The side panel's own Share and Stop act at once.
    await sharing.devPanel.act({ op: "share", port: 4000 });
    assert.match((await sharing.inviteCommand({ action: "list" })).text, /localhost:4000/);
    await sharing.devPanel.act({ op: "unshare", port: 4000 });
    assert.doesNotMatch((await sharing.inviteCommand({ action: "list" })).text, /localhost:4000/);
    assert.equal((await sharing.devPanel.act({ op: "answer", id: "nope", allow: true })).error, "That question was already answered.");
  } finally {
    sharing.stopTunnel();
  }
});
