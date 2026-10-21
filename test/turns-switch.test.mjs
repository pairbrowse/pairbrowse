// An agent's tab across a session switch (serve/turns.mjs myTab): a new session of the PairBrowse
// browser opens on the browser's own new tab page, which no agent acts in, so an agent whose tab
// went with the session it was in gets a tab of its own, opened as browser_tabs new opens one. A
// tab a person or the page closed in the same session is never replaced that way: the agent hears
// it has none. The live check is test/integration/desktop-unchanged.test.mjs (case 5).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTurns } from "../scripts/daemon/serve/turns.mjs";
import { createConnectionState } from "../scripts/daemon/serve/connection.mjs";
import { setQuietTabs } from "../scripts/focus.mjs";

setQuietTabs(true); // no window focus work in a unit test

function fakePage(url) {
  const p = new EventEmitter();
  Object.assign(p, { _url: url, closed: false, url: () => p._url, isClosed: () => p.closed });
  return p;
}

function setup() {
  const world = { session: "default", pages: [fakePage("https://a.test/")], opened: 0 };
  const ctx = { pages: () => world.pages.filter((p) => !p.closed) };
  const listing = () => ctx.pages().map((p, i) => `- ${i}: ${i === ctx.pages().length - 1 ? "(current) " : ""}[t](${p.url()})`).join("\n");
  const internal = async (name, args) => {
    if (name === "browser_tabs" && args.action === "new") { world.opened++; world.pages.push(fakePage("about:blank")); }
    return { result: { content: [{ type: "text", text: listing() }] } };
  };
  const conn = createConnectionState("p1");
  const turns = createTurns(conn, {
    collaboration: {}, context: { sessionName: () => world.session, ready: async () => ctx, successorOf: () => null }, front: async () => null,
    hud: { sparkOwner: () => null }, internal, log: () => {}, myLabel: () => "Claude", personTab: () => false, presence: {},
    reconnecting: () => null, remoteHolder: () => null, reply: () => {}, tabClaims: { holder: () => null },
  });
  return { world, conn, turns };
}

test("after a switch to a session with only the browser's own new tab page, the agent gets a tab of its own", async () => {
  const { world, conn, turns } = setup();
  turns.setMine(world.pages[0]);
  // The switch: the old session's tabs close, the new one opens on the browser's own page.
  world.pages[0].closed = true;
  world.session = "work";
  world.pages.push(fakePage("chrome://pairbrowse/newtab"));
  const mine = await turns.myTab();
  assert.equal(world.opened, 1, "one tab opened for it");
  assert.ok(mine && mine.url() === "about:blank", "its own new tab");
  assert.equal(conn.lostTab, false);
  assert.equal(conn.mineSession, "work");
});

test("its tab closed by a person in the same session: no tab is opened for it, it hears it has none", async () => {
  const { world, conn, turns } = setup();
  turns.setMine(world.pages[0]);
  world.pages[0].closed = true;
  world.pages.push(fakePage("chrome://pairbrowse/newtab"));
  assert.equal(await turns.myTab(), null);
  assert.equal(world.opened, 0, "nothing opened");
  assert.equal(conn.lostTab, true);
});
