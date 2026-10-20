// The Network section's part of the helper (spec server-mode C14): Settings (the browser's own page
// and the live view's owner page) reads and changes config.json's `network` here, through the
// owner-only routes in liveview/routes/network.mjs. What a change does is net/settings.mjs's; here
// the files are read and written: config.json's `network` is replaced whole (the rest of the file
// kept as written; never saveConfig, whose schema check would refuse a change over an unrelated
// proxy's problem, nor a config.json that can't be parsed: nothing is written then), and the
// proxy's username and password go only to secrets.env through the helper's secret store (so
// every log and what agents read mask them from that moment). A credential is never in an answer,
// event or log line: the summary says only whether each is saved.
// Test runs the helper's egress probe (net/probe.mjs, C6 (1)) through the proxy as the form or
// config.json has it, and this computer's own exit to compare when the proxy has no expectEgress,
// judged as a recheck is (net/verdict.mjs, the helper's read for both sides); its answer has the
// exit address and country, the verdict, and the coherence items (rules/coherence.mjs, C13) of the
// browser's time zone and languages against that country. The browser-side checks (its own read,
// WebRTC, names) need a running browser on that proxy: they run when a session using it starts.
// Nothing about a test is kept or logged but that one ran and its verdict.
import { readFileSync } from "node:fs";
import { paths } from "../paths.mjs";
import { writeJsonAtomic, within } from "../util.mjs";
import { listSessions } from "../sessions.mjs";
import { setReservedSecret, deleteSecret } from "../rules/secrets.mjs";
import { localeVsEgress } from "../rules/coherence.mjs";
import { checkNetwork } from "../net/config.mjs";
import { proxySecretNames } from "../net/credentials.mjs";
import { networkSummary, networkChange, readNetworkOp, readProxyForm } from "../net/settings.mjs";
import { probeEgress, checkTargets } from "../net/probe.mjs";
import { egressVerdict } from "../net/verdict.mjs";

// What a test can't tell from the helper alone.
export const TEST_NOTE = "The browser's own read, WebRTC and its name lookups are checked when a session using this proxy starts.";

// config.json as written: { config } (an object; {} when there is none) or { problem }.
export function readConfigFile(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { config: {} };
    return { problem: `config.json couldn't be read (${e?.code || "error"}). Fix it, then try again; nothing was changed.` };
  }
  if (!text.trim()) return { config: {} };
  let read;
  try { read = JSON.parse(text); } catch { return { problem: "config.json isn't valid JSON. Fix it or remove it, then try again; nothing was changed." }; }
  if (read === null) return { config: {} };
  if (typeof read !== "object" || Array.isArray(read)) return { problem: "config.json isn't an object { ... }. Fix it or remove it, then try again; nothing was changed." };
  return { config: read };
}

// The browser's time zone and languages (what pages read), from config.json's "pairbrowse"
// settings on the native build (timezone, acceptLanguage, geoip), else this computer's own.
// { timezone, languages, geoip: { timezone, languages } }: geoip says which of the two it supplies
// from the exit, since a time zone or languages set there still win over it (native-engine.mjs).
export function localeOf(config, { native = false } = {}) {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  const own = native && config?.pairbrowse && typeof config.pairbrowse === "object" ? config.pairbrowse : {};
  const zoneSet = typeof own.timezone === "string" && !!own.timezone;
  const langSet = typeof own.acceptLanguage === "string" && !!own.acceptLanguage;
  const timezone = zoneSet ? own.timezone : intl.timeZone;
  const langs = langSet ? own.acceptLanguage.split(",").map((t) => t.split(";")[0].trim()).filter(Boolean) : [intl.locale];
  const geo = own.geoip === true;
  return { timezone, languages: langs, geoip: { timezone: geo && !zoneSet, languages: geo && !langSet } };
}

// configFile: config.json (paths.mjs's). secrets: the helper's secret store (rules/secrets.mjs
// secretStore: reload(), update(fn)). sessions(): the kept sessions' names. locale(): as localeOf.
// probe: net/probe.mjs probeEgress (tests pass a stand-in). log(line).
// -> { read(), write(op), test(op) }: read the summary (net/settings.mjs networkSummary); write
// { text, network } or { error }; test { verdict, ... } or { error }.
export function createNetworkSettings({ configFile = paths.config, secrets, sessions = () => listSessions().filter((s) => !s.temporary).map((s) => s.name),
  locale = () => localeOf({}), probe = probeEgress, log = () => {} } = {}) {
  // secrets.env as it is on disk now (credentials are often added to it by hand), never the
  // store's copy from its last save: { values, problem }, the problem saying why the file is
  // unusable (else empty).
  const onDisk = () => {
    if (!secrets) return { values: {}, problem: "" };
    const now = secrets.reload();
    return { values: now?.values || {}, problem: now?.problem || "" };
  };
  const sessionNames = () => { try { return sessions(); } catch { return []; } };
  function read() {
    const file = readConfigFile(configFile);
    const s = onDisk();
    return networkSummary(file.config?.network, { sessions: sessionNames(), values: s.values, problem: file.problem || "", secretsProblem: s.problem });
  }
  function write(op) {
    const file = readConfigFile(configFile);
    if (file.problem) return { error: file.problem };
    const s = onDisk();
    const r = networkChange(file.config.network, op, { values: s.values, secretsProblem: s.problem });
    if (r.error) return r;
    // Saved credentials first (a change that needs them is written only once they are there),
    // removed ones last (config.json no longer names them by then). Each applies to the file as
    // it is on disk when written, so nothing added to it by hand meanwhile is lost.
    const store = (steps) => secrets.update((now) => {
      let next = now;
      for (const step of steps) { next = step(next); if (next.error) return next; }
      return next;
    });
    const sets = Object.entries(r.set);
    if (sets.length) {
      if (!secrets) return { error: "PairBrowse can't save passwords from here: restart PairBrowse, then save again." };
      try { store(sets.map(([name, value]) => (cur) => setReservedSecret(cur, { name, value }))); } catch (e) {
        return { error: `Not saved: secrets.env can't be written (${e?.message || e}). Fix it (yours alone, not a link), then save again.` };
      }
    }
    try { writeJsonAtomic(configFile, { ...file.config, network: r.network }); } catch (e) {
      return { error: `Not saved: config.json couldn't be written (${e?.code || "error"}). Check that PairBrowse's folder can be written, then try again.` };
    }
    if (r.remove.length && secrets) {
      try { store(r.remove.map((name) => (cur) => deleteSecret(cur, name))); } catch (e) {
        log(`network: a removed proxy's username and password stayed in secrets.env (${e?.message || e})`);
      }
    }
    log(`network: ${r.text} (from Settings)`);
    return { text: r.text, network: read() };
  }

  let testing = false;
  async function test(given) {
    const op = readNetworkOp(given);
    if (op.error) return op;
    if (op.op !== "test") return { error: "Not a test." };
    const f = readProxyForm(op, { needId: false });
    if (f.error) return f;
    if (testing) return { error: "A test is running already. Wait for its result." };
    const file = readConfigFile(configFile);
    const checked = checkNetwork(file.config?.network);
    const entry = f.id && checked.network?.proxies?.[f.id] ? checked.network.proxies[f.id] : null;
    let auth = null;
    if (f.auth) {
      const names = proxySecretNames(f.id || "");
      const s = !f.username || !f.password ? onDisk() : { values: {}, problem: "" };
      const username = f.username || (names ? s.values[names.username] : "") || "";
      const password = f.password || (names ? s.values[names.password] : "") || "";
      if (!username || !password) return { error: s.problem ? `Enter the username and password to test with: the saved ones can't be read. ${s.problem}` : "Enter the username and password to test with (or save them first)." };
      auth = { username, password };
    }
    testing = true;
    try {
      const targets = checkTargets({ checkUrl: checked.network?.checkUrl });
      const proxy = { id: f.id, server: f.server, scheme: f.scheme, host: f.host, port: f.port };
      const expectEgress = entry?.expectEgress || null;
      const [helper, direct] = (await within(targets.timeoutMs + 1000, Promise.all([
        probe({ proxy, checkUrl: targets.checkUrl, auth, timeoutMs: targets.timeoutMs }),
        expectEgress ? Promise.resolve(null) : probe({ proxy: null, checkUrl: targets.directUrl, timeoutMs: targets.timeoutMs }),
      ]).catch(() => null))) || [null, null];
      const read = helper || { ok: false, problem: "no answer in time; check that the proxy runs and its host and port are right", timedOut: true };
      const egress = egressVerdict({ helper: read, browser: read, direct, expectEgress });
      const exit = read.ok ? { ip: read.ip, country: read.loc || null } : null;
      const here = locale();
      // A value geoip supplies follows the exit, so only the ones set here are compared.
      const geo = here.geoip === true ? { timezone: true, languages: true } : here.geoip || {};
      const judged = { timezone: geo.timezone ? null : here.timezone, languages: geo.languages ? null : here.languages };
      const coherence = exit?.country ? localeVsEgress({ timezone: judged.timezone, languages: judged.languages || [], country: exit.country }) : [];
      log(`network: Settings tested ${f.id ? `"${f.id}"` : "a proxy"}: ${egress.verdict === "ok" ? "passed" : "failed"}`);
      return {
        verdict: egress.verdict === "ok" ? "ok" : "failed",
        reason: egress.verdict === "ok" ? "" : egress.reason,
        exit,
        sameAsDirect: egress.sameAsDirect,
        coherence,
        // geoip sets the time zone and languages from the exit at each launch: nothing to compare
        // ("geoip"); else the values compared, null for one geoip supplies.
        locale: geo.timezone && geo.languages ? "geoip" : judged,
        note: TEST_NOTE,
      };
    } finally {
      testing = false;
    }
  }
  return { read, write, test };
}
