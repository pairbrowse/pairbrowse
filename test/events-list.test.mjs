// The helper's events in one list (ui/events.js): every event the live view sends on its stream is
// there, with who gets it, and the pages' lists (common.js) and the helper's sets come from it.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_EVENTS, OWNER_EVENTS, PAGES_EVENTS, SHARED_STREAM_EVENTS, DELTA_EVENTS, OWN_EVENTS } from "../ui/events.js";
import { STREAM_EVENTS, OWN_STREAM_EVENTS } from "../ui/common.js";

const root = new URL("../", import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), "utf8");
const routes = readdirSync(join(root, "scripts/liveview/routes")).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/liveview/routes/${f}`);

test("every event the live view sends is in ui/events.js", () => {
  const sent = new Set();
  for (const f of ["scripts/liveview.mjs", "scripts/liveview/grants.mjs", ...routes]) {
    // broadcast("x") and sse("x") on the live view's streams; push.broadcast is the joiners' channel.
    for (const [, name] of read(f).matchAll(/(?<![.\w])(?:broadcast|sse)\("([a-z-]+)"/g)) sent.add(name);
  }
  for (const [, name] of read("scripts/daemon.mjs").matchAll(/sendToPages\?*\.?\(\s*"([a-z-]+)"/g)) sent.add(name);
  assert.ok(sent.size > 20, `found ${sent.size}`);
  for (const name of sent) assert.ok(Object.hasOwn(SERVER_EVENTS, name), `"${name}" is sent but not in ui/events.js`);
  for (const name of Object.keys(SERVER_EVENTS)) assert.ok(sent.has(name), `"${name}" is in ui/events.js but never sent`);
});

test("each event says who gets it, and the pages' lists come from the one list", () => {
  for (const [name, e] of Object.entries(SERVER_EVENTS)) {
    assert.ok(["all", "owner", "pages", "viewers", "turn"].includes(e.to), name);
    assert.ok(e.pages === undefined || ["shared", "own"].includes(e.pages), name);
    if (e.pages === "own") assert.equal(typeof e.kind, "string", `${name}: an own-stream event names its kind`);
    if (e.delta) assert.equal(e.pages, "shared", `${name}: only shared-stream events are deltas`);
  }
  assert.deepEqual(STREAM_EVENTS, SHARED_STREAM_EVENTS);
  assert.deepEqual(OWN_STREAM_EVENTS, OWN_EVENTS);
  for (const name of PAGES_EVENTS) assert.ok(OWNER_EVENTS.includes(name), `${name}: page events go to owner streams only`);
  for (const name of DELTA_EVENTS) assert.ok(STREAM_EVENTS.includes(name));
  // Never to a guest: everything but the "all" events and the picture.
  for (const name of ["profile", "join", "invites", "approval", "capture", "downloads", "config", "outline"]) assert.ok(OWNER_EVENTS.includes(name), name);
  // A hand-off's own events go to its stream alone, never on any page's stream.
  for (const name of ["turn", "turn-ended"]) assert.ok(SERVER_EVENTS[name].to === "turn" && !STREAM_EVENTS.includes(name) && !OWNER_EVENTS.includes(name), name);
});
