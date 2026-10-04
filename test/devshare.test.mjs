import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

const { createDevShare, devAddress, readDevEntry, toDevHeaders, fromDevHeaders, DEV_COOKIE } = await import("../scripts/devshare.mjs");
const { stateForJoiner } = await import("../scripts/tabsync.mjs");

// A stand-in dev server: records what it was sent; answers a redirect, a cookie and a WebSocket.
async function devServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/go") { res.writeHead(302, { location: `http://localhost:${server.address().port}/there?x=1` }); return res.end(); }
      if (req.url === "/login") { res.writeHead(200, { "set-cookie": "sid=abc; Domain=localhost; Path=/; HttpOnly" }); return res.end("ok"); }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method} ${req.url}`);
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ upgrade: true, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d)); // echo
    socket.on("end", () => socket.end()); // as WebSocket servers do when the other side hangs up
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, seen, port: server.address().port };
}

function request(origin, { method = "GET", path = "/", cookie, headers = {} } = {}) {
  const u = new URL(path, origin);
  return new Promise((ok, no) => {
    // agent: false: one connection per request, none left open after the test.
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, headers: { ...headers, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", no);
    req.end(method === "POST" ? "a=1" : undefined);
  });
}

test("dev addresses: http on this computer only", () => {
  assert.deepEqual(devAddress("http://localhost:3000/a"), { hostname: "localhost", port: 3000 });
  assert.deepEqual(devAddress("http://127.0.0.1:5173/"), { hostname: "127.0.0.1", port: 5173 });
  assert.deepEqual(devAddress("http://app.localhost:3000/"), { hostname: "app.localhost", port: 3000 });
  assert.deepEqual(devAddress("http://[::1]:8080/"), { hostname: "[::1]", port: 8080 });
  assert.equal(devAddress("http://192.168.1.5:3000/"), null, "the local network is not this computer");
  assert.equal(devAddress("https://localhost:3000/"), null);
  assert.equal(devAddress("http://user:pw@localhost:3000/"), null);
  assert.equal(devAddress("https://example.com/"), null);
});

test("headers: the dev server sees a local visit, the visitor sees the shared address", () => {
  const local = { host: "localhost:3000", origin: "http://localhost:3000", origins: ["http://localhost:3000", "http://127.0.0.1:3000"] };
  const publicOrigin = "https://abc-def.trycloudflare.com";
  const h = toDevHeaders({ host: "abc-def.trycloudflare.com", origin: publicOrigin, referer: `${publicOrigin}/page`, cookie: `a=1; ${DEV_COOKIE}=secret; b=2`, "x-forwarded-host": "abc-def.trycloudflare.com", "cf-connecting-ip": "1.2.3.4", accept: "text/html" }, { local, publicOrigin });
  assert.equal(h.host, "localhost:3000");
  assert.equal(h.origin, "http://localhost:3000");
  assert.equal(h.referer, "http://localhost:3000/page");
  assert.equal(h.cookie, "a=1; b=2", "the key never reaches the dev server");
  assert.equal(h["x-forwarded-host"], undefined);
  assert.equal(h["cf-connecting-ip"], undefined);
  assert.equal(h.accept, "text/html");
  const back = fromDevHeaders({ location: "http://127.0.0.1:3000/x?y=1", "set-cookie": ["s=1; Domain=localhost; Path=/"] }, { local, publicOrigin });
  assert.equal(back.location, `${publicOrigin}/x?y=1`);
  assert.deepEqual(back["set-cookie"], ["s=1; Path=/"]);
  assert.equal(fromDevHeaders({ location: "https://elsewhere.example/" }, { local, publicOrigin }).location, "https://elsewhere.example/");
});

test("a shared dev server: only joiners with their key, watchers only read, WebSockets pass", async () => {
  const dev = await devServer();
  const members = new Set(["inv1:watcher", "inv2:driver"]);
  const share = createDevShare({ direct: true });
  share.members((k) => members.has(k));
  try {
    const d = await share.share("localhost", dev.port);
    const [{ origin, token: watch }] = share.forJoiner("inv1:watcher", "watch");
    const [{ token: drive }] = share.forJoiner("inv2:driver", "drive");
    assert.equal(origin, d.origin);
    assert.notEqual(watch, drive);
    assert.deepEqual(share.forJoiner("inv1:watcher", "watch"), [{ origin, token: watch }], "the same key on the next round");

    // No key, a wrong key, a key for someone who left: nothing.
    assert.equal((await request(origin)).status, 403);
    assert.equal((await request(origin, { cookie: `${DEV_COOKIE}=${"0".repeat(64)}` })).status, 403);
    assert.equal(dev.seen.length, 0, "nothing reached the dev server");

    // A watcher reads; the dev server sees a visit from this computer.
    const r = await request(origin, { path: "/page?q=1", cookie: `theirs=1; ${DEV_COOKIE}=${watch}`, headers: { origin, "x-forwarded-host": "abc.trycloudflare.com" } });
    assert.equal(r.status, 200);
    assert.equal(r.body, "GET /page?q=1");
    const seen = dev.seen.at(-1).headers;
    assert.equal(seen.host, `localhost:${dev.port}`);
    assert.equal(seen.origin, `http://localhost:${dev.port}`);
    assert.equal(seen.cookie, "theirs=1");
    assert.equal(seen["x-forwarded-host"], undefined);
    assert.equal((await request(origin, { method: "POST", cookie: `${DEV_COOKIE}=${watch}` })).status, 403, "watchers don't change things");

    // A driver changes things; redirects and cookies come back for the shared address.
    const post = await request(origin, { method: "POST", path: "/form", cookie: `${DEV_COOKIE}=${drive}` });
    assert.equal(post.status, 200);
    assert.equal(dev.seen.at(-1).body, "a=1");
    assert.equal((await request(origin, { path: "/go", cookie: `${DEV_COOKIE}=${drive}` })).headers.location, `${origin}/there?x=1`);
    assert.deepEqual((await request(origin, { path: "/login", cookie: `${DEV_COOKIE}=${drive}` })).headers["set-cookie"], ["sid=abc; Path=/; HttpOnly"]);

    // Hot reload: a watcher's WebSocket goes through, both ways.
    const u = new URL(origin);
    const echoed = await new Promise((ok, no) => {
      const sock = net.connect(Number(u.port), "127.0.0.1", () => {
        sock.write(`GET /_hmr HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${DEV_COOKIE}=${watch}\r\n\r\n`);
      });
      let got = "";
      sock.on("data", (c) => {
        got += c;
        if (got.includes("101") && !got.includes("ping")) sock.write("ping");
        if (got.includes("ping")) { sock.destroy(); ok(got); }
      });
      sock.on("error", no);
      setTimeout(() => no(new Error("no echo")), 5000);
    });
    assert.match(echoed, /101 Switching Protocols/);
    assert.equal(dev.seen.find((x) => x.upgrade).headers.host, `localhost:${dev.port}`);

    // Someone who left loses access at once.
    members.delete("inv2:driver");
    assert.equal((await request(origin, { cookie: `${DEV_COOKIE}=${drive}` })).status, 403);

    // Addresses: a host tab crosses as the shared address, and back.
    assert.equal(share.toPublic(`http://localhost:${dev.port}/a?b=1#c`), `${origin}/a?b=1#c`);
    assert.equal(share.toPublic("http://localhost:1/"), null, "a port that isn't shared");
    assert.equal(share.toLocal(`${origin}/a?b=1`), `http://localhost:${dev.port}/a?b=1`);
    assert.equal(share.toLocal("https://example.com/"), null);
    assert.deepEqual(share.list(), [{ port: dev.port, hostname: "localhost", url: origin }]);

    // Stopped: the address answers nothing, the keys are gone.
    assert.equal(share.unshare(dev.port), true);
    await assert.rejects(request(origin, { cookie: `${DEV_COOKIE}=${watch}` }));
    assert.deepEqual(share.forJoiner("inv1:watcher", "watch"), []);
    // Nothing is left open at the dev server: the WebSocket's other side, idle connections.
    const open = () => new Promise((ok) => dev.server.getConnections((e, n) => ok(n)));
    for (let i = 0; i < 50 && await open() > 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await open(), 0, "nothing left open at the dev server");
  } finally {
    share.stopAll();
    dev.server.close();
  }
});

test("at most three dev servers at once, real ports only", async () => {
  const share = createDevShare({ direct: true });
  try {
    for (const p of [3001, 3002, 3003]) await share.share("localhost", p);
    await assert.rejects(share.share("localhost", 3004), /At most 3/);
    await assert.rejects(share.share("localhost", 70000), /port/);
    assert.equal((await share.share("localhost", 3001)).port, 3001, "sharing again is the same share");
  } finally {
    share.stopAll();
  }
});

test("the joiner takes Quick Tunnel addresses and keys only", () => {
  const token = "ab".repeat(32);
  assert.deepEqual(readDevEntry({ origin: "https://word-word-word.trycloudflare.com", token }), { origin: "https://word-word-word.trycloudflare.com", token });
  assert.equal(readDevEntry({ origin: "https://evil.example.com", token }), null);
  assert.equal(readDevEntry({ origin: "https://x.trycloudflare.com/path", token }), null);
  assert.equal(readDevEntry({ origin: "http://127.0.0.1:4000", token }), null);
  assert.deepEqual(readDevEntry({ origin: "http://127.0.0.1:4000", token }, { allowLocal: true }), { origin: "http://127.0.0.1:4000", token });
  assert.equal(readDevEntry({ origin: "https://x.trycloudflare.com", token: "short" }), null);
});

test("a localhost tab crosses only as its shared address", () => {
  const tabs = [{ id: "aaaaaaaa", url: "http://localhost:3000/dash?tab=2", title: "Dash" }, { id: "bbbbbbbb", url: "http://localhost:4000/", title: "Other" }];
  assert.deepEqual(stateForJoiner({ tabs }).tabs, [], "not shared: nothing local crosses");
  const mapUrl = (u) => (u.startsWith("http://localhost:3000") ? `https://abc.trycloudflare.com${u.slice("http://localhost:3000".length)}` : null);
  const out = stateForJoiner({ tabs }, { mapUrl, drive: true }).tabs;
  assert.deepEqual(out.map((t) => t.url), ["https://abc.trycloudflare.com/dash?tab=2"]);
});
