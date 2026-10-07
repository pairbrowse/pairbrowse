import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteAgents } from "../scripts/daemon/remote-agents.mjs";

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

test("remote agents: a joiner who leaves never hands their connection (participant) to whoever comes next", async () => {
  const served = [];
  const agents = createRemoteAgents({ serve: async (d) => { served.push(d); }, dir: mkdtempSync(join(tmpdir(), "pb-ra-")) });
  const who = { name: "Dee", key: "inv:dee", app: "claude-code" };
  assert.ok(agents.line(who, "a1", init, () => {}));
  assert.equal(served.length, 1);
  // Gone: their connection ends; the next message in the same slot starts a fresh participant,
  // even before the old one's close event ran.
  agents.stop(who.key);
  assert.ok(served[0].destroyed);
  agents.line(who, "a1", init, () => {});
  assert.equal(served.length, 2, "a new connection, not the old one");
  await new Promise((r) => setImmediate(r));
  // The old one's close must not drop the new one from its slot.
  agents.line(who, "a1", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), () => {});
  assert.equal(served.length, 2, "the newer connection kept its place");
  agents.stop(who.key);
});
