// A launch's graphics (spec server-mode section 3.2 steps 4 and 7; Phase E: E2, E3, E4, E6, E7, E9).
// before(...), step 4, before the browser starts: the measurement this build, engine pack and
// screen were measured with (the profile's validation[build].graphics), or, the first launch per
// runtime, a measurement made now in a throwaway probe browser of its own (native/check.mjs
// graphicsCheck over native/probe.mjs; logged "measuring graphics once for this browser version",
// never a tab of the person's browser); then every static compatibility error (native/graphics.mjs
// compatErrors: a backend that isn't there, an unmet graphics.require, a legacy config.json GPU
// identity the measured backend can't back, a profile screen that differs from the virtual
// screen) refuses the start, all named, nothing applied partly. A GPU or a requirement with
// nothing measured is "could not confirm", a refusal too.
// after(ctx, plan), step 7, once the browser runs and its network passed: the browser process's
// own backend (native/backend.mjs readBackend), this runtime's key, a GPU asked for over a
// software or unverified read refused, and the verdict (profiles/validate.mjs measuredEntry over
// native/validate.mjs) filed with the profile for its build; a backend.requested or
// backend.stable mismatch, or (with requireValidatedProfiles) anything but "validated", refuses,
// and the launch closes the browser. A measurement of another runtime (driver, display or
// switches changed) counts for nothing and is dropped, so the next start measures again; a probe
// that doesn't match either isn't repeated until the helper restarts (a probe and a browser that
// never agree), and nothing is dropped over a backend read that failed (an unverified read proves
// nothing changed).
// GRAPHICS (native/graphics.mjs) holds what pairbrowse_status says (statusParts); diagnostics
// read only its kind and status (summary).
//
// st: the browser's state (st.graphics: the running browser's, or null; st.probing: true while a
// probe runs). deps: config, log, status and hud (the live view's status line while a probe
// runs); tests pass probeGraphics (graphicsCheck's place), readBackendOf, platform, arch and
// scratch. api: onProbing (a probe starts: launch.mjs tells the calls waiting on it to retry), profiles
// (sessions/profiles.mjs fileValidation).
import { mkdirSync } from "node:fs";
import { graphicsCheck } from "../../native/check.mjs";
import { readBackend, unverifiedBackend } from "../../native/backend.mjs";
import { GRAPHICS, compatErrors, runtimeKey, graphicsStatusPart } from "../../native/graphics.mjs";
import { measuredEntry } from "../../profiles/validate.mjs";
import { launchableBrowserArgs, browserArgsOf } from "../../browser-args.mjs";
import { paths } from "../../paths.mjs";

export const MEASURING_GRAPHICS = "launch: measuring graphics once for this browser version";
export const MEASURING_GRAPHICS_STATUS = "Measuring this browser's graphics once (a minute or two): the browser opens after that.";
// What a call waiting on the start hears while a probe runs (launch.mjs getContext).
export const MEASURING_BUSY = "PairBrowse is measuring this browser's graphics once (a minute or two). Tell the user, then retry the last action in a minute.";
const RUNTIME_PLATFORMS = { darwin: "macos", linux: "linux" };
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export function createGraphics(st, deps = {}, api = {}) {
  const { config = {}, log = () => {}, status = () => {}, hud = null } = deps;
  const { onProbing = () => {} } = api;
  const { probeGraphics = graphicsCheck, readBackendOf = readBackend, platform = process.platform, arch = process.arch, scratch = paths.browser } = deps;
  // Runtimes whose probe failed in this helper's run: not probed again until it restarts (a
  // probe that can't finish would otherwise hold every start for its whole bound).
  const failed = new Set();
  // Runtimes whose probe of this run wasn't kept (its key didn't match the browser it measured
  // for, or that browser's read failed): not probed again until the helper restarts either (a
  // probe whose key the browser's never matches would otherwise run at every start).
  const remeasured = new Set();
  const runtimeOf = (chosen, build, pack, display) => [chosen?.id, build, pack, display].join("|");
  st.graphics = null;
  st.probing = false;

  // Step 4. chosen: sessions/profiles.mjs forLaunch's answer (its request and the measurement kept
  // for this build and pack). native: the native build starts; build, pack: its version and engine
  // pack. screen: the virtual screen (supervise.mjs), or null. probeLaunch(directory): the probe's
  // browser start, as this launch would start it (native/check.mjs probeLauncher). session: for
  // the refusal. Answers the plan after() reads; throws the refusal.
  async function before({ chosen, native, build = null, pack = null, screen = null, probeLaunch = null, session = "" }) {
    st.graphics = null;
    const request = isObject(chosen?.request?.graphics) ? chosen.request.graphics : { backend: "auto", require: null };
    const where = RUNTIME_PLATFORMS[platform] ?? null;
    const display = screen ? "xvfb" : "native";
    const geometry = screen?.geometry ?? null;
    const plan = { native: !!native, build, pack, where, display, geometry, request, name: chosen?.name || "default", measured: null, source: null, runtime: runtimeOf(chosen, build, pack, display) };
    if (!native) return plan; // the open build: its profile's graphics fields refused by its mapping (D11)
    const kept = chosen?.measured;
    if (isObject(kept) && kept.runtime?.platform === where && kept.runtime?.arch === arch && kept.runtime?.display === display) {
      plan.measured = kept;
      plan.source = "stored";
    } else if (where && build && typeof probeLaunch === "function") {
      const { runtime } = plan;
      if (remeasured.has(runtime)) log("launch: graphics unverified for this start: its measurement wasn't kept for this browser; measured again when the helper next starts");
      else if (!failed.has(runtime)) {
        log(MEASURING_GRAPHICS);
        status({ text: MEASURING_GRAPHICS_STATUS, kind: "claude" });
        st.probing = true;
        try { onProbing(); } catch {}
        let measured = null;
        try {
          mkdirSync(scratch, { recursive: true, mode: 0o700 });
          const line = await probeGraphics({ launch: probeLaunch, build, pack, display, platform, scratch, log, onMeasured: (m) => { measured = m; } });
          log(`launch: ${line}`);
        } catch (e) { log(`launch: graphics not measured: ${e?.message || e}`); } finally { st.probing = false; if (hud) status(hud.badge()); }
        if (measured) { plan.measured = measured; plan.source = "probe"; } else {
          failed.add(runtime);
          log("launch: graphics unverified for this start; measured again when the helper next starts");
        }
      }
    }
    // A GPU or a requirement with nothing measured can't be confirmed (E9): an unverified read.
    const confirm = request.backend === "gpu" || isObject(request.require);
    const measured = plan.measured ?? (confirm ? { backend: unverifiedBackend("not measured") } : null);
    const errors = compatErrors({ name: plan.name, graphics: request, platform, browserKind: "pairbrowse", measured, userArgs: launchableBrowserArgs(browserArgsOf(config), platform),
      display: geometry, screen: chosen?.request?.screen ?? null, legacy: config.pairbrowse ?? null });
    if (errors.length) throw refusal(session, errors);
    return plan;
  }

  // Step 7. ctx: the running browser; plan: before()'s. chosen: forLaunch's answer (its mapping
  // items). switches: the launch's switches (browserArgs, the profile's, the helper's) for the
  // rules that need a page result for a switch. Answers { ok } or { ok: false, refusal }.
  async function after(ctx, plan, { chosen = null, switches = [], session = "" } = {}) {
    const live = await readBackendOf(ctx);
    Object.assign(GRAPHICS, { kind: live.kind, renderer: live.renderer || null, status: "unverified" });
    if (!plan?.native) {
      Object.assign(GRAPHICS, { requested: "auto", switches: [], engineKeys: [] });
      st.graphics = { build: null };
      return { ok: true };
    }
    const { build, pack, where, display, geometry, request, name } = plan;
    const key = where ? runtimeKey({ build, pack, platform: where, arch, display, backend: live, switches: GRAPHICS.switches }) : null;
    // The read's checks (E2, E9): a GPU over software or an unread backend; a requirement unread.
    const errors = compatErrors({ name, graphics: request, platform, browserKind: "pairbrowse", measured: { ...(plan.measured || {}), backend: live } })
      .filter((e) => e.field === "graphics.backend" || e.field === "graphics.require");
    const all = [...new Set([...switches, ...GRAPHICS.switches].filter((a) => typeof a === "string"))];
    const entry = measuredEntry(chosen?.request || {}, { build, pack, measured: plan.measured, live, runtimeKey: key, platform, virtualScreen: geometry,
      switches: all, results: chosen?.results || [] });
    // Dropped only over a backend that was read (an unverified read differs from every key, and
    // proves nothing changed). A stored one that differs is measured again at the next start; a
    // probe of this run that wasn't kept (it differs, or the read failed) is not (remeasured),
    // until the helper restarts.
    const stale = !!plan.measured && !entry.graphics && live.kind !== "unverified";
    if (plan.source === "probe" && !entry.graphics) remeasured.add(plan.runtime);
    if (stale) {
      log(`launch: graphics: ${plan.source === "probe" ? "the measurement just made doesn't match this browser" : "this computer's graphics changed since they were measured"} (driver, display or switches); measured again ${plan.source === "probe" ? "when the helper next starts" : "at the next start"}`);
    }
    const filed = api.profiles?.fileValidation?.(entry, { build, replaceMeasured: stale }) ?? entry.status;
    GRAPHICS.status = entry.graphics ? entry.status : "unverified";
    for (const item of entry.items.filter((i) => (i.rule === "backend.requested" || i.rule === "backend.stable") && i.status === "mismatch")) {
      errors.push({ field: item.field, message: `Profile ${name}: ${String(item.reason).replace(/\.$/, "")}.` });
    }
    if (!errors.length && config.requireValidatedProfiles === true && filed !== "validated") {
      errors.push({ field: "requireValidatedProfiles", message: `Browser profile "${name}" is ${filed} on build ${build} for this computer's graphics, and requireValidatedProfiles is on in config.json.` });
    }
    if (errors.length) return { ok: false, refusal: refusal(session, errors, "The browser was closed before any tab loaded.").message };
    st.graphics = { build };
    log(`launch: graphics: ${live.kind}, ${GRAPHICS.status} on ${build}${plan.source === "probe" ? " (measured now)" : plan.source === "stored" ? "" : " (not measured)"}`);
    return { ok: true };
  }

  // The running browser closed: nothing to report until the next start's read.
  const release = () => { st.graphics = null; };

  // pairbrowse_status's part while a browser runs (graphicsStatusPart); remote: a joiner's agent
  // asks, so the renderer is left out.
  const statusParts = ({ remote = false } = {}) => (st.graphics ? [graphicsStatusPart(GRAPHICS, { build: st.graphics.build, renderer: !remote })] : []);
  // Diagnostics' part (row E-3): the kind and status only, never the renderer or IDs.
  const summary = () => (st.graphics ? { kind: GRAPHICS.kind, status: GRAPHICS.status } : null);

  return { before, after, release, statusParts, summary };
}

// One refusal naming every error (one sentence each), and what became of the start.
function refusal(session, errors, end = "Nothing was started.") {
  const who = session ? `Session "${String(session).slice(0, 64)}"` : "The browser";
  return new Error(`${who} doesn't start: ${errors.map((e) => e.message).join(" ")} ${end}`);
}
