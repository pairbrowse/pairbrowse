// Reading a browser's NetLog (the file --log-net-log writes; a helper the harness started writes
// one with PAIRBROWSE_TEST_NETLOG=1, scripts/testenv.mjs) for the leak tests (spec server-mode
// C12): which names the browser's own resolver was asked for, and which of them are leaks.
//
// The file is one JSON object: "constants" (event type names to numbers, among them), then
// "events", one per line. A browser that ended without closing it leaves the list unfinished, so
// a file that doesn't parse whole is read up to its last complete event.
import { readFileSync } from "node:fs";

// The NetLog in `text`: { constants, events }. Throws when not even its constants are there.
export function parseNetLog(text) {
  try { return JSON.parse(text); } catch { /* unfinished: cut below */ }
  const lines = String(text).split("\n");
  for (let n = lines.length; n > 0; n--) {
    const head = lines.slice(0, n).join("\n").replace(/,\s*$/, "");
    try { return JSON.parse(`${head}]}`); } catch { /* one line shorter */ }
  }
  throw new Error("not a NetLog: no constants and events in it");
}
export const readNetLog = (file) => parseNetLog(readFileSync(file, "utf8"));

// A resolver's host as the NetLog writes it ("http://name.test", "name.test:443", "[::1]:80",
// "https://[2001:db8::1]:8443") as the bare name or address, lower-case.
export function bareHost(host) {
  let h = String(host).trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.replace(/\/.*$/, "");
  const v6 = /^\[([^\]]*)\]/.exec(h);
  if (v6) return v6[1];
  if ((h.match(/:/g) || []).length === 1) h = h.replace(/:\d*$/, "");
  return h;
}

// Every name the browser's resolver was asked for: the host of each resolver event (event types
// HOST_RESOLVER_* and DNS_*, their "host" or "hostname"), in the order asked, each once.
export function resolvedHosts(log) {
  const types = new Map(Object.entries(log?.constants?.logEventTypes || {}).map(([name, n]) => [n, name]));
  const seen = new Set();
  for (const e of log?.events || []) {
    if (!/^(?:HOST_RESOLVER|DNS_)/.test(types.get(e?.type) || "")) continue;
    const h = e.params?.host ?? e.params?.hostname;
    if (typeof h === "string" && h) seen.add(bareHost(h));
  }
  return [...seen];
}

// This computer's own names and addresses: never a leak (the driver and the helper's own pages
// use them, and strict mode keeps them out of the proxy, spec server-mode C5).
export const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
// What strict mode's resolver rule ("MAP * ~NOTFOUND", net/config.mjs resolverRule) turns every
// other name into before the resolver sees it: the asked name never reaches a lookup.
export const MAPPED_AWAY = "~notfound";

// The names the browser looked up itself other than the proxy's host, loopback and the strict
// rule's ~NOTFOUND: each one is a lookup outside the proxy, a leak.
export function dnsLeaks(log, { proxyHost }) {
  const allowed = new Set([...LOOPBACK, MAPPED_AWAY, bareHost(proxyHost)]);
  return resolvedHosts(log).filter((h) => !allowed.has(h) && !h.endsWith(".localhost"));
}
