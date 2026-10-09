// A small WebSocket (RFC 6455) for the push channel of a join code, on Node's standard library:
// text messages only, a size cap, ping and pong, close. Cloudflare's quick tunnels hold back
// streamed HTTP responses (server-sent events arrive all at once, or never) but pass WebSockets
// through at once, so both directions of a shared session go over one of these.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MESSAGE_MAX = 2_000_000;
export const acceptKey = (key) => createHash("sha1").update(key + GUID).digest("base64");

// One connection over an upgraded socket. client: this side masks its frames (RFC 6455 5.3).
function wrap(socket, { client, head, maxMessage = MESSAGE_MAX }) {
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [], partsLen = 0;
  let closed = false;
  const on = { message: new Set(), close: new Set() };
  socket.setNoDelay?.(true);

  function frame(op, payload) {
    const len = payload.length;
    const bit = client ? 0x80 : 0;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, bit | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = bit | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = bit | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    if (!client) return Buffer.concat([head, payload]);
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, body]);
  }
  function end() {
    if (closed) return;
    closed = true;
    socket.destroy();
    for (const fn of on.close) try { fn(); } catch {}
  }
  let heard = Date.now();
  function parse() {
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(maxMessage)) return end(); len = Number(big); off = 10; }
      // A server only takes masked frames, a client only unmasked ones.
      if (len > maxMessage || !masked !== client) return end();
      const m = masked ? 4 : 0;
      if (buf.length < off + m + len) return;
      let payload = buf.subarray(off + m, off + m + len);
      if (masked) { const key = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3]; }
      buf = buf.subarray(off + m + len);
      heard = Date.now(); // any frame, a pong included: the other side is there
      if (op === 0x8) { if (!closed) socket.write(frame(0x8, Buffer.alloc(0))); return end(); }
      if (op === 0x9) { if (!closed) socket.write(frame(0xa, payload)); continue; }
      if (op === 0xa) continue;
      if (op !== 0x0 && op !== 0x1 && op !== 0x2) return end();
      parts.push(payload);
      partsLen += payload.length;
      if (partsLen > maxMessage) return end();
      if (!fin) continue;
      const text = Buffer.concat(parts).toString("utf8");
      parts = [];
      partsLen = 0;
      for (const fn of on.message) try { fn(text); } catch {}
    }
  }
  socket.on("data", (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; if (buf.length > maxMessage + 14) return end(); parse(); });
  socket.on("close", end);
  socket.on("end", end);
  socket.on("error", end);
  if (buf.length) setImmediate(parse);
  return {
    send(text) { if (closed) return false; socket.write(frame(0x1, Buffer.from(String(text), "utf8"))); return true; },
    ping() { if (!closed) socket.write(frame(0x9, Buffer.alloc(0))); },
    close() { if (!closed) { try { socket.write(frame(0x8, Buffer.alloc(0))); } catch {} } end(); },
    onMessage(fn) { on.message.add(fn); },
    onClose(fn) { if (closed) fn(); else on.close.add(fn); },
    get closed() { return closed; },
    // When the other side last sent any frame (a pong to ping() counts): silence past a few of
    // them means the connection is dead even while the socket looks open (a killed helper behind a tunnel).
    get heard() { return heard; },
    // Bytes written but not yet taken by the other side (a reader that fell behind).
    get buffered() { return closed ? 0 : socket.writableLength; },
  };
}

// The server's side of an upgrade request already checked by the caller. Returns the connection,
// or null (and answers 400) when it isn't a proper WebSocket request.
export function acceptUpgrade(req, socket, head, opts = {}) {
  socket.on("error", () => {}); // see refuseUpgrade
  const key = String(req.headers["sec-websocket-key"] || "");
  if (String(req.headers.upgrade || "").toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(key)}\r\n\r\n`);
  return wrap(socket, { client: false, head, ...opts });
}

// Refuses an upgrade with a JSON answer, like a plain request would get.
export function refuseUpgrade(socket, code, body) {
  // An upgrade's socket has no error listener of the HTTP server's any more: a caller hanging up
  // (a reset) while the answer goes out would otherwise take the whole process down.
  socket.on("error", () => {});
  const text = JSON.stringify(body);
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || "Error"}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
}

// The client's side: resolves to the connection, or rejects with { status, body } when the server
// answers with a plain response instead (not approved yet, a revoked code...).
export function connect(url, { headers = {}, timeoutMs = 20_000, maxMessage = MESSAGE_MAX } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = randomBytes(16).toString("base64");
    const req = (u.protocol === "https:" ? https : http).request(u, { headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key } });
    const timer = setTimeout(() => { req.destroy(); reject(Object.assign(new Error("timed out"), { status: 0 })); }, timeoutMs);
    req.on("upgrade", (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers["sec-websocket-accept"] !== acceptKey(key)) { socket.destroy(); return reject(Object.assign(new Error("bad handshake"), { status: 0 })); }
      resolve(wrap(socket, { client: true, head, maxMessage }));
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (body.length < 10_000) body += d; });
      res.on("end", () => { clearTimeout(timer); let parsed = {}; try { parsed = JSON.parse(body); } catch {} reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: parsed })); });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(Object.assign(e, { status: 0 })); });
    req.end();
  });
}
