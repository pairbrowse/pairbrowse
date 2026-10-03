import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { acceptUpgrade, refuseUpgrade, connect } from "../scripts/ws.mjs";

async function server(onConn) {
  const s = http.createServer((q, r) => r.end());
  s.on("upgrade", (req, socket, head) => {
    if (req.url === "/no") return refuseUpgrade(socket, 403, { waiting: true });
    const c = acceptUpgrade(req, socket, head, { maxMessage: 1000 });
    if (c) onConn(c);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
}

test("websocket: messages both ways, large ones, a refusal as a plain answer", async () => {
  const s = await server((c) => c.onMessage((m) => c.send(`echo:${m.length}:${m.slice(0, 5)}`)));
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    const c = await connect(`${url}/x`);
    const got = [];
    c.onMessage((m) => got.push(m));
    c.send("hello");
    c.send("é".repeat(300)); // 600 bytes: a 16-bit length
    for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(got, ["echo:5:hello", "echo:300:ééééé"]);
    await assert.rejects(connect(`${url}/no`), (e) => e.status === 403 && e.body.waiting === true);
    // Too large for the server: the connection ends.
    const closed = new Promise((r) => c.onClose(r));
    c.send("x".repeat(5000));
    await closed;
    assert.ok(c.closed);
  } finally { s.close(); }
});

test("websocket: a server refuses unmasked frames and bad handshakes", async () => {
  let conn;
  const s = await server((c) => { conn = c; });
  try {
    const port = s.address().port;
    const raw = net.createConnection(port, "127.0.0.1");
    await new Promise((r) => raw.once("connect", r));
    raw.write("GET /x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await new Promise((r) => raw.once("data", r));
    const closed = new Promise((r) => conn.onClose(r));
    raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // "hi", unmasked
    await closed;
    const bad = net.createConnection(port, "127.0.0.1");
    await new Promise((r) => bad.once("connect", r));
    bad.write("GET /x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: short\r\n\r\n");
    const answer = await new Promise((r) => bad.once("data", (d) => r(String(d))));
    assert.match(answer, /^HTTP\/1.1 400/);
    raw.destroy(); bad.destroy();
  } finally { s.close(); }
});
