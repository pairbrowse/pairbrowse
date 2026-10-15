// Property-based fuzzing of the wires the helper reads from: WebSocket frames on a join code's
// push channel (scripts/ws.mjs), the private socket's first bytes that tell a hook's line from an
// agent's MCP connection (daemon/approvals.mjs routeConnection), and an agent's JSON-RPC lines as
// serve.mjs reads them (JSON.parse, then wellFormed).
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fc from "fast-check";
import { acceptUpgrade } from "../../scripts/ws.mjs";
import { routeConnection } from "../../scripts/daemon/approvals.mjs";
import { HOOK_MARK } from "../../scripts/hookline.mjs";
import { wellFormed } from "../../scripts/daemon/serve.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });

// A socket that takes bytes as they are given and keeps what the other side wrote.
function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.destroyed = false;
  s.write = (b) => { s.written.push(b); return true; };
  s.end = (b) => { if (b) s.written.push(b); s.destroyed = true; };
  s.destroy = () => { s.destroyed = true; };
  s.setNoDelay = () => {};
  s.pause = () => {};
  s.unshift = (b) => { s.unshifted = Buffer.from(b); };
  s.writableLength = 0;
  return s;
}
const UPGRADE = { headers: { upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } };
const cut = (buf, cuts) => {
  const at = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((a, b) => a - b);
  const parts = [];
  let last = 0;
  for (const c of [...at, buf.length]) { parts.push(buf.subarray(last, c)); last = c; }
  return parts;
};
// A client's frame: masked, as RFC 6455 requires of a client.
function frame(op, payload, { fin = true, mask = Buffer.from([1, 2, 3, 4]), masked = true } = {}) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, (masked ? 0x80 : 0) | len])
    : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | op, (masked ? 0x80 : 0) | 126, len >> 8, len & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | op; h[1] = (masked ? 0x80 : 0) | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  if (!masked) return Buffer.concat([head, payload]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
const MAX = 300;
const open = () => {
  const sock = fakeSocket();
  const ws = acceptUpgrade(UPGRADE, sock, Buffer.alloc(0), { maxMessage: MAX });
  const got = [];
  ws.onMessage((t) => got.push(t));
  return { sock, ws, got };
};

// Property: any bytes, cut anywhere, never throw out of the reader, and no message it hands on
// is longer than its cap.
test("WebSocket: any bytes in any chunks never throw, and no message passes its cap", () => {
  check(fc.property(fc.uint8Array({ maxLength: 600 }), fc.array(fc.nat(), { maxLength: 6 }), (bytes, cuts) => {
    const { sock, got } = open();
    for (const part of cut(Buffer.from(bytes), cuts)) sock.emit("data", part);
    // Each message was at most MAX bytes; bytes that aren't UTF-8 decode to U+FFFD (3 bytes each).
    for (const m of got) assert.ok(Buffer.byteLength(m) <= 3 * MAX);
  }));
});

// Property: text messages framed by a client (fragmented, with pings between) round-trip
// exactly, in order, however the bytes are cut.
let seen = 0;
test("WebSocket: framed messages round-trip in order however the bytes arrive", () => {
  const text = fc.string({ unit: "grapheme", maxLength: 40 }).filter((t) => Buffer.byteLength(t) <= MAX);
  check(fc.property(fc.array(fc.tuple(text, fc.nat({ max: 3 }), fc.boolean()), { maxLength: 6 }), fc.array(fc.nat(), { maxLength: 8 }), (msgs, cuts) => {
    const frames = [];
    for (const [t, pieces, ping] of msgs) {
      const b = Buffer.from(t, "utf8");
      const n = Math.max(1, Math.min(pieces + 1, b.length || 1));
      const size = Math.ceil(b.length / n) || 0;
      for (let i = 0; i < n; i++) {
        frames.push(frame(i === 0 ? 0x1 : 0x0, b.subarray(i * size, i === n - 1 ? b.length : (i + 1) * size), { fin: i === n - 1 }));
        if (ping && i === 0 && n > 1) frames.push(frame(0x9, Buffer.from("p")));
      }
    }
    const { sock, got } = open();
    for (const part of cut(Buffer.concat(frames), cuts)) sock.emit("data", part);
    assert.deepEqual(got, msgs.map(([t]) => t));
    seen += got.length;
    assert.equal(sock.destroyed, false);
  }));
  assert.ok(seen > 0, "messages went through");
});

// Property: a frame a client didn't mask, or one past the cap, ends the connection and is
// never handed on.
test("WebSocket: unmasked or oversized frames close the connection, unread", () => {
  check(fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: MAX + 1, max: 70_000 }), fc.array(fc.nat(), { maxLength: 4 }), (t, big, cuts) => {
    const a = open();
    for (const part of cut(frame(0x1, Buffer.from(t), { masked: false }), cuts)) a.sock.emit("data", part);
    assert.deepEqual(a.got, []);
    assert.ok(a.sock.destroyed);
    const b = open();
    for (const part of cut(frame(0x1, Buffer.alloc(big, 97)), cuts)) b.sock.emit("data", part);
    assert.deepEqual(b.got, []);
  }));
});

// Property: the private socket's first bytes go to the hook only when they start with the
// hook's mark (its one line, nothing after), else to the MCP side with every byte read put
// back; never both, and a first line past 64 KB goes nowhere.
test("private socket: a hook's line or an agent's bytes, never both, nothing lost", () => {
  const bytes = fc.oneof(
    fc.uint8Array({ maxLength: 120 }).map((b) => Buffer.from(b)),
    fc.tuple(fc.string({ maxLength: 60 }), fc.boolean()).map(([t, nl]) => Buffer.from(`${HOOK_MARK}${t}${nl ? "\n" : ""}`)),
    fc.tuple(fc.nat({ max: HOOK_MARK.length }), fc.string({ maxLength: 20 })).map(([n, t]) => Buffer.from(HOOK_MARK.slice(0, n) + t)),
    fc.constant(Buffer.from(`${HOOK_MARK}${"x".repeat(70_000)}`)),
  );
  check(fc.property(bytes, fc.array(fc.nat(), { maxLength: 6 }), (all, cuts) => {
    const sock = fakeSocket();
    let hook = null, other = 0;
    routeConnection(sock, { onHook: (_s, line) => { hook = line; }, onOther: () => { other++; } });
    let fed = Buffer.alloc(0);
    for (const part of cut(all, cuts)) {
      if (hook !== null || other || sock.destroyed) break;
      sock.emit("data", part);
      fed = Buffer.concat([fed, part]);
    }
    assert.ok(!(hook !== null && other), "both");
    assert.ok(other <= 1);
    if (hook !== null) {
      assert.ok(fed.subarray(0, HOOK_MARK.length).equals(Buffer.from(HOOK_MARK)));
      assert.equal(hook, fed.subarray(0, fed.indexOf(10)).toString("utf8"));
    }
    if (other) assert.ok(sock.unshifted.equals(fed), "every byte read is put back");
    if (fed.length > 64 * 1024) assert.ok(sock.destroyed && hook === null && !other);
  }));
});

// Property: a line from an agent is dropped or goes on as a well-formed message; reading it
// never throws and never changes Object's prototype (a "__proto__" key stays the message's own).
test("JSON-RPC lines: never thrown, never polluting, only well-formed ones go on", () => {
  const key = fc.constantFrom("__proto__", "constructor", "prototype", "jsonrpc", "id", "method", "params", "_meta", "progressToken", "x");
  const tree = fc.letrec((tie) => ({ v: fc.oneof({ depthSize: "small" }, fc.jsonValue({ maxDepth: 1 }), fc.dictionary(key, tie("v"), { maxKeys: 4 })) })).v;
  const line = fc.oneof(fc.string({ unit: "binary", maxLength: 80 }), tree.map((v) => JSON.stringify(v) ?? ""),
    fc.record({ jsonrpc: fc.constantFrom("2.0", "1.0"), id: fc.oneof(fc.integer(), fc.string(), fc.constant(null)), method: fc.string(), params: tree }, { requiredKeys: [] }).map((m) => JSON.stringify(m).replace('"params":', '"__proto__":{"polluted":1},"params":')));
  check(fc.property(line, (l) => {
    let msg;
    try { msg = JSON.parse(l); } catch { return; }
    const out = wellFormed(msg);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    if (out !== null) {
      assert.equal(out.jsonrpc, "2.0");
      assert.equal(Object.getPrototypeOf(out), Object.prototype);
      assert.doesNotThrow(() => JSON.stringify(out));
    }
  }));
});
