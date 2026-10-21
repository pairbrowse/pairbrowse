// The browser profiles' command line (spec server-mode D14, step 38): the person's way to manage
// profiles besides the sessions page. Agents have none of this (they list profiles and pick one for
// a new session through pairbrowse_session, nothing else). Run as
//   node scripts/profiles/cli.mjs <command> ...
// Every write goes through the profile store (profiles/store.mjs: owner-only files, one lock, a
// change made on an older revision refused), so a running helper and this never write half a
// record. Nothing printed holds a credential (a profile has none) or a value read from an import
// that wasn't applied.
//
// Node's standard library only.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { paths, loadConfig } from "../paths.mjs";
import { assignProfile, assignedTo, profileInUse, isTemporary } from "../sessions.mjs";
import { createProfileStore } from "./store.mjs";
import { fromConfig, toLaunch, ENGINE_KEYS } from "./map.mjs";
import { launchableBrowserArgs, browserArgsOf } from "../browser-args.mjs";
import { importFile } from "./import.mjs";
import { exportToFile } from "./export.mjs";
import { validateProfile, installedBuild, cliCommand, measuredEntry } from "./validate.mjs";
import { migrateLocked, migrationReport, notCarried, undoMigration, dismissMigration, readMigration, helperRunning } from "./migrate.mjs";
import { DEFAULT_PROFILE } from "./schema.mjs";

export const USAGE = `Usage: node scripts/profiles/cli.mjs <command>
  list                                   every browser profile, and which sessions use it
  show <profile>                         one profile's settings, history and checks (JSON)
  create <name> [--settings <json>]      a new profile (settings left out take the defaults)
  edit <profile> [--settings <json>] [--name <new>] [--revision <n>]
                                         change its settings or name (--revision: the one you read)
  retire <profile> | restore <profile>   a retired profile is kept but never assigned or started
  assign <session> <profile>             the session starts on the profile from its next start
  import <file> [--dry-run] [--source <where from>] [--license <SPDX id|own-capture|unknown>] [--terms <text>] [--name <name>]
  export <profile> [<file>] [--with-history] [--include-identity] [--overwrite]
  validate [<profile>]                   check it (every active one) on the native build installed now,
                                         measuring its graphics in a browser of its own
  migrate [--report | --undo | --dismiss]
                                         move this home to browser profiles (the helper does it at its
                                         first start), show what it reads, undo it, or hide its notes
<profile> is a profile's name or id. --settings is JSON such as '{"locale":{"timezone":"Europe/Berlin"}}'.`;

// argv's options: { args: [plain words], flags: { name: value | true } }; unknown flags refused.
function parse(argv, known) {
  const args = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args.push(a); continue; }
    const name = a.slice(2);
    if (!(name in known)) return { error: `Unknown option ${a.slice(0, 40)}.` };
    if (known[name] === "flag") flags[name] = true;
    else {
      if (i + 1 >= argv.length) return { error: `${a} needs a value.` };
      flags[name] = argv[++i];
    }
  }
  return { args, flags };
}

const settingsOf = (text) => {
  if (text === undefined) return {};
  let v;
  try { v = JSON.parse(text); } catch { return { error: "--settings isn't JSON." }; }
  return v && typeof v === "object" && !Array.isArray(v) ? v : { error: "--settings is a JSON object { ... }." };
};

// Runs one command (argv: what follows the script's path). Prints to out and err; resolves the
// exit code (0 done, 1 refused or failed, 2 usage). Tests pass store, config, native (a native
// build is pinned here), build ({ build, pack, exec } or { problem }), running (a helper on this
// home) and measure (validate's graphics measurement, native/check.mjs measureGraphics's place:
// (exec, { config, engineLayer, profileArgs, log }) -> { measured, line, virtualScreen }).
export async function runProfilesCli(argv, { out = process.stdout, err = process.stderr, store, config, native, build, running = helperRunning, now = Date.now, platform = process.platform, measure } = {}) {
  const say = (s) => out.write(`${s}\n`);
  const fail = (s, code = 1) => { err.write(`${s}\n`); return code; };
  const [command, ...rest] = argv;
  config ??= loadConfig(paths.config);
  store ??= createProfileStore({ assignedTo });
  if (native === undefined) {
    const { pinnedAsset } = await import("../native/install.mjs");
    native = !!pinnedAsset();
  }
  const configSettings = () => fromConfig(config, { native, platform });
  // A profile by name or id; the config-backed default made from config.json when it never was.
  const use = (ref) => store.use(ref, String(ref).toLowerCase() === DEFAULT_PROFILE ? { configSettings: configSettings() } : {});
  const run = (fn) => { try { return fn(); } catch (e) { return fail(e?.message || String(e)); } };

  switch (command) {
    case "list": {
      if (rest.length) return fail(USAGE, 2);
      const rows = store.list();
      if (!rows.length) { say(`No browser profile is stored yet; sessions start on "${DEFAULT_PROFILE}" (from config.json).`); return 0; }
      for (const r of rows) {
        if (r.problem) { say(`${r.id}  can't be read: ${r.problem}`); continue; }
        const sessions = assignedTo(r.id);
        say(`${r.name}  ${r.id}  rev ${r.revision}  ${r.status}${r.kind === "config" ? "  (from config.json)" : ""}${r.engine ? `  engine ${r.engine.build}` : ""}${sessions.length ? `  sessions: ${sessions.join(", ")}` : ""}`);
      }
      return 0;
    }
    case "show": {
      if (rest.length !== 1) return fail(USAGE, 2);
      return run(() => { say(JSON.stringify(use(rest[0]), null, 2)); return 0; });
    }
    case "create": {
      const p = parse(rest, { settings: "value" });
      if (p.error || p.args.length !== 1) return fail(p.error || USAGE, 2);
      const settings = settingsOf(p.flags.settings);
      if (settings.error) return fail(settings.error, 2);
      return run(() => { const r = store.create({ ...settings, name: p.args[0] }); say(`Made browser profile "${r.name}" (${r.id}), revision 1.`); return 0; });
    }
    case "edit": {
      const p = parse(rest, { settings: "value", name: "value", revision: "value" });
      if (p.error || p.args.length !== 1) return fail(p.error || USAGE, 2);
      const settings = settingsOf(p.flags.settings);
      if (settings.error) return fail(settings.error, 2);
      if (p.flags.name !== undefined) settings.name = p.flags.name;
      if (!Object.keys(settings).length) return fail("Give --settings, --name or both.", 2);
      const expectRevision = p.flags.revision === undefined ? undefined : Number(p.flags.revision);
      if (expectRevision !== undefined && !Number.isInteger(expectRevision)) return fail("--revision is a whole number.", 2);
      return run(() => { const r = store.update(p.args[0], settings, { expectRevision }); say(`Browser profile "${r.name}" is at revision ${r.revision}.`); return 0; });
    }
    case "retire":
    case "restore": {
      if (rest.length !== 1) return fail(USAGE, 2);
      return run(() => { const r = store[command](rest[0]); say(`Browser profile "${r.name}" is ${r.status}.`); return 0; });
    }
    case "assign": {
      if (rest.length !== 2) return fail(USAGE, 2);
      const [session, ref] = rest;
      if (isTemporary(session)) return fail("A clean session starts on the default profile; keep a named session to give it a profile.");
      if (profileInUse(session)) return fail(`Session "${session}" is open in a browser now; close it first, then put it on another profile.`);
      return run(() => {
        const record = use(ref);
        const r = assignProfile(session, record.id, { store });
        say(`Session "${r.session}" starts on browser profile "${r.profile}" from its next start.`);
        return 0;
      });
    }
    case "import": {
      const p = parse(rest, { "dry-run": "flag", source: "value", license: "value", terms: "value", name: "value" });
      if (p.error || p.args.length !== 1) return fail(p.error || USAGE, 2);
      return run(() => {
        const r = importFile(store, p.args[0], { at: new Date(now()).toISOString(), source: p.flags.source, license: p.flags.license, terms: p.flags.terms ?? null, name: p.flags.name, dryRun: !!p.flags["dry-run"] });
        say(r.dryRun ? `Would import "${r.name}" (${r.format}, license ${r.license}); nothing was written.` : `Imported browser profile "${r.profile.name}" (${r.profile.id}) from ${r.format}, license ${r.license}.`);
        for (const i of r.items.filter((x) => x.status !== "applied")) say(`  ${i.field}: ${i.status}${i.reason ? ` (${i.reason})` : ""}`);
        if (r.unverified) say('  Its license is "unknown": every start on it warns until it is imported again with --license.');
        return 0;
      });
    }
    case "export": {
      const p = parse(rest, { "with-history": "flag", "include-identity": "flag", overwrite: "flag" });
      if (p.error || p.args.length < 1 || p.args.length > 2) return fail(p.error || USAGE, 2);
      return run(() => {
        let record = use(p.args[0]);
        if (record.kind === "config") record = store.use(record.id, { configSettings: configSettings() });
        const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
        const dest = p.args[1] ? resolve(p.args[1]) : join(paths.profileExports, `${record.name}-${stamp}.json`);
        const r = exportToFile(record, dest, { withHistory: !!p.flags["with-history"], includeIdentity: !!p.flags["include-identity"], overwrite: !!p.flags.overwrite });
        for (const w of r.warnings) err.write(`warning: ${w}\n`);
        say(`Exported browser profile "${record.name}" to ${r.file} (SHA-256 ${r.sha256}).`);
        return 0;
      });
    }
    case "validate": {
      if (rest.length > 1) return fail(USAGE, 2);
      build ??= await installedBuild(config);
      if (build.problem) return fail(build.problem);
      const refs = rest.length ? rest : store.list().filter((r) => !r.problem && r.status === "active").map((r) => r.id);
      if (!refs.length) refs.push(DEFAULT_PROFILE);
      measure ??= (await import("../native/check.mjs")).measureGraphics;
      let code = 0;
      for (const ref of refs) {
        let r;
        try {
          r = validateProfile(store, ref, { build: build.build, pack: build.pack, configSettings: configSettings(), platform, now });
          say(`${r.name}: applies on build ${r.build}${r.from && r.from.build !== r.build ? ` (was held to ${r.from.build})` : ""}; measuring its graphics.`);
        } catch (e) { code = 1; err.write(`${e?.message || e}\n`); continue; }
        // E4: the build measured for this profile in a probe browser of its own (its switches and
        // engine keys, this computer's screen), and the verdict kept as its evidence (E6, E8).
        try {
          const record = use(r.id);
          const userArgs = launchableBrowserArgs(browserArgsOf(config), platform);
          const mapped = toLaunch(record, { browserKind: "pairbrowse", platform, userArgs });
          // Never geoip: the probe has no proxy, so its region lookup would send this computer's
          // own address out (native/check.mjs probeEngine turns it off as well).
          const engineLayer = { id: record.id, kind: record.kind, geoip: false, graphics: record.graphics.backend, engineKeys: Object.fromEntries(Object.entries(mapped.engineKeys).filter(([k]) => ENGINE_KEYS.includes(k))) };
          const got = await measure(build.exec, { config, engineLayer, profileArgs: mapped.switches, log: () => {} });
          if (!got?.measured) { code = 1; err.write(`${r.name}: ${got?.line || "graphics: not measured"}; it stays unverified.\n`); continue; }
          const entry = measuredEntry(record, { build: build.build, pack: build.pack, measured: got.measured, runtimeKey: got.measured.runtimeKey, platform,
            virtualScreen: got.virtualScreen, switches: [...userArgs, ...mapped.switches], results: mapped.results, now });
          if (entry.graphics) store.recordValidation(record.id, { build: build.build, entry });
          const errors = entry.items.filter((i) => i.severity === "error" && i.status !== "matched" && i.status !== "applied" && i.status !== "derived");
          say(`${r.name}: ${entry.status} on build ${build.build} (${got.line})${errors.length ? `: ${errors.slice(0, 6).map((i) => `${i.field} (${i.status}${i.reason ? `: ${i.reason}` : ""})`).join("; ")}${errors.length > 6 ? `; ${errors.length - 6} more (show ${r.name})` : ""}` : ""}.`);
        } catch (e) { code = 1; err.write(`${r.name}: graphics not measured (${e?.message || e}); it stays unverified.\n`); }
      }
      return code;
    }
    case "migrate": {
      const p = parse(rest, { report: "flag", undo: "flag", dismiss: "flag" });
      if (p.error || p.args.length || Object.keys(p.flags).length > 1) return fail(p.error || USAGE, 2);
      if (p.flags.report) {
        const report = migrationReport({ config, native, platform });
        const done = readMigration();
        say(done ? `This home was moved to browser profiles on ${done.at}.` : "This home isn't moved to browser profiles yet (the helper does it at its first start).");
        say(`The default profile reads from config.json: ${report.default.items.filter((i) => i.status === "applied").map((i) => i.field).join(", ") || "nothing set (this computer's own values)"}.`);
        const left = notCarried(report);
        if (left.length) say(`Kept out of it: ${left.join(", ")}.`);
        for (const i of report.default.items.filter((x) => x.status !== "applied")) say(`  ${i.field}: ${i.status}${i.reason ? ` (${i.reason})` : ""}`);
        for (const o of report.offered) say(`  ${o.field}: ${o.what} is offered for import${o.file ? ` (${cliCommand(`import ${o.file} --source ... --license ...`)})` : ""}${o.dryRun ? (o.dryRun.ok ? "; it imports" : `; ${o.dryRun.problem}`) : ""}`);
        say(`Sessions: ${report.sessions.map((s) => `${s.name}${s.assigned ? " (assigned)" : ""}`).join(", ") || "none"}.`);
        return 0;
      }
      if (p.flags.dismiss) {
        if (!dismissMigration()) return fail("This home has no browser profile migration to dismiss.");
        say("The migration's notes no longer show in the status line.");
        return 0;
      }
      if (p.flags.undo) {
        return run(() => {
          const r = undoMigration({ store, running, now });
          for (const e of r.exported) say(`Exported "${e.name}" to ${e.file}.`);
          if (r.notRestored.length) {
            return fail(`Put back ${r.sessions.length} session${r.sessions.length === 1 ? "" : "s"}; ${r.notRestored.map((x) => `"${x.name}" (${x.problem})`).join(", ")} couldn't be put back, so the browser profile folders stay: fix or remove that session's files, then run migrate --undo again.`);
          }
          say(`Put back ${r.sessions.length} session${r.sessions.length === 1 ? "" : "s"}; removed ${r.removed.join(" and ") || "nothing"}. Sessions start as before profiles; the helper moves them again at its next start unless this PairBrowse is replaced by an older one.`);
          return 0;
        });
      }
      return run(() => {
        // Under the migration's lock: a helper's first launch at the same time migrates it once.
        const r = migrateLocked({ config, native, platform, store, now });
        if (!r.ran) { say(`This home was moved to browser profiles on ${r.record.at} already.`); return 0; }
        say(`Moved ${r.record.sessions.length} session${r.record.sessions.length === 1 ? "" : "s"} to browser profile "${DEFAULT_PROFILE}"${r.record.engine.copiedFrom ? `; copied ${r.record.engine.copiedFrom} into ${r.record.engine.dir}` : ""}.`);
        if (r.record.notCarried.length) say(`Kept out of it: ${r.record.notCarried.join(", ")} (migrate --report says why).`);
        return 0;
      });
    }
    default:
      return fail(USAGE, 2);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProfilesCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.message || e}\n`); process.exitCode = 1; });
}
