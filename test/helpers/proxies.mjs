// Stand-in proxies and check servers for the network tests (spec server-mode Phase C), standard
// library only: a trace echo (Cloudflare's trace page's "ip=" and "loc=" lines, over http or https),
// an HTTP proxy (CONNECT and absolute-form requests, optional Basic auth, optionally over TLS), a
// SOCKS5 proxy without authentication that logs the address type it was sent, proxies that hang or
// answer garbage, a STUN responder that answers with the mapped address it is told, and a test
// certificate authority made with openssl (null where openssl isn't installed). Every proxy sends
// every connection to one upstream port on 127.0.0.1, whatever name it was asked for, and logs
// what it was asked.
import { createServer as createNet, connect } from "node:net";
import { createServer as createTls } from "node:tls";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { createSocket } from "node:dgram";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listen = (server, host = "127.0.0.1") => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
// A server that, closed, also ends the connections it holds.
function tracked(server) {
  const open = new Set();
  server.on("connection", (s) => { open.add(s); s.on("close", () => open.delete(s)); });
  return () => new Promise((resolve) => { for (const s of open) s.destroy(); server.close(() => resolve()); });
}

// A trace echo: any path answers "ip=<ip>\nloc=<loc>\n" (ip and loc may be changed between
// answers through .set). tls: { key, cert } for https. hosts: the Host headers it was asked with.
export async function traceServer({ ip = "203.0.113.10", loc = "US", tls = null, answer = null } = {}) {
  const state = { ip, loc, hosts: [], urls: [] };
  const handler = (req, res) => {
    state.hosts.push(req.headers.host || "");
    state.urls.push(req.url);
    if (answer) return answer(req, res);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`fl=1\nh=${req.headers.host}\nip=${state.ip}\nts=1\nvisit_scheme=https\nloc=${state.loc}\ntls=TLSv1.3\n`);
  };
  const server = tls ? createHttps(tls, handler) : createHttp(handler);
  const port = await listen(server);
  const stop = tracked(server);
  return { port, state, set: (v) => Object.assign(state, v), close: stop };
}

// The head of a request, read off socket: { head, rest } (rest: bytes after the head).
function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      socket.pause();
      resolve({ head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + 4) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}
const pipeTo = (client, port, first = null) => {
  const up = connect(port, "127.0.0.1");
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
  up.once("connect", () => {
    if (first?.length) up.write(first);
    client.pipe(up).pipe(client);
    client.resume();
  });
  return up;
};

// An HTTP proxy to upstream (a port on 127.0.0.1). auth: { username, password } it requires
// (407 otherwise); tls: { key, cert } to be an https: proxy. log: [{ method, target, authorized,
// authorization }] (authorization: the header as sent, for tests that check what reached it).
export async function httpProxy({ upstream, auth = null, tls = null } = {}) {
  const log = [];
  const expected = auth ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` : null;
  const onSocket = async (socket) => {
    socket.on("error", () => {});
    let h;
    try { h = await readHead(socket); } catch { return; }
    const [method, target] = h.head.split("\r\n")[0].split(" ");
    const authorization = /^proxy-authorization:\s*(.*)$/im.exec(h.head)?.[1] ?? null;
    const authorized = !expected || authorization === expected;
    log.push({ method, target, authorized, authorization });
    if (!authorized) return socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\n\r\n");
    if (method === "CONNECT") {
      const up = connect(upstream, "127.0.0.1");
      up.on("error", () => socket.destroy());
      up.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (h.rest.length) up.write(h.rest);
        socket.pipe(up).pipe(socket);
        socket.resume();
      });
      return;
    }
    // An absolute-form request (http:// through the proxy): passed on as it came.
    const head = h.head.replace(/^proxy-authorization:.*\r\n/im, "");
    pipeTo(socket, upstream, Buffer.concat([Buffer.from(`${head}\r\n\r\n`, "latin1"), h.rest]));
  };
  const server = tls ? createTls(tls, onSocket) : createNet(onSocket);
  const port = await listen(server);
  return { port, log, close: tracked(server) };
}

// A SOCKS5 proxy to upstream. Without auth it takes "no authentication" only (a client offering
// only username and password gets "no acceptable method", 0xff); with auth { username, password }
// it requires RFC 1929 username/password (method 2; the wrong ones get status 1 and the
// connection closed). log: [{ methods, atyp, host, port }] (with auth also { username, authorized }).
export async function socks5Proxy({ upstream, auth = null } = {}) {
  const log = [];
  const server = createNet((socket) => {
    socket.on("error", () => {});
    let buf = Buffer.alloc(0), stage = "hello", entry = null;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "hello") {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        entry = { methods, atyp: null, host: null, port: null, ...(auth ? { username: null, authorized: false } : {}) };
        log.push(entry);
        if (auth) {
          if (!methods.includes(2)) return socket.end(Buffer.from([5, 0xff]));
          socket.write(Buffer.from([5, 2]));
          stage = "auth";
        } else {
          if (!methods.includes(0)) return socket.end(Buffer.from([5, 0xff]));
          socket.write(Buffer.from([5, 0]));
          stage = "request";
        }
      }
      if (stage === "auth") {
        if (buf.length < 2 || buf.length < 2 + buf[1] + 1) return;
        const ulen = buf[1], plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const username = buf.subarray(2, 2 + ulen).toString("utf8"), password = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        buf = buf.subarray(3 + ulen + plen);
        entry.username = username;
        entry.authorized = buf[-1] === undefined && username === auth.username && password === auth.password;
        if (!entry.authorized) return socket.end(Buffer.from([1, 1]));
        socket.write(Buffer.from([1, 0]));
        stage = "request";
      }
      if (stage === "request") {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const size = { 1: 4, 3: 1 + buf[4], 4: 16 }[atyp];
        if (size === undefined) return socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (buf.length < 4 + size + 2) return;
        const addr = buf.subarray(4, 4 + size);
        entry.atyp = atyp;
        entry.host = atyp === 3 ? addr.subarray(1).toString("ascii") : atyp === 1 ? [...addr].join(".") : addr.toString("hex");
        entry.port = buf.readUInt16BE(4 + size);
        const rest = buf.subarray(4 + size + 2);
        socket.off("data", onData);
        socket.pause();
        const up = connect(upstream, "127.0.0.1");
        up.on("error", () => socket.destroy());
        up.once("connect", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) up.write(rest);
          socket.pipe(up).pipe(socket);
          socket.resume();
        });
        stage = "open";
      }
    };
    socket.on("data", onData);
  });
  const port = await listen(server);
  return { port, log, close: tracked(server) };
}

// A proxy that takes connections and never answers.
export async function hungProxy() {
  const server = createNet((s) => s.on("error", () => {}));
  return { port: await listen(server), close: tracked(server) };
}
// A proxy that answers every connection with `text` (default: not HTTP, not SOCKS5).
export async function garbageProxy(text = "hello there\r\n\r\n") {
  const server = createNet((s) => { s.on("error", () => {}); s.once("data", () => s.write(text)); });
  return { port: await listen(server), close: tracked(server) };
}
// A port with nothing listening on it (taken, then let go).
export async function closedPort() {
  const server = createNet();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}

// A STUN responder (RFC 5389 Binding): answers each Binding request with XOR-MAPPED-ADDRESS
// `mapped` (an IPv4 address) and the asker's port. requests counts what it was asked.
export async function stunResponder({ mapped = "198.51.100.7" } = {}) {
  const socket = createSocket("udp4");
  const state = { requests: 0, mapped };
  socket.on("message", (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return;
    state.requests++;
    const out = Buffer.alloc(32);
    out.writeUInt16BE(0x0101, 0);
    out.writeUInt16BE(12, 2);
    out.writeUInt32BE(0x2112a442, 4);
    msg.copy(out, 8, 8, 20);
    out.writeUInt16BE(0x0020, 20);
    out.writeUInt16BE(8, 22);
    out.writeUInt8(0, 24);
    out.writeUInt8(1, 25);
    out.writeUInt16BE(from.port ^ 0x2112, 26);
    const ip = state.mapped.split(".").reduce((n, p) => n * 256 + Number(p), 0);
    out.writeUInt32BE((ip ^ 0x2112a442) >>> 0, 28);
    socket.send(out, from.port, from.address);
  });
  await new Promise((r) => socket.bind(0, "127.0.0.1", r));
  return { port: socket.address().port, state, close: () => new Promise((r) => socket.close(r)) };
}

// A test certificate authority and a server certificate it signed for localhost, proxy.test,
// trace.test and 127.0.0.1: { ca, key, cert } (PEM), or null without openssl.
export function testCa() {
  const dir = mkdtempSync(join(tmpdir(), "pb-ca-"));
  const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
  try {
    writeFileSync(join(dir, "cnf"), [
      "[req]", "distinguished_name=dn", "[dn]",
      "[ca]", "basicConstraints=critical,CA:true", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash",
      "[leaf]", "basicConstraints=CA:false", "keyUsage=critical,digitalSignature", "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,DNS:proxy.test,DNS:trace.test,IP:127.0.0.1", "",
    ].join("\n"));
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes"];
    run(["req", "-x509", "-new", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-sha256", "-days", "2", "-subj", "/CN=PairBrowse test CA", "-config", "cnf", "-extensions", "ca"]);
    run(["req", "-new", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost", "-config", "cnf"]);
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-sha256", "-days", "2", "-extfile", "cnf", "-extensions", "leaf"]);
    const read = (f) => readFileSync(join(dir, f), "utf8");
    return { ca: read("ca.pem"), key: read("leaf.key"), cert: read("leaf.pem") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
