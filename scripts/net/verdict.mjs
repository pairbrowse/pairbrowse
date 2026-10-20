// What a session's egress checks mean (spec server-mode C6, C7, C8): the exit address a proxied
// session's traffic leaves from, as the helper measured it through the proxy (net/probe.mjs) and
// as the browser measured it (net/browsercheck.mjs), against the proxy's expectEgress, this
// computer's own direct exit and the last check's address; and the WebRTC candidates the browser
// gathered. Fail closed: a check that failed or timed out, or an answer that can't be read, is a
// failure, never a pass. Reasons are one sentence each and never name an exit address or this
// computer's (they reach status, tool refusals and notifications; a probe's problem in one names
// only the proxy's host:port); the exit addresses stay in what the caller records.
//
// Pure; Node's standard library only.
import { parseV4, parseV6 } from "../rules/network.mjs";

// An address in one spelling: a dotted-quad IPv4, or an IPv6 address lower-case with its longest
// run of zero groups written "::" (an IPv4-mapped one stays IPv6). null for anything else.
export function normalIp(value) {
  const s = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const n = parseV4(s);
    return n === null || !s.split(".").every((p) => p === String(Number(p))) ? null : s;
  }
  if (s.includes("%")) return null;
  const w = parseV6(s);
  if (!w) return null;
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (w[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  const hex = w.map((x) => x.toString(16));
  if (best[1] < 2) return hex.join(":");
  return `${hex.slice(0, best[0]).join(":")}::${hex.slice(best[0] + best[1]).join(":")}`;
}

// Whether address `ip` (normalIp's) is in range "a/bits" or equal to address "a".
function inRange(ip, item) {
  const [addr, bitsText] = item.split("/");
  if (!ip.includes(":")) {
    const v4 = parseV4(ip), r4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) ? parseV4(addr) : null;
    if (v4 === null || r4 === null) return false;
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    const size = 2 ** (32 - bits);
    return Math.floor(v4 / size) === Math.floor(r4 / size);
  }
  const w = parseV6(ip), r = addr.includes(":") ? parseV6(addr) : null;
  if (!w || !r) return false;
  let bits = bitsText === undefined ? 128 : Number(bitsText);
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits), mask = (0xffff << (16 - take)) & 0xffff;
    if ((w[i] & mask) !== (r[i] & mask)) return false;
  }
  return true;
}

// Whether an exit (address ip, two-letter country loc) meets a proxy's expectEgress (the list
// net/config.mjs checked: addresses, ranges, "country:XX"). Addresses and countries are each
// required when named: the address must be in one of the listed addresses or ranges, and the
// country one of the listed countries. null when there is no expectation (null or []).
export function inExpected(ip, loc, expectEgress) {
  if (!Array.isArray(expectEgress) || !expectEgress.length) return null;
  const countries = expectEgress.filter((e) => /^country:[A-Z]{2}$/.test(e)).map((e) => e.slice(8));
  const ranges = expectEgress.filter((e) => !e.startsWith("country:"));
  const addr = normalIp(ip);
  if (ranges.length && !(addr && ranges.some((r) => inRange(addr, r)))) return false;
  if (countries.length && !countries.includes(String(loc || "").toUpperCase())) return false;
  return true;
}

// The egress verdict of one check. helper and browser: the two probes' results ({ ok, ip, loc } or
// { ok: false, problem }); direct: this computer's own exit probed without the proxy (same shape;
// null or failed: not known, as in a network whose only way out is the proxy); expectEgress: the
// proxy's list or null; baseline: the address of the check before (a recheck), or null.
// { verdict, reason, ip, loc, sameAsDirect }: verdict "ok", "failed" (C7: the session must not
// run) or "changed" (C8: the exit moved since the baseline; what follows is onEgressChange's);
// reason one sentence without an address ("" when ok); ip and loc the browser's exit when read;
// sameAsDirect true, false, or null when the direct exit isn't known. Never stores or returns the
// direct address.
export function egressVerdict({ helper, browser, direct = null, expectEgress = null, baseline = null } = {}) {
  const out = (verdict, reason, extra = {}) => ({ verdict, reason, ip: null, loc: null, sameAsDirect: null, ...extra });
  const failed = (r) => (r?.timedOut ? "timed out" : "failed");
  if (!helper?.ok) return out("failed", `The check through the proxy ${failed(helper)}${helper?.problem ? `: ${clause(helper.problem)}` : ""}.`);
  if (!browser?.ok) return out("failed", `The browser's own check ${failed(browser)}${browser?.problem ? `: ${clause(browser.problem)}` : ""}.`);
  const hip = normalIp(helper.ip), bip = normalIp(browser.ip);
  if (!hip || !bip) return out("failed", "A check answered without an exit address that can be read.");
  const loc = /^[A-Z]{2}$/.test(String(browser.loc || "")) ? browser.loc : null;
  const dip = direct?.ok ? normalIp(direct.ip) : null;
  const sameAsDirect = dip ? dip === bip : null;
  const read = { ip: bip, loc, sameAsDirect };
  if (hip !== bip) return out("failed", "The browser's traffic leaves from a different address than the proxy's, so it isn't going only through the proxy.", read);
  const expected = inExpected(bip, loc, expectEgress);
  if (expected === false) return out("failed", "The proxy's exit address is outside the addresses or countries its expectEgress lists.", read);
  if (expected === null && sameAsDirect) return out("failed", "The proxy's exit address is this computer's own, so the traffic isn't leaving through the proxy.", read);
  const before = baseline ? normalIp(baseline) : null;
  if (before && before !== bip) return out("changed", "The proxy's exit address changed since the last check.", read);
  return out("ok", "", read);
}
// A problem as a clause inside a sentence (no closing full stop).
const clause = (s) => String(s).replace(/\.+\s*$/, "");

// One ICE candidate line ("candidate:1 1 udp 2122260223 192.0.2.4 54321 typ host ...", with or
// without the "a=" prefix): { address, type, related } (related: raddr, or null), or null.
export function parseCandidate(line) {
  const parts = String(line ?? "").trim().replace(/^a=/, "").split(/\s+/);
  if (!/^candidate:/.test(parts[0] || "") || parts.length < 8 || parts[6] !== "typ") return null;
  const at = parts.indexOf("raddr");
  return { address: parts[4], type: parts[7], related: at > 0 ? parts[at + 1] || null : null };
}

const MDNS = /^[0-9a-f-]+\.local$/i;
const UNSPECIFIED = ["0.0.0.0", "::"];

// What one address in a candidate shows: "mdns" (a random .local name, no address), "none"
// (unspecified), "egress" (the proxy's exit), or "address" (any other address: a leak).
function addressKind(value, egress) {
  const s = String(value || "");
  if (MDNS.test(s)) return "mdns";
  const ip = normalIp(s);
  if (!ip) return "unreadable";
  if (UNSPECIFIED.includes(ip)) return "none";
  return egress && ip === egress ? "egress" : "address";
}

// The WebRTC verdict (C7): gather is the browser's gathering ({ ok, candidates: [lines] } or
// { ok: false, problem, timedOut }), egress the proxy's exit address (the egress verdict's ip).
// A candidate whose address, or related address, is anything but an mDNS name, the unspecified
// address or the proxy's exit is a leak (a host or srflx candidate with this computer's address);
// one that can't be read counts as one too. { verdict, reason, candidates }: verdict "ok", "leak"
// or "failed" (the gathering failed or didn't finish: never a pass); candidates [{ type, kind }]
// with no address (what the observation file keeps).
export function webrtcVerdict(gather, { egress = null } = {}) {
  if (!gather?.ok) {
    const how = gather?.timedOut ? "didn't finish in time" : "failed";
    return { verdict: "failed", reason: `The WebRTC check ${how}${gather?.problem ? `: ${clause(gather.problem)}` : ""}.`, candidates: [] };
  }
  const exit = egress ? normalIp(egress) : null;
  const candidates = (Array.isArray(gather.candidates) ? gather.candidates : []).map((line) => {
    const c = parseCandidate(line);
    if (!c) return { type: "unknown", kind: "unreadable" };
    const kinds = [addressKind(c.address, exit), ...(c.related ? [addressKind(c.related, exit)] : [])];
    const bad = kinds.find((k) => k === "address" || k === "unreadable");
    return { type: /^[a-z]{1,8}$/.test(c.type) ? c.type : "unknown", kind: bad || kinds[0] };
  });
  const leaks = candidates.filter((c) => c.kind === "address" || c.kind === "unreadable");
  if (leaks.length) {
    const types = [...new Set(leaks.map((c) => c.type))].join(", ");
    return { verdict: "leak", reason: `WebRTC shows an address other than the proxy's exit (${types} candidate${leaks.length > 1 ? "s" : ""}), so a page could see this computer's address.`, candidates };
  }
  return { verdict: "ok", reason: "", candidates };
}
