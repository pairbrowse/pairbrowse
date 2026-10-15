// Loopback, private, link-local and shared (carrier-grade NAT, Tailscale) addresses: your router,
// NAS, local dev servers, the machines on your tailnet. Pure, standard library only.
//
// A host is read the way a browser would reach it: trailing dots dropped ("localhost." is
// localhost), IPv4 in any form inet_aton takes (2130706433, 0x7f.1, 0177.0.0.1, 127.1), IPv6 with
// an IPv4 address inside it (::ffff:10.0.0.1 mapped, ::10.0.0.1 compatible, 64:ff9b::a00:1 NAT64,
// 2002:a00:1:: 6to4) judged by that IPv4 address.

// [first address as a 32-bit number, prefix length]
const V4_LOCAL = [
  ["0.0.0.0", 8], // "this network": 0.0.0.0 reaches this computer
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // shared address space: carrier-grade NAT, Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (cloud metadata services among them)
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
].map(([a, bits]) => [a.split(".").reduce((n, p) => n * 256 + Number(p), 0), bits]);

const inV4 = (n, [base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
export const isLocalV4 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff && V4_LOCAL.some((r) => inV4(n, r));

// An IPv4 address in any form inet_aton (and the URL parser) takes: one to four parts, each
// decimal, 0x hex or 0-leading octal; the last part fills the bytes left. Its 32-bit number, or null.
export function parseV4(host) {
  const s = String(host ?? "");
  if (!/^[0-9a-fA-FxX.]+$/.test(s) || !/^[0-9]/.test(s)) return null;
  const parts = s.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums = [];
  for (const p of parts) {
    let v;
    if (/^0[xX][0-9a-fA-F]*$/.test(p)) v = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) v = Number(p);
    else return null;
    if (!Number.isSafeInteger(v)) return null;
    nums.push(v);
  }
  const last = nums.pop();
  if (nums.some((v) => v > 255) || last >= 256 ** (4 - nums.length)) return null;
  return nums.reduce((n, v, i) => n + v * 256 ** (3 - i), 0) + last;
}

// An IPv6 address (no brackets) as eight 16-bit numbers, or null. A dotted IPv4 tail is allowed;
// a zone ("%en0") is dropped.
export function parseV6(host) {
  let s = String(host ?? "").toLowerCase().replace(/%.*$/, "");
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  const dot = s.lastIndexOf(":");
  if (s.slice(dot + 1).includes(".")) {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.slice(dot + 1));
    if (!v4 || v4.slice(1).some((p) => Number(p) > 255)) return null;
    const b = v4.slice(1).map(Number);
    s = `${s.slice(0, dot + 1)}${(b[0] * 256 + b[1]).toString(16)}:${(b[2] * 256 + b[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const group = (x) => (x === "" ? [] : x.split(":"));
  const head = group(halves[0]), rest = halves.length === 2 ? group(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const known = head.length + rest.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  return [...head.map((g) => parseInt(g, 16)), ...Array(8 - known).fill(0), ...rest.map((g) => parseInt(g, 16))];
}

const v4Of = (hi, lo) => hi * 65536 + lo;
export function isLocalV6(w) {
  if (!Array.isArray(w) || w.length !== 8) return false;
  const zeros = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // :: (unspecified: this computer)
  if (zeros(0, 7) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routed by some)
  if (zeros(0, 5) && w[5] === 0xffff) return isLocalV4(v4Of(w[6], w[7])); // ::ffff:a.b.c.d mapped
  if (zeros(0, 6)) return isLocalV4(v4Of(w[6], w[7])); // ::a.b.c.d compatible
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return isLocalV4(v4Of(w[6], w[7])); // NAT64 64:ff9b::/96
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true; // 64:ff9b:1::/48, local-use NAT64
  if (w[0] === 0x2002) return isLocalV4(v4Of(w[1], w[2])); // 6to4 2002:a.b.c.d::/48
  return false;
}

// Whether a host name (as in a URL, brackets allowed) is local.
export function isLocalHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = parseV4(host);
  if (v4 !== null) return isLocalV4(v4);
  const v6 = parseV6(host);
  return v6 !== null && isLocalV6(v6);
}

export function isLocalNetwork(url) {
  let host;
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return false;
  }
  return isLocalHost(host);
}
