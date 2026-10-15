import "./helpers/home.mjs";
// The tool server's wire (scripts/daemon/serve/wire.mjs): only well-formed JSON-RPC 2.0 messages
// go on to the browser server, with only the fields it knows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wellFormed, containsRef, urlIn, withDialogLabel } from "../scripts/daemon/serve/wire.mjs";
import * as serve from "../scripts/daemon/serve.mjs";

test("wellFormed keeps a call's known fields and drops what the server can't read", () => {
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" }, extra: 1 }), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", method: "notifications/initialized" }), { jsonrpc: "2.0", method: "notifications/initialized" });
  for (const bad of [null, [], "x", { jsonrpc: "1.0", id: 1, method: "m" }, { jsonrpc: "2.0", id: {}, method: "m" }, { jsonrpc: "2.0", id: 1, method: 5 }, { jsonrpc: "2.0", id: 1, method: "m", params: [] }, { jsonrpc: "2.0" }]) {
    assert.equal(wellFormed(bad), null, JSON.stringify(bad));
  }
});

test("wellFormed: answers to the server's own requests, and _meta's typed fields", () => {
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: "a", result: { roots: [] } }), { jsonrpc: "2.0", id: "a", result: { roots: [] } });
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: "a", result: 5 }), { jsonrpc: "2.0", id: "a", result: {} });
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: 2, error: "no" }), { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Malformed error" } });
  const m = wellFormed({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: { progressToken: {}, "io.modelcontextprotocol/related-task": { taskId: 1 }, other: 1 } } });
  assert.deepEqual(m.params._meta, { other: 1 });
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: 3, method: "m", params: { _meta: "x", a: 1 } }).params, { a: 1 });
});

test("refs, the result's address and the dialog's element", () => {
  assert.equal(containsRef({ a: { target: "e12" } }), true);
  assert.equal(containsRef({ target: "#id" }), false);
  assert.equal(urlIn([{ text: "### Page\n- Page URL: https://a.example/x\n" }]), "https://a.example/x");
  const t = withDialogLabel({ name: "browser_handle_dialog", inputSchema: { properties: { accept: {} } } });
  assert.ok(t.inputSchema.properties.element);
});

test("serve.mjs still exports what moved, for one release", () => {
  for (const name of ["wellFormed", "forJoiner", "pictureless", "dropClosedAlerts", "arrivedAt", "tabRefusal", "pathsIn", "withPaths", "createServe"]) assert.equal(typeof serve[name], "function", name);
});
