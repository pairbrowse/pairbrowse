import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-share-"));
process.env.PAIRBROWSE_TEST_TUNNEL = "direct";
delete process.env.PAIRBROWSE_PARTICIPANT;
const { createSharing } = await import("../scripts/daemon/sharing.mjs");

// The helper's sharing part with stand-ins for the browser and a stand-in live view that keeps
// what it was started with (the Share card's makeInvite among it).
function sharingWith(config = {}) {
  let live = null;
  const logs = [];
  const fakeLive = { url: "http://127.0.0.1:1/k/", port: 1, guestPort: 2, setStatus() {}, setSession() {}, setCollaboration() {}, setDev() {}, close() {} };
  const view = { currentUrl: () => "about:blank", getContext: async () => ({ pages: () => [] }), status: () => ({}), session: () => null, collaboration: () => ({}), secretDomains: () => [] };
  const hostNote = () => {};
  hostNote.drop = () => {};
  const sharing = createSharing({ config, log: (l) => logs.push(String(l)), host: "Me", view, notify() {}, hostNote, startLive: async (opts) => { live = opts; return fakeLive; } });
  return { sharing, live: () => live, logs };
}

test("the Share card makes invites through the same code as pairbrowse_invite create", async () => {
  const { sharing, live, logs } = sharingWith();
  try {
    await sharing.ensureLiveView();
    const makeInvite = live().makeInvite;
    assert.equal(typeof makeInvite, "function", "the live view gets the card's invite maker");

    const no = await makeInvite({ share: "code" });
    assert.equal(no.needName, true);
    assert.match(no.error, /^Not yet: ask the user what name/, "the tool's own refusal text");
    assert.equal(no.code, undefined);
    assert.equal((await sharing.inviteCommand({ action: "list" })).text, "No invites.", "nothing made on a refusal");

    const made = await makeInvite({ share: "code", name: "Bob" });
    assert.equal(made.ok, true);
    assert.deepEqual({ share: made.share, role: made.role, mode: made.mode }, { share: "code", role: "drive", mode: "shared" });
    assert.match(made.code, /^pb-join:/);
    assert.match(made.rights, /^Shared browser: they work in this browser itself/);
    assert.match(made.hint, /^The person pastes it into their own PairBrowse/);
    assert.match(made.id, /^[0-9a-f]{8}$/);
    assert.match((await sharing.inviteCommand({ action: "list" })).text, new RegExp(`- ${made.id}: .*can drive, join code \\(shared browser\\)`), "the same store as the tool's");

    const link = await makeInvite({ share: "link" });
    assert.equal(link.ok, true);
    assert.deepEqual({ share: link.share, role: link.role }, { share: "link", role: "watch" });
    assert.match(link.link, /^http:\/\/127\.0\.0\.1:1\/[0-9a-f]{64}\/$/);
    assert.equal(link.code, undefined);
    assert.match(link.rights, /not click, type/);

    assert.equal((await makeInvite({ share: "drive" })).error, "Choose a join code or a watch link.");
    assert.equal((await makeInvite({ role: "drive" })).error, "Choose a join code or a watch link.", "only the card's two choices");

    // The tool's own output keeps its shape.
    const tool = await sharing.inviteCommand({ action: "create", role: "drive", share: "code" }, { who: "Claude Code" });
    assert.equal(tool.error, undefined);
    assert.match(tool.text, /^Invite [0-9a-f]{8} for .+ \(drive\), until .+\. Shared browser: /);
    assert.match(tool.text, /\nJoin code: pb-join:\S+\nThe person pastes it/);
    assert.match(tool.text, /\nGive the code to the user to send; don't paste it into any web page\. Revoke it with pairbrowse_invite revoke when they're done\.$/);
    assert.equal(Object.keys(tool).join(), "text");

    const key = link.link.split("/").at(-2);
    assert.equal(logs.some((l) => l.includes(key) || l.includes(made.code)), false, "neither the link nor the code is logged");
  } finally { sharing.endAll(); }
});
