// ui/helper.js: the pages' one lookup of the helper's address, in Node over fake hosts (the
// browser's API, the extension's storage, neither). The pages' own tests cover it in a page.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostKind, askHelper, helperAddress, onHelperAddress, followHelper } from "../ui/helper.js";

const native = (answer) => ({ pairbrowse: { session: { helper: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) } } });
function extension(view, { fail = false } = {}) {
  const listeners = new Set();
  return {
    chrome: { storage: {
      session: { get: () => (fail ? Promise.reject(new Error("no")) : Promise.resolve(view === undefined ? {} : { view })) },
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    } },
    change: (view, area = "session") => { for (const fn of [...listeners]) fn({ view: { newValue: view } }, area); },
    listeners,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("hostKind: the browser's API first, then the extension's storage, else none", () => {
  assert.equal(hostKind(native({})), "native");
  assert.equal(hostKind(extension("x")), "extension");
  assert.equal(hostKind({ ...native({}), ...extension("x") }), "native");
  assert.equal(hostKind({}), "");
  assert.equal(hostKind({ pairbrowse: {} }), "", "a pairbrowse object without session.helper is not the browser's API");
});

test("askHelper and helperAddress: an address only when both parts are there", async () => {
  assert.equal(await askHelper(native({ origin: "http://127.0.0.1:9", key: "k" })), "http://127.0.0.1:9/k/");
  for (const bad of [null, undefined, {}, { origin: "", key: "" }, { origin: "http://x", key: 3 }]) {
    assert.equal(await askHelper(native(bad)), null, JSON.stringify(bad));
  }
  assert.equal(await askHelper(extension("http://h/k/")), "http://h/k/");
  assert.equal(await askHelper(extension(undefined)), null);
  assert.equal(await askHelper(extension(7)), null);
  await assert.rejects(askHelper({}));
  await assert.rejects(askHelper(native(new Error("gone"))));
  await assert.rejects(askHelper(extension("x", { fail: true })));
  assert.equal(await helperAddress({}), null);
  assert.equal(await helperAddress(native(new Error("gone"))), null);
});

test("onHelperAddress: the extension's new addresses only, until stopped", () => {
  const ext = extension("a");
  const got = [];
  const stop = onHelperAddress((u) => got.push(u), ext);
  ext.change("http://h/k2/");
  ext.change("http://h/k3/", "local");
  ext.change(undefined);
  assert.deepEqual(got, ["http://h/k2/"]);
  stop();
  ext.change("http://h/k4/");
  assert.deepEqual(got, ["http://h/k2/"]);
  assert.equal(typeof onHelperAddress(() => {}, native({})), "function", "nothing to follow in the browser");
});

test("followHelper: connect, none, failed and wait", async () => {
  const run = async (scope, opts = {}) => {
    const seen = [];
    followHelper({ connect: (u) => seen.push(`connect ${u}`), none: () => seen.push("none"), ...(opts.failed ? { failed: () => seen.push("failed") } : {}), wait: !!opts.wait, scope });
    await tick();
    return seen;
  };
  assert.deepEqual(await run(native({ origin: "http://o", key: "k" })), ["connect http://o/k/"]);
  assert.deepEqual(await run(native(null)), ["none"]);
  assert.deepEqual(await run(native(null), { wait: true }), ["none"], "the browser never sends a later address");
  assert.deepEqual(await run(native(new Error("x"))), ["none"], "failed defaults to none");
  assert.deepEqual(await run(native(new Error("x")), { failed: true }), ["failed"]);
  assert.deepEqual(await run({}, { failed: true }), ["failed"]);
  assert.deepEqual(await run(extension(undefined)), ["none"]);
  assert.deepEqual(await run(extension(undefined), { wait: true }), []);
  const ext = extension(undefined);
  const seen = [];
  const stop = followHelper({ connect: (u) => seen.push(u), wait: true, scope: ext });
  await tick();
  ext.change("http://h/k/");
  stop();
  ext.change("http://h/k2/");
  assert.deepEqual(seen, ["http://h/k/"]);
});
