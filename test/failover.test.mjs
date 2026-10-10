// A sharing tunnel dies with a standby up: the joiner moves to the other address by itself, with
// the same key, and stays "in"; the host never counts them as lost. Two TCP proxies to the guest
// port stand in for the two tunnels (a real tunnel is just that: a public address to that port).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";

process.env.PAIRBROWSE_TEST_JOIN_LOCAL = "1"; // loopback addresses count as tunnel addresses
process.env.PAIRBROWSE_TEST_SILENT_MS = "1500";
process.env.PAIRBROWSE_TEST_FAILOVER_MS = "4000"; // every address down this long: offline shows
// GONE_MS keeps its real value: the host must not lose a joiner that is only switching address.
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");
const { startJoin } = await import("../scripts/relay.mjs");

const until = async (what, cond, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };

// Tabs that load addresses, so the host side runs without a browser.
function fakeBrowser(urls) {
  const pages = [];
  const ctx = { pages: () => pages.filter((p) => !p.closed), newPage: async () => tab("about:blank") };
  function tab(url) {
    const page = new EventEmitter();
    Object.assign(page, { u: url, closed: false, url: () => page.u, title: async () => `Title of ${page.u}`, context: () => ctx, bringToFront: async () => {},
      isClosed: () => page.closed, evaluate: async () => null, goto: async (u) => { page.u = u; }, close: async () => { page.closed = true; } });
    pages.push(page);
    return page;
  }
  for (const u of urls) tab(u);
  return { ctx, pages };
}

// A tunnel to the guest port, which can be cut (every connection through it dropped at once).
function tunnelTo(port) {
  const socks = new Set();
  const t = { hits: 0 };
  const server = net.createServer((c) => {
    t.hits++;
    const up = net.connect(port, "127.0.0.1");
    socks.add(c); socks.add(up);
    c.pipe(up).pipe(c);
    const gone = () => { c.destroy(); up.destroy(); socks.delete(c); socks.delete(up); };
    for (const s of [c, up]) { s.on("error", gone); s.on("close", gone); }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    t.url = `http://127.0.0.1:${server.address().port}`;
    t.cut = () => { server.close(); for (const s of socks) s.destroy(); };
    r(t);
  }));
}

test("a tunnel dies: the joiner moves to the standby with the same key, stays in, the host keeps them; offline only once every address is down", { timeout: 60_000 }, async () => {
  const invites = createInvites();
  const requests = [], lost = [];
  const { ctx, pages } = fakeBrowser(["https://shop.example.com/", "https://docs.example.com/x"]);
  let relays = [];
  const view = await startLiveView({
    getContext: async () => ctx, currentUrl: async () => pages[0].url(), invites, relays: () => relays,
    onJoinRequest: (e) => requests.push(e), secretDomains: () => [], shared: { onJoinerLost: (j) => lost.push(j.name) },
  });
  const A = await tunnelTo(view.guestPort), B = await tunnelTo(view.guestPort);
  let C = null;
  relays = [A.url, B.url];
  const inv = invites.create({ role: "drive", label: "Dee", share: "code" });
  const phases = [];
  let states = 0, lastRelays = null;
  // The code carries A alone, as a real one does; B is learnt once in.
  const j = startJoin({ join: { url: A.url, key: inv.key, role: "drive", label: "Bob", mode: "follow" }, name: "Dee", onChange: (p) => phases.push(p), onTabs: async (st) => { states++; if (st.relays) lastRelays = st.relays; } });
  try {
    await until("the join request", () => requests.length);
    view.approvals.approve(requests[0].id);
    await until("in", () => j.phase === "in");
    await until("the addresses", () => lastRelays);
    assert.deepEqual(lastRelays, [A.url, B.url], "every tunnel address comes with the tabs");
    assert.deepEqual(phases, ["waiting", "in"]);
    assert.equal(B.hits, 0, "B unused while A works");

    // A goes down. The joiner is on B within a few seconds, still in, and the host still has them.
    const before = states;
    A.cut();
    await until("the move to B", () => B.hits > 0 && states > before && j.phase === "in");
    await new Promise((r) => setTimeout(r, 1200)); // past the host's silence check, the switch long done
    assert.deepEqual(phases, ["waiting", "in"], "no offline seen: nothing happened, as far as the joiner can tell");
    assert.equal(j.phase, "in");
    assert.deepEqual(lost, [], "the host never lost them");
    assert.ok(view.joinersNow().some((x) => x.who === "Dee"), "still listed with the host");
    assert.doesNotMatch(j.message, /tunnel|offline|dropped/i);

    // The host started a replacement: the joiner learns the new list.
    C = await tunnelTo(view.guestPort);
    relays = [B.url, C.url];
    await until("the new addresses", () => JSON.stringify(lastRelays) === JSON.stringify([B.url, C.url]));

    // Every address down: offline shows, but only after FAILOVER_MS, and in plain words.
    B.cut(); C.cut();
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(j.phase, "in", "still in while the addresses are tried");
    await until("offline at last", () => j.phase === "offline", 8000);
    assert.doesNotMatch(j.message, /tunnel|Cloudflare/i);
  } finally {
    await j.leave().catch(() => {});
    view.close();
    for (const t of [A, B, C]) t?.cut();
  }
});
