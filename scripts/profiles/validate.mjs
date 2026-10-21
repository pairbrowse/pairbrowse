// The person's check of a browser profile on the native build installed now (spec server-mode D10,
// step 38: `cli.mjs validate`, the sessions page's Check). A profile is held to the engine major it
// was made on: a launch on another major refuses it (daemon/sessions/profiles.mjs), and this is
// what clears that pin. It reads the profile (unknown or retired refused by name), maps it for this
// build (profiles/map.mjs toLaunch: a setting the build can't apply refuses, naming it, nothing
// changed), then holds it to this build's engine and keeps the mapping's items as this build's
// evidence (store.repin: no new revision, a history entry naming "engine"). Its status stays
// "unverified" there: "validated" needs measured evidence (spec E6). cli.mjs validate then
// measures the build in a probe browser of its own (native/check.mjs measureGraphics, E4) and
// files the verdict (measuredEntry, store.recordValidation); the sessions page's Check doesn't
// measure (the helper's next start of the profile does, once per runtime key).
//
// Node's standard library only.
import { fileURLToPath } from "node:url";
import { toLaunch } from "./map.mjs";
import { validate } from "../native/validate.mjs";

const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

// The profiles' command line by its full path, as a refusal or the status line names it: the
// person runs it from any folder, not only the plugin's (a path with a space or quote is quoted).
export const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
export const cliCommand = (args) => `node ${/^[\w./:\\-]+$/.test(CLI) ? CLI : JSON.stringify(CLI)} ${args}`;

// store: profiles/store.mjs createProfileStore's. build: the native build's version (its manifest's,
// "150.0.7871.114"); pack: the engine pack's SHA-256; configSettings: fromConfig(config) for the
// default. Returns { id, name, kind, build, from (the engine it was held to before, or null),
// status: "unverified", items }. Throws a sentence (err.code PROFILE_*) on a refusal.
export function validateProfile(store, ref, { build, pack = null, configSettings, platform = process.platform, now = Date.now } = {}) {
  if (typeof build !== "string" || !BUILD.test(build)) throw fail("PROFILE_VALIDATE", "No native PairBrowse build is installed for this home's browser, so there is nothing to check the profile on: profiles are checked on the native build (the open build's starts are never validated).");
  const record = store.use(ref, { configSettings });
  const mapped = toLaunch(record, { browserKind: "pairbrowse", platform });
  if (mapped.problem) throw fail("PROFILE_VALIDATE", `Browser profile "${record.name}" wasn't checked on build ${build}: ${mapped.problem}`);
  const engine = { major: build.split(".")[0], build };
  const entry = { status: "unverified", at: new Date(now()).toISOString(), pack: typeof pack === "string" && SHA256.test(pack) ? pack : null, items: mapped.results.slice(0, 500) };
  store.repin(record.id, { engine, build, entry });
  return { id: record.id, name: record.name, kind: record.kind, build, from: record.engine || null, status: "unverified", items: entry.items };
}

// The native build this home's browser runs, as the launch would pick it (browser/choice.mjs
// chooseBrowser): { build, pack, exec } or { problem }. Loaded only when asked (it reads the install).
export async function installedBuild(config = {}) {
  const [{ chooseBrowser }, { pinnedAsset, nativeDirs }, { nativeManifest }, { NATIVE }, { existsSync }] = await Promise.all([
    import("../browser/choice.mjs"), import("../native/install.mjs"), import("../native-engine.mjs"), import("../native-pack.mjs"), import("node:fs"),
  ]);
  const spec = chooseBrowser(config, { native: !!pinnedAsset(), pinnedExec: () => nativeDirs().exec });
  if (spec.binary !== "native") return { problem: "This home's browser is the open build (or a browser of your own): profiles are checked on the native PairBrowse build only." };
  const exec = spec.executablePath || nativeDirs().exec;
  if (!exec || !existsSync(exec)) return { problem: "The native PairBrowse build isn't installed yet: start the browser once, then check the profile." };
  try { return { build: nativeManifest(exec).version, pack: NATIVE.engine?.sha256 || null, exec }; } catch (e) { return { problem: e?.message || String(e) }; }
}

// What a profile asked for, as native/validate.mjs validate reads it: its graphics request, screen,
// window and the time zone and languages it sets (null: this computer's or the exit's, not
// checked).
export const requestOf = (record) => ({ graphics: record.graphics, screen: record.screen, window: record.window,
  locale: { timezone: record.locale?.timezone ?? null, languages: record.locale?.languages ?? null } });

// A measurement's verdict for a profile (spec E6, E8): validate() over the profile's request, the
// launch's switches and mapping items (results), what the build derives (build, pack, the
// runtime's key, platform as process.platform names it, the virtual screen on Xvfb) and the
// measurement, with live: a running browser's own backend read (E3), null for a probe alone. The
// answer is the validation[build] entry: with the measurement only when it is of this pack and
// runtime key (store.recordValidation), else a launch's unverified entry (store.recordLaunch).
export function measuredEntry(record, { build, pack = null, measured = null, live = null, runtimeKey = null, platform = process.platform, virtualScreen = null, switches = [], results = [], now = Date.now } = {}) {
  const screen = virtualScreen && Number.isFinite(virtualScreen.width) && Number.isFinite(virtualScreen.height) ? { width: virtualScreen.width, height: virtualScreen.height } : null;
  return validate({ requested: { ...requestOf(record), switches, results }, derived: { build, pack, runtimeKey, platform, virtualScreen: screen }, measured, live, at: new Date(now()).toISOString() });
}
