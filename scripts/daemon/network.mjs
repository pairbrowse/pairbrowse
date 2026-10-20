// A session's network at each launch (spec server-mode C4, C5; section 3.2 step 3): which proxy it
// uses (config.json's `network`, read from the file each time: net/config.mjs), the driver's proxy
// option with this computer's own addresses always around it, the strict switches, and for a proxy
// with a username and password the owner-only auth file the browser reads them from (C1). A
// session whose network can't be used is refused with one sentence, never launched direct instead.
// Then, once the browser is up and before any saved tab loads (section 3.2 step 6), the egress
// check (checkAtLaunch, C6, C7): the helper's probe through the proxy (started with forLaunch, so
// it runs while the browser starts), this computer's own exit when the proxy names no expectEgress,
// the browser's own read of the check address and its WebRTC gathering in an internal tab, judged
// by net/verdict.mjs. Anything but a pass (a timeout too) fails closed: the launch closes the
// browser, the session's next starts are refused with the reason for a while (or until config.json
// or secrets.env changes), pairbrowse_status says why, and the person is told once. Every launch
// goes through here, so a recovery after a crash is checked the same way. Each check is kept apart
// from the profile in the session's network.json (C9).
// While the browser runs, its exit is checked again every recheckMinutes (C8): the helper's probe
// through the same proxy (the browser's proxy can't change while it runs, and a check in the
// browser would open a tab in the person's window each time), compared with the exit before. An
// exit that moved, or a recheck that fails (proxy down, exit outside expectEgress or this
// computer's own), does what the proxy's onEgressChange says, once per change and once per run of
// failures: "pause" (the default) holds every agent as a person's Pause does (pause.mjs hold: a
// host's state mirrored into a session joined from here never lifts it; a person's Resume does),
// "notify" only tells, "ignore" lets an address change pass (rotating proxies) but still pauses on a
// failure, since its expectEgress is what keeps a rotating exit in bounds. The person is told in the
// window and, where hand-offs go to their channels (server mode, or Away: decision 8), with a
// "network" message through the hand-off notifier that names only the proxy and what happened.
//
// deps: log, notify(text) (the person's notification), pause(who) (holds every agent: pause.mjs
// hold; true when it wasn't already), channels(message) (a "network" message to the person's channels, notify/;
// resolves, or null when hand-offs don't go there now); configFile, secretsFile, runDir,
// observationsFile(session) (paths.mjs's, tests pass their own); probe, inBrowser, now, recheckMs
// (the interval, else RECHECK_MS or recheckMinutes), timers (tests).
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths, sessionFile } from "../paths.mjs";
import { isTemporary } from "../sessions.mjs";
import { readJson, writeJsonAtomic, within } from "../util.mjs";
import { loadSecrets } from "../rules/secrets.mjs";
import { testMs } from "../testenv.mjs";
import { readNetwork, networkFor, launchPart, applyLaunchPart, sessionRefusal, sessionShown, PROXY_AUTH_SWITCH } from "../net/config.mjs";
import { probeEgress, checkTargets } from "../net/probe.mjs";
import { checkInBrowser, GATHER_MS } from "../net/browsercheck.mjs";
import { egressVerdict, webrtcVerdict } from "../net/verdict.mjs";

// After a failed check, how long the session's next starts are refused without trying again
// (each try opens and closes a window); a change to config.json or secrets.env ends it sooner.
export const HOLD_MS = 60_000;
// The checks kept per session in its network.json (C9).
export const OBSERVATIONS_MAX = 50;

// Who pauses the agents when a proxy's exit changes: the name their results and the bars show.
export const RECHECK_PAUSER = "Proxy check";
// "14:35 UTC" in status lines: a server's own zone means nothing to the person.
const utc = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

// The auth file's name under ~/.pairbrowse/run: a fresh one each launch, like the pages' key file.
export const PROXY_AUTH_PREFIX = "proxy-auth-";

// The auth file (engine contract, patch 962): one line of JSON, this account's only (0600, in the
// 0700 run folder), a fresh name. Files a killed helper left behind go first: one helper per home,
// and the previous browser is closed when a launch starts. Not writeJsonAtomic: nothing reads this
// file while it is written (the browser it is named to starts after), and a rename gains nothing for
// a new owner-only file that `wx` already refuses to open over anything there.
export function writeProxyAuthFile(content, dir = paths.run) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(dir)) if (f.startsWith(PROXY_AUTH_PREFIX)) rmSync(join(dir, f), { force: true });
  const path = join(dir, PROXY_AUTH_PREFIX + randomBytes(16).toString("hex"));
  const line = `${JSON.stringify({ server: content.server, username: content.username, password: content.password })}\n`;
  writeFileSync(path, line, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600); // a umask can strip owner bits
  return path;
}
export function dropProxyAuthFile(path) {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* gone or unreachable: nothing to do */ }
}

export function createNetwork({ log = () => {}, notify = () => {}, pause = () => false, channels = () => null, configFile = paths.config, secretsFile = paths.secrets, runDir = paths.run,
  observationsFile = (session) => sessionFile(session, "network.json"), probe = probeEgress, inBrowser = checkInBrowser, now = Date.now,
  recheckMs = null, timers = { setTimeout, clearTimeout } } = {}) {
  let last = null; // the network of the browser started last: { session, id, source, strict } (no address)
  // Each launch's state, kept with the handle forLaunch returns ({ session, net, targets, early };
  // early: the helper's probes): the check reads only its own launch's, so a later forLaunch (a
  // Settings test, a recheck, a probe launch) can't take it away, and a handle without one fails.
  const launches = new WeakMap();
  // A launch whose check passed, until its browser is up (started): what its rechecks need
  // ({ session, net, targets, auth, baseline }; baseline: the exit the check read).
  const passed = new WeakMap();
  // The running browser's rechecks: { handle, session, net, targets, auth, baseline, failing, timer }
  // (failing: the last recheck failed and was acted on, so the next failures stay quiet), or null.
  let watch = null;
  let failure = null; // the last failed check: { session, id, text, at, stamp }
  let told = ""; // the failure the person was last notified of (session and reason): once each
  const checks = new Map(); // session -> its last check here ({ id, strict, verdict, loc, reason, at }), for status
  const memory = new Map(); // clean sessions' observations (never on disk)

  // The launch's network for `session` (profileNetwork: its browser profile's network id, Phase D;
  // shell: the browser's, browser/choice.mjs; native: a native build, which reads strict mode's
  // WebRTC switch in its own spelling). Throws the refusal sentence; else { id, source,
  // strict, proxy, apply(options), drop(), started() }: apply adds the proxy and switches to the
  // launch options (the user's --host-resolver-rules dropped and logged where the helper sets its
  // own), drop removes the auth file (once the browser is up, or its launch failed), started records
  // this network as the running browser's (called once the browser is up); checkAtLaunch takes it
  // as its launch. A launch attempt clears
  // the record first: one refused or failed leaves none. Nothing it logs names an address or a
  // credential.
  function forLaunch(session, { profileNetwork, shell = null, native = false } = {}) {
    last = null;
    const read = readNetwork(configFile);
    if (read.problem) throw new Error(sessionRefusal(session, read.problem));
    const net = networkFor({ network: read.network }, session, { profileNetwork });
    // Secrets are read from the file only for a proxy that needs them (and fresh: one set while
    // the helper runs counts at the next launch).
    const secrets = net.proxy?.auth && shell?.proxyAuthFile ? loadSecrets(secretsFile) : null;
    const part = launchPart(net, { shell, secrets, native });
    if (part.problem) throw new Error(part.problem);
    let authPath = null;
    if (part.authFile) {
      try { authPath = writeProxyAuthFile(part.authFile, runDir); } catch (e) {
        throw new Error(sessionRefusal(session, `the proxy's auth file couldn't be written (${e?.code || "error"})`));
      }
    }
    const record = { session, id: net.id, source: net.source, strict: !!net.proxy && net.strict };
    const args = authPath ? [...part.args, `${PROXY_AUTH_SWITCH}=${authPath}`] : part.args;
    if (net.proxy) log(`launch: network "${net.id}" (${net.source}${net.strict ? ", strict" : ""}${authPath ? ", auth file" : ""})`);
    const auth = part.authFile ? { username: part.authFile.username, password: part.authFile.password } : null;
    const own = { session, net, targets: null, early: null, auth };
    if (net.proxy) {
      // The helper's probes start now and run while the browser starts (C6 (1)): through the proxy
      // (its credentials as the auth file holds them, for an http: or https: proxy), and this
      // computer's own exit only when no expectEgress says where the proxy's should be. Both never
      // throw, and are bounded.
      const targets = own.targets = checkTargets(net);
      own.early = Promise.all([
        probe({ proxy: net.proxy, checkUrl: targets.checkUrl, auth, timeoutMs: targets.timeoutMs }),
        net.proxy.expectEgress ? Promise.resolve(null) : probe({ proxy: null, checkUrl: targets.directUrl, timeoutMs: targets.timeoutMs }),
      ]).catch(() => [null, null]);
    }
    const handle = {
      id: net.id, source: net.source, strict: record.strict, proxy: part.proxy,
      apply(options) {
        const { options: out, dropped } = applyLaunchPart(options, { ...part, args });
        if (dropped.length) log(`launch: ${dropped.join(", ")} in browserArgs dropped: a proxied session looks names up only through its proxy`);
        return out;
      },
      drop: () => { dropProxyAuthFile(authPath); authPath = null; },
      // The browser is up: its network is the running one, and its rechecks start (C8).
      started: () => { last = record; start(handle); },
    };
    launches.set(handle, own);
    return handle;
  }

  // When config.json and secrets.env last changed: a hold ends once either does.
  const stamp = () => [configFile, secretsFile].map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join("/");

  // The refusal the session's starts get while a failed check holds, else null.
  function refusal(session) {
    if (!failure || failure.session !== session) return null;
    if (now() - failure.at < HOLD_MS && failure.stamp === stamp()) return failure.text;
    failure = null; // the hold is over: the next start checks again
    return null;
  }

  // One check kept apart from the profile (C9): the session's network.json (0600, the last
  // OBSERVATIONS_MAX), or memory only for a clean session. Never this computer's own address.
  function observe(session, entry) {
    if (isTemporary(session)) { memory.set(session, [...(memory.get(session) || []), entry].slice(-OBSERVATIONS_MAX)); return; }
    const file = observationsFile(session);
    const old = readJson(file, null);
    const list = Array.isArray(old?.checks) ? old.checks : [];
    try { writeJsonAtomic(file, { version: 1, checks: [...list, entry].slice(-OBSERVATIONS_MAX) }, { mode: 0o600 }); } catch (e) {
      log(`network: the session's check couldn't be kept (${e?.code || "error"})`);
    }
  }
  const observations = (session) => (isTemporary(session) ? memory.get(session) || [] : readJson(observationsFile(session), null)?.checks || []);

  // The check after the launch (C6, C7; section 3.2 step 6), on the browser just started for
  // session (ctx, its context; launch, what forLaunch returned for it) before any saved tab loads.
  // { ok: true } (also for a direct session, which runs no check) or { ok: false, refusal }: also
  // for a launch this part has no state for (not forLaunch's, another session's, or checked
  // already), never a pass that skips the check. The caller closes the browser and fails the
  // launch with refusal. The check tab is opened and closed here, before the launch adopts any tab,
  // so tab memory and the strip never see it. Never throws.
  async function checkAtLaunch(ctx, session, launch) {
    const p = launch && typeof launch === "object" ? launches.get(launch) : null;
    if (p) launches.delete(launch);
    if (!p || p.session !== session) {
      log("network: a launch came to its check without its own network state; the browser closes");
      return { ok: false, refusal: `${sessionRefusal(session, "its network check had no record of this launch, so the browser closed")} Start it again.` };
    }
    if (!p.net.proxy) { if (failure?.session === session) failure = null; checks.delete(session); return { ok: true }; }
    const { net, targets } = p;
    const browserSide = await inBrowser(ctx, { checkUrl: targets.checkUrl, stun: targets.stun, timeoutMs: targets.timeoutMs }).catch(() => null);
    // The helper's probes are long done by now, or at most their own bound away.
    const [helper, direct] = (await within(targets.timeoutMs + GATHER_MS, p.early)) || [null, null];
    const egress = egressVerdict({ helper: helper || { ok: false, problem: "the check through the proxy didn't finish", timedOut: true },
      browser: browserSide?.browser || { ok: false, problem: "the browser's check didn't run" }, direct, expectEgress: net.proxy.expectEgress });
    const webrtc = webrtcVerdict(browserSide?.webrtc || { ok: false, problem: "the browser's check didn't run" }, { egress: egress.ip });
    // WebRTC counts only in strict mode: without it the person chose to let WebRTC go outside the
    // proxy (strict's policy is what keeps it in), so its gathering is recorded, not judged.
    const reason = egress.verdict !== "ok" ? egress.reason : net.strict && webrtc.verdict !== "ok" ? webrtc.reason : "";
    const ok = !reason;
    const at = now();
    observe(session, { at: new Date(at).toISOString(), kind: "launch", proxy: net.id, server: net.proxy.server,
      browser: { ip: browserSide?.browser?.ok ? browserSide.browser.ip : null, loc: browserSide?.browser?.ok ? browserSide.browser.loc : null },
      helper: { ip: helper?.ok ? helper.ip : null, loc: helper?.ok ? helper.loc : null }, sameAsDirect: egress.sameAsDirect,
      webrtc: { candidates: webrtc.candidates, verdict: webrtc.verdict }, dns: net.strict || net.proxy.scheme === "socks5" ? "strict" : "local",
      verdict: ok ? "ok" : "failed", reason });
    checks.set(session, { id: net.id, strict: net.strict, verdict: ok ? "ok" : "failed", loc: ok ? egress.loc : null, reason, at });
    if (ok) {
      if (failure?.session === session) failure = null;
      told = "";
      passed.set(launch, { session, net, targets, auth: p.auth, baseline: egress.ip });
      log(`network: "${net.id}" passed its check at launch${egress.loc ? ` (exit country ${egress.loc})` : ""}`);
      return { ok: true };
    }
    const head = sessionRefusal(session, `network "${net.id}" failed its check before any saved tab opened, so the browser closed`);
    const text = `${head} ${reason} Nothing went around the proxy. Fix the proxy or config.json's network; the next start checks again (at once after a change to config.json or secrets.env, else after a minute).`;
    failure = { session, id: net.id, text, at, stamp: stamp() };
    log(`network: "${net.id}" failed its check at launch: ${reason}`);
    const key = `${session}\u0001${reason}`;
    if (told !== key) {
      told = key;
      try { notify(`${sessionRefusal(session, `its proxy "${net.id}" failed the check`)} Nothing went around it. See pairbrowse_status or daemon.log.`); } catch {}
    }
    return { ok: false, refusal: text };
  }

  // What pairbrowse_status adds about session's network (serve/tools/status.mjs more): a failed
  // check that holds, else the last check of the browser running now. Never an address or credential.
  function statusParts(session) {
    const held = refusal(session);
    if (held) return [`warning: ${held}`];
    const c = last?.session === session ? checks.get(session) : null;
    if (!last || last.session !== session || !last.id || !c) return [];
    const name = `network "${c.id}"${c.strict ? " (strict)" : ""}`;
    const country = c.loc ? `, country ${c.loc}` : "";
    const after = c.paused ? " Agents were paused for it until a person resumes them." : c.told ? " You were told; agents went on." : "";
    if (c.kind === "recheck" && c.verdict === "failed") return [`warning: ${name} failed its recheck at ${utc(c.at)}: ${c.reason}${after}`];
    if (c.kind === "recheck" && c.verdict === "changed" && c.told) return [`warning: ${name}: its exit address changed at ${utc(c.at)}${country}.${after}`];
    if (c.kind === "recheck") return [`${name}: exit checked at launch, last rechecked at ${utc(c.at)}${country}`];
    return [`${name}: exit checked at launch${country}`];
  }

  // The rechecks of the browser started with handle (its check passed): every recheckMinutes (or
  // recheckMs, RECHECK_MS) until stop. Any rechecks before stop; a direct session has none.
  function start(handle) {
    stop();
    const s = passed.get(handle);
    passed.delete(handle);
    if (!s?.net.proxy) return;
    const ms = recheckMs ?? testMs("RECHECK_MS", s.net.recheckMinutes * 60_000);
    const w = watch = { handle, ...s, failing: false, timer: null };
    const next = () => {
      w.timer = timers.setTimeout(() => { recheck(w).catch(() => {}).finally(() => { if (watch === w) next(); }); }, ms);
      w.timer?.unref?.();
    };
    next();
  }
  // The browser of handle closed (or, without one, whichever runs): its rechecks end. A late close
  // of an older browser never ends the next one's.
  function stop(handle = null) {
    if (!watch || (handle && watch.handle !== handle)) return;
    timers.clearTimeout(watch.timer);
    watch = null;
  }

  // One recheck of the running browser's exit (C8), w its watch. A result that comes back after
  // its browser closed (or another started) is dropped. Never throws.
  async function recheck(w = watch) {
    if (!w || watch !== w) return null;
    const { session, net, targets } = w;
    const [helper, direct] = (await within(targets.timeoutMs + 1000, Promise.all([
      probe({ proxy: net.proxy, checkUrl: targets.checkUrl, auth: w.auth, timeoutMs: targets.timeoutMs }),
      net.proxy.expectEgress ? Promise.resolve(null) : probe({ proxy: null, checkUrl: targets.directUrl, timeoutMs: targets.timeoutMs }),
    ]).catch(() => null))) || [null, null];
    if (watch !== w) return null;
    // The helper's read stands for the browser's: the same proxy, which the browser can't leave
    // while it runs (its launch check showed both agree).
    const read = helper || { ok: false, problem: "the check through the proxy didn't finish", timedOut: true };
    const egress = egressVerdict({ helper: read, browser: read, direct, expectEgress: net.proxy.expectEgress, baseline: w.baseline });
    const at = now();
    observe(session, { at: new Date(at).toISOString(), kind: "recheck", proxy: net.id, server: net.proxy.server, browser: null,
      helper: { ip: helper?.ok ? helper.ip : null, loc: helper?.ok ? helper.loc : null }, sameAsDirect: egress.sameAsDirect, webrtc: null,
      dns: net.strict || net.proxy.scheme === "socks5" ? "strict" : "local", verdict: egress.verdict, reason: egress.reason });
    const check = { id: net.id, strict: net.strict, kind: "recheck", verdict: egress.verdict, loc: egress.loc, reason: egress.reason, at, paused: false, told: false };
    const before = checks.get(session);
    if (egress.verdict === "ok") {
      if (w.failing) log(`network: "${net.id}" passed its recheck again`);
      w.failing = false;
      checks.set(session, check);
      return egress.verdict;
    }
    if (egress.verdict === "changed") { w.baseline = egress.ip; w.failing = false; }
    if (egress.verdict === "failed" && w.failing) {
      // Acted on already: the same run of failures is said once.
      checks.set(session, { ...check, paused: !!before?.paused, told: !!before?.told });
      return egress.verdict;
    }
    if (egress.verdict === "failed") w.failing = true;
    Object.assign(check, act(session, net, egress.verdict, at));
    checks.set(session, check);
    return egress.verdict;
  }

  // What the proxy's onEgressChange does for a change or a failed recheck: { paused, told }.
  function act(session, net, change, at) {
    const mode = net.proxy.onEgressChange || "pause";
    if (change === "changed" && mode === "ignore") {
      log(`network: "${net.id}" exit address changed at its recheck (onEgressChange "ignore")`);
      return { paused: false, told: false };
    }
    const pausing = mode !== "notify";
    if (pausing) try { pause(RECHECK_PAUSER); } catch {}
    log(`network: "${net.id}" ${change === "changed" ? "exit address changed at its recheck" : "failed its recheck"}${pausing ? "; agents paused" : "; agents go on (onEgressChange \"notify\")"}`);
    const what = change === "changed" ? `the exit address of its proxy "${net.id}" changed` : `its proxy "${net.id}" failed its recheck`;
    const then = pausing ? "Agents are paused until you resume them." : "Agents go on (onEgressChange \"notify\").";
    try { notify(`Session ${sessionShown(session)}: ${what}. ${then} Nothing went around the proxy. See pairbrowse_status or daemon.log.`); } catch {}
    const message = { kind: "network", network: net.id, change, paused: pausing, at };
    try {
      Promise.resolve(channels(message)).then((r) => {
        if (r?.failed?.length && !r.sent?.length) log(`network: no channel took the "${net.id}" message`);
      }, () => {});
    } catch {}
    return { paused: pausing, told: true };
  }

  return {
    forLaunch, checkAtLaunch, refusal, statusParts, observations,
    // stop(handle): the browser forLaunch gave handle for closed; its rechecks end. recheck(): one
    // now, for the running browser (tests): its verdict, or null with none running.
    stop, recheck: () => recheck(),
    // The network of the browser started last ({ session, id, source, strict }), or null before
    // any, and from the start of a launch until that browser is up.
    current: () => last,
    // Whether the browser started last is a strict proxied session (C11 reads it).
    strict: () => !!last?.strict,
  };
}
