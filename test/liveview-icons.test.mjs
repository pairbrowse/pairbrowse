import "./helpers/home.mjs";
// The live view's tab icons never cost a request of their own: only an icon the page carries as a
// data: image is shown, and the browser context's request client (which would go around a
// session's proxy, with another client's headers) is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIcons } from "../scripts/liveview/tabs.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function fakePage(url, href, counter) {
  return {
    url: () => url,
    evaluate: async () => { counter.evaluates++; return href; },
    context: () => { counter.context++; return { request: { get: async () => { counter.requests++; throw new Error("no requests"); } } }; },
  };
}

test("a data: icon the page carries is shown, once read per site", async () => {
  const counter = { evaluates: 0, context: 0, requests: 0 };
  const iconFor = createIcons();
  const page = fakePage("https://a.example/x", PNG, counter);
  assert.equal(await iconFor(page), PNG);
  assert.equal(await iconFor(page), PNG);
  assert.equal(counter.evaluates, 1);
  assert.equal(counter.context + counter.requests, 0);
});

test("an icon linked by address, or none, is never fetched", async () => {
  const counter = { evaluates: 0, context: 0, requests: 0 };
  const iconFor = createIcons();
  assert.equal(await iconFor(fakePage("https://b.example/", "https://cdn.example/icon.png", counter)), null);
  assert.equal(await iconFor(fakePage("https://c.example/", null, counter)), null);
  assert.equal(await iconFor(fakePage("https://d.example/", "data:text/html,<script>1</script>", counter)), null);
  assert.equal(await iconFor(fakePage("chrome://pairbrowse/newtab", PNG, counter)), null);
  assert.equal(counter.context + counter.requests, 0);
});

test("a page that can't be read gives no icon, never an error", async () => {
  const iconFor = createIcons();
  assert.equal(await iconFor({ url: () => "https://f.example/" }), null);
  assert.equal(await iconFor({ url: () => "https://g.example/", evaluate: () => { throw new Error("gone"); } }), null);
});

test("a page that never answers gives no icon within its bound", async () => {
  const iconFor = createIcons();
  const page = { url: () => "https://e.example/", evaluate: () => new Promise(() => {}), context: () => { throw new Error("no"); } };
  const t = Date.now();
  assert.equal(await iconFor(page), null);
  assert.ok(Date.now() - t < 3000);
});

test("no module of the helper makes a request through the browser context's request client", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "dev" ? [] : walk(p)) : p.endsWith(".mjs") ? [p] : []; });
  const hits = walk(new URL("../scripts", import.meta.url).pathname).filter((p) => /\.request\.(get|post|fetch|put|delete|head)\(|request\.newContext\(/.test(readFileSync(p, "utf8")));
  assert.deepEqual(hits, []);
});
