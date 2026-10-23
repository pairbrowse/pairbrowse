// The server setup's fonts (server-mode spec step 52): the Windows fonts as present, standing in or
// absent (native/winfonts.mjs), the browser's font configuration and its switch
// (native/fontconf.mjs, pairbrowse.fontStandIns), and the setup command (native/fontsetup.mjs):
// the distribution's packages, Microsoft's EULA shown and accepted by the person (never for them),
// Selawik from Microsoft's release with every file pinned, and the check's lines.
import "./helpers/home.mjs";
import { testHome } from "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { NAME_ALIASES, REPORT_FONTS, STAND_INS, SWITCHED_STAND_INS, WINDOWS_FONTS, fontGroups, fontGroupsLine, fontStatus, parseFontList, readFontFamiliesAsync } from "../scripts/native/winfonts.mjs";
import { BUILD_FONTS_DIR, SYSTEM_CONF, browserFontEnv, buildFontsDir, fontSource, fontStandInsOf, fontsConf, fontsReport, writeFontsConf } from "../scripts/native/fontconf.mjs";
import { EULA_CONFIG_KEY, EULA_FLAG, UBUNTU_EULA_PRESEED, eulaPreset, CORE_PACKAGE, EULA_FILE, FREE_FAMILIES, PACKAGES, SELAWIK, USAGE, distroOf, eulaAnswer, freeFamiliesLacking, freePackages, installSelawik, installStandIn, installStandIns, parseCandidate, parseDpkgStatus, parseOsRelease, runFontSetup, selawikInstalled, standInInstalled, standInsMissing, zipEntries, zipRead } from "../scripts/native/fontsetup.mjs";
import { GOOGLE_FONTS_COMMIT, STAND_IN_DIRS, STAND_IN_FONTS, urlName } from "../scripts/native/standins.mjs";
import { configProblem } from "../scripts/config-schema.mjs";

const root = new URL("../", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const scratch = (name) => mkdtempSync(join(testHome, `${name}-`));

test("each Windows family is present, standing in (by which open font) or absent", () => {
  assert.deepEqual(REPORT_FONTS.slice(0, 8), [...WINDOWS_FONTS]);
  for (const f of ["Cambria", "Arial", "Times New Roman", "Verdana", "Georgia", "Trebuchet MS", "Comic Sans MS", "Impact", "Andale Mono", "Webdings", "Tahoma"]) assert.ok(REPORT_FONTS.includes(f), f);
  assert.deepEqual(STAND_INS.map((s) => [s.family, s.standIn]), [["Segoe UI", "Selawik"], ["Segoe UI Light", "Selawik Light"], ["Segoe UI Semilight", "Selawik Semilight"], ["Segoe UI Semibold", "Selawik Semibold"],
    ["Calibri", "Carlito"], ["Cambria", "Caladea"], ["Arial", "Arimo"], ["Times New Roman", "Tinos"], ["Courier New", "Cousine"], ["Georgia", "Gelasio"],
    ["Verdana", "DejaVu Sans"], ["Tahoma", "DejaVu Sans Condensed"], ["Trebuchet MS", "Fira Sans"], ["Comic Sans MS", "Comic Relief"], ["Impact", "Anton"], ["Consolas", "Inconsolata"]]);
  assert.deepEqual([...SWITCHED_STAND_INS], ["Selawik", "Selawik Light", "Selawik Semilight", "Selawik Semibold", "Carlito", "Caladea", "Arimo", "Tinos", "Cousine", "Gelasio", "Fira Sans", "Comic Relief", "Anton", "Inconsolata"],
    "DejaVu Sans is the system's own text face and Liberation the system's own alias: never switched");
  const entries = parseFontList("Arial:style=Regular\nCarlito:style=Regular\nCaladea:style=Bold\nSelawik:style=Regular\nLiberation Serif:style=Regular\n");
  const off = fontStatus(entries, { families: ["Arial", "Calibri", "Segoe UI", "Times New Roman", "Marlett"] });
  assert.deepEqual(off, [{ family: "Arial", status: "present" }, { family: "Calibri", status: "absent" }, { family: "Segoe UI", status: "absent" }, { family: "Times New Roman", status: "standing-in", by: "Liberation Serif" }, { family: "Marlett", status: "absent" }]);
  const on = fontGroups(fontStatus(entries, { standIns: true }));
  assert.deepEqual(on.present, ["Arial"]);
  assert.deepEqual(on.standingIn, [{ family: "Segoe UI", by: "Selawik" }, { family: "Calibri", by: "Carlito" }, { family: "Cambria", by: "Caladea" }, { family: "Times New Roman", by: "Liberation Serif" }]);
  assert.ok(on.absent.includes("Consolas") && on.absent.includes("Courier New") && !on.absent.includes("Arial"));
  assert.equal(fontGroupsLine({ present: ["Arial"], standingIn: [{ family: "Calibri", by: "Carlito" }], absent: ["Marlett"] }), "Windows fonts: present Arial; standing in Calibri (Carlito); absent Marlett");
  assert.equal(fontGroupsLine(null), "Windows fonts: not checked");
});

test("fc-list asked without blocking: its list, or null when it fails", async () => {
  const seen = [];
  const run = (cmd, args, opts, cb) => { seen.push([cmd, args, opts.timeout, opts.env?.FONTCONFIG_FILE]); cb(null, "Calibri:style=Regular\n"); };
  assert.deepEqual(await readFontFamiliesAsync({ run, env: { FONTCONFIG_FILE: "/c" } }), [{ families: ["calibri"], styles: ["regular"] }]);
  assert.deepEqual(seen, [["fc-list", [":", "family", "style"], 10_000, "/c"]]);
  assert.equal(await readFontFamiliesAsync({ run: (c, a, o, cb) => cb(new Error("ENOENT")) }), null);
  assert.equal(await readFontFamiliesAsync({ run: () => { throw new Error("boom"); } }), null);
});

test("the alias file: off keeps the switched stand-ins from the browser; on points the Windows names at them", () => {
  const off = fontsConf({ on: false, dirs: ["/fonts/selawik"] });
  assert.match(off, /^<\?xml version="1\.0"\?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts\.dtd">/);
  assert.ok(off.includes(`<include ignore_missing="yes">${SYSTEM_CONF}</include>`), "the computer's own fonts and aliases");
  for (const name of SWITCHED_STAND_INS) assert.ok(off.includes(`<pattern><patelt name="family"><string>${name}</string></patelt></pattern>`), `${name} rejected`);
  assert.doesNotMatch(off, /<alias|<dir>|Liberation/, "no alias, no Selawik folder, Liberation untouched");
  assert.match(off, /Stand-ins: off/);
  const on = fontsConf({ on: true, dirs: ["/fonts/selawik", "/a&b"] });
  // Names for a Windows family's faces answer with that family first (Microsoft's font where it is
  // installed), then its stand-in: Helvetica always measures as Arial does.
  assert.deepEqual(NAME_ALIASES.map((a) => [a.name, a.of]), [["Helvetica", "Arial"], ["Times", "Times New Roman"], ["Courier", "Courier New"]]);
  assert.ok(on.includes(`<alias binding="same"><family>Helvetica</family><accept><family>Arial</family><family>Arimo</family></accept></alias>`));
  assert.ok(on.includes(`<alias binding="same"><family>Times</family><accept><family>Times New Roman</family><family>Tinos</family></accept></alias>`));
  assert.ok(on.includes(`<alias binding="same"><family>Courier</family><accept><family>Courier New</family><family>Cousine</family></accept></alias>`));
  assert.doesNotMatch(on, /<prefer>|<default>/, "accept only: a real font of the Windows name always comes first");
  assert.ok(on.includes("<dir>/fonts/selawik</dir>") && on.includes("<dir>/a&amp;b</dir>"), "folders, escaped");
  for (const s of STAND_INS) assert.ok(on.includes(`<alias binding="same"><family>${s.family}</family><accept><family>${s.standIn}</family></accept></alias>`), s.family);
  assert.doesNotMatch(on, /rejectfont/);
  // Renamed or modified fonts never: only fontconfig's matching names them.
  assert.doesNotMatch(on + off, /<edit name="family"|<match/);
});

test("the browser's font configuration: only on Linux once the setup ran, written for the switch, atomic and owner-only", () => {
  const dir = scratch("fontconf");
  const record = join(dir, "fonts", "setup.json"), file = join(dir, "fonts.conf"), fontsDir = join(dir, "fonts");
  assert.equal(fontStandInsOf({}), true, "on by default");
  assert.equal(fontStandInsOf({ pairbrowse: { fontStandIns: "no" } }), true, "a value that isn't false keeps the default");
  assert.equal(fontStandInsOf({ pairbrowse: { fontStandIns: false } }), false);
  assert.equal(browserFontEnv({}, { platform: "linux", record, file, fontsDir }), null, "before the setup: the build's own");
  mkdirSync(fontsDir, { recursive: true });
  writeFileSync(record, "{}");
  assert.equal(browserFontEnv({}, { platform: "darwin", record, file, fontsDir }), null, "never off Linux");
  assert.deepEqual(browserFontEnv({}, { platform: "linux", record, file, fontsDir }), { FONTCONFIG_FILE: file });
  assert.match(readFileSync(file, "utf8"), /Stand-ins: on/, "on by default");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  browserFontEnv({ pairbrowse: { fontStandIns: false } }, { platform: "linux", record, file, fontsDir });
  assert.match(readFileSync(file, "utf8"), /Stand-ins: off/);
  browserFontEnv({ pairbrowse: { fontStandIns: true } }, { platform: "linux", record, file, fontsDir });
  const text = readFileSync(file, "utf8");
  assert.match(text, /Stand-ins: on/);
  assert.ok(text.includes(`<dir>${join(fontsDir, "selawik")}</dir>`));
  for (const d of STAND_IN_DIRS) assert.ok(text.includes(`<dir>${join(fontsDir, d)}</dir>`), `the ${d} folder listed`);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no half-written file left");
  const before = statSync(file).mtimeMs;
  writeFontsConf({ on: true, file, fontsDir });
  assert.equal(statSync(file).mtimeMs, before, "unchanged text is not written again");
  // The build's own font folder (beside the executable the launch names) stays reachable with the
  // stand-ins on: the engine's metric substitutes point Windows names at its faces (Cambria Math,
  // Bahnschrift, Gadugi, Lucida Console), so a local() load finds one; off, the folder stays out.
  assert.equal(BUILD_FONTS_DIR, "fonts");
  assert.equal(buildFontsDir("/opt/pb/chrome"), "/opt/pb/fonts");
  assert.equal(buildFontsDir(null), null);
  assert.equal(buildFontsDir(""), null);
  assert.deepEqual(browserFontEnv({}, { platform: "linux", record, file, fontsDir, executablePath: "/opt/pb/chrome" }), { FONTCONFIG_FILE: file });
  const withBuild = readFileSync(file, "utf8");
  assert.ok(withBuild.includes(`<dir>${join(fontsDir, "selawik")}</dir>\n${STAND_IN_DIRS.map((d) => `  <dir>${join(fontsDir, d)}</dir>\n`).join("")}  <dir>/opt/pb/fonts</dir>`), `the setup's folders, then the build's:\n${withBuild}`);
  browserFontEnv({ pairbrowse: { fontStandIns: false } }, { platform: "linux", record, file, fontsDir, executablePath: "/opt/pb/chrome" });
  assert.doesNotMatch(readFileSync(file, "utf8"), /<dir>/, "off: no folder, the build's included");
  writeFontsConf({ on: true, file, fontsDir, executablePath: "/opt/pb/chrome" });
  assert.equal(readFileSync(file, "utf8"), withBuild);
  writeFontsConf({ on: true, file, fontsDir });
  assert.doesNotMatch(readFileSync(file, "utf8"), /\/opt\/pb\/fonts/, "no executable named: the setup's folder alone");
  // A file that can't be written leaves the build's own, said in the log.
  const lines = [];
  assert.equal(browserFontEnv({}, { platform: "linux", record, file: join(record, "x.conf"), fontsDir, log: (l) => lines.push(l) }), null);
  assert.match(lines[0], /^fonts: the browser's font configuration couldn't be written/);
});

test("where the browser reads its fonts from: PairBrowse's file, the build's own, or the system's", async () => {
  const has = (...files) => (p) => files.includes(p);
  const opts = { platform: "linux", record: "/h/fonts/setup.json", file: "/h/fonts.conf" };
  assert.equal(fontSource({}, { ...opts, platform: "darwin" }), null);
  const ours = fontSource({ pairbrowse: { fontStandIns: true } }, { ...opts, exists: has("/h/fonts/setup.json", "/h/fonts.conf") });
  assert.deepEqual([ours.conf, ours.env.FONTCONFIG_FILE, ours.standIns], ["pairbrowse", "/h/fonts.conf", true]);
  const build = fontSource({}, { ...opts, exec: "/b/PairBrowse/chrome", exists: has("/b/PairBrowse/fonts/fonts.generated.conf") });
  assert.deepEqual([build.conf, build.env.FONTCONFIG_FILE, build.standIns], ["build", "/b/PairBrowse/fonts/fonts.generated.conf", true], "the build's clones always stand in");
  const sys = fontSource({}, { ...opts, exec: "/b/PairBrowse/chrome", exists: has() });
  assert.deepEqual([sys.conf, sys.standIns], ["system", false]);
  // The open build is never given PairBrowse's file: the system's configuration, whose metric
  // aliases stand Carlito and Caladea in for Calibri and Cambria, even after the setup ran.
  const open = fontSource({}, { ...opts, native: false, exists: has("/h/fonts/setup.json", "/h/fonts.conf") });
  assert.deepEqual([open.conf, open.env, open.standIns], ["system", process.env, true]);
  const openReport = await fontsReport({ config: {}, ...opts, native: false, exists: has("/h/fonts/setup.json", "/h/fonts.conf"), read: async ({ env }) => (env === process.env ? parseFontList("Carlito:style=Regular\nCaladea:style=Regular\n") : null) });
  assert.equal(openReport.conf, "system");
  assert.deepEqual(openReport.standingIn, [{ family: "Calibri", by: "Carlito" }, { family: "Cambria", by: "Caladea" }]);
  const report = await fontsReport({ config: {}, ...opts, exists: has(), read: async ({ env }) => (env === process.env ? parseFontList("Arial:style=Regular\nLiberation Mono:style=Regular\n") : null) });
  assert.equal(report.conf, "system");
  assert.deepEqual(report.present, ["Arial"]);
  assert.deepEqual(report.standingIn, [{ family: "Courier New", by: "Liberation Mono" }]);
  assert.equal(await fontsReport({ config: {}, ...opts, platform: "darwin" }), null);
  assert.equal(await fontsReport({ config: {}, ...opts, exists: has(), read: async () => null }), null);
});

test("pairbrowse.fontStandIns is true or false, and a helper-wide setting a profile doesn't hold", async () => {
  assert.equal(configProblem({ pairbrowse: { fontStandIns: true } }), "");
  assert.match(configProblem({ pairbrowse: { fontStandIns: "on" } }), /pairbrowse\.fontStandIns is true or false/);
  const { readConfig } = await import("../scripts/profiles/map.mjs");
  const item = readConfig({ browser: "pairbrowse", pairbrowse: { fontStandIns: true } }).items.find((i) => i.field === "pairbrowse.fontStandIns");
  assert.match(item?.reason || "", /helper-wide/);
  // The launch reads it (native-engine.mjs readSettings never names it as unknown), and the
  // browser's environment carries the file the pack's own merge lets win (launchEnv).
  const src = readFileSync(join(root, "scripts", "native-engine.mjs"), "utf8");
  assert.match(src, /formMove, inputPace, fontStandIns, \.\.\.given \} = config\.pairbrowse/);
  // (launchEnv's merge itself: test/native-engine.test.mjs.)
  assert.match(src, /const env = launchEnv\(config, \{ given: merged\.env, pack, executablePath: options\.executablePath, args: finalArgs, log \}\);/);
});

test("the distribution: Ubuntu and its derivatives, Debian, Fedora, Arch; packages by family", () => {
  const ubuntu = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
  assert.deepEqual(ubuntu, { id: "ubuntu", like: ["debian"], name: "Ubuntu 24.04 LTS" });
  assert.equal(distroOf(ubuntu), "ubuntu");
  assert.equal(distroOf(parseOsRelease("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n")), "ubuntu");
  assert.equal(distroOf(parseOsRelease("ID=debian\n")), "debian");
  assert.equal(distroOf(parseOsRelease("ID=fedora\n")), "fedora");
  assert.equal(distroOf(parseOsRelease("ID=rocky\nID_LIKE=\"rhel centos fedora\"\n")), "fedora");
  assert.equal(distroOf(parseOsRelease("ID=arch\n")), "arch");
  assert.equal(distroOf(parseOsRelease("ID=alpine\n")), null);
  assert.equal(PACKAGES.debian.core, CORE_PACKAGE);
  assert.equal(PACKAGES.debian.component, "contrib");
  assert.equal(PACKAGES.ubuntu.component, "multiverse");
  assert.deepEqual(freePackages(PACKAGES.debian), ["fontconfig", "fonts-noto-color-emoji", "fonts-noto-cjk"], "the stand-ins come pinned from their publishers, not the packages");
  assert.equal(PACKAGES.fedora.core, null, "no core fonts outside the distribution's own repositories");
  assert.equal(PACKAGES.arch.core, null);
  assert.deepEqual(parseDpkgStatus("fonts-noto-cjk ii \nfonts-liberation un \nfontconfig:amd64 ii \n"), new Set(["fonts-noto-cjk", "fontconfig"]));
  assert.equal(parseCandidate("ttf-mscorefonts-installer:\n  Installed: (none)\n  Candidate: 3.8.1\n"), "3.8.1");
  assert.equal(parseCandidate("ttf-mscorefonts-installer:\n  Installed: (none)\n  Candidate: (none)\n"), null);
  assert.equal(parseCandidate(""), null);
});

// A zip built here: one stored entry and deflated ones.
function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data, method] of files) {
    const body = method === 8 ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(method, 10); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("Selawik: Microsoft's release pinned, each font checked against its own pin, nothing renamed, nothing else written", async () => {
  assert.match(SELAWIK.url, /^https:\/\/github\.com\/microsoft\/Selawik\/releases\/download\/1\.01\/Selawik_Release\.zip$/);
  assert.match(SELAWIK.license.url, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/Selawik\/[0-9a-f]{40}\/LICENSE\.txt$/);
  for (const h of [SELAWIK.sha256, SELAWIK.license.sha256, ...Object.values(SELAWIK.fonts)]) assert.match(h, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(SELAWIK.fonts), ["selawk.ttf", "selawkb.ttf", "selawkl.ttf", "selawksb.ttf", "selawksl.ttf"]);
  const a = Buffer.from("font a ".repeat(50)), b = Buffer.from("font b");
  const archive = zip([["a.ttf", a, 8], ["b.ttf", b, 0], ["a.eot", Buffer.from("eot"), 8]]);
  const entries = zipEntries(archive);
  assert.deepEqual([...entries.keys()], ["a.ttf", "b.ttf", "a.eot"]);
  assert.deepEqual(zipRead(archive, entries.get("a.ttf")), a);
  assert.deepEqual(zipRead(archive, entries.get("b.ttf")), b);
  assert.throws(() => zipEntries(Buffer.from("not a zip at all, not a zip at all")), /not a zip archive/);
  const license = Buffer.from("SIL Open Font License 1.1");
  const pin = { file: "s.zip", url: "https://example.test/s.zip", sha256: sha(archive), fonts: { "a.ttf": sha(a), "b.ttf": sha(b) }, license: { url: "https://example.test/LICENSE.txt", file: "LICENSE.txt", sha256: sha(license) } };
  const asked = [];
  const download = async (url, dest, want) => {
    asked.push([url, want]);
    const data = url.endsWith(".zip") ? archive : license;
    if (sha(data) !== want) throw new Error("doesn't match its pinned SHA-256");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, data);
    return dest;
  };
  const home = scratch("selawik");
  const dir = join(home, "fonts", "selawik");
  assert.deepEqual(await installSelawik({ dir, downloads: join(home, "downloads"), pin, download }), { installed: true });
  assert.deepEqual(readdirSync(dir).sort(), ["LICENSE.txt", "a.ttf", "b.ttf"], "the pinned fonts under their own names, and the licence");
  assert.deepEqual(readFileSync(join(dir, "a.ttf")), a);
  assert.deepEqual(asked, [[pin.url, pin.sha256], [pin.license.url, pin.license.sha256]]);
  assert.ok(selawikInstalled(dir, pin));
  assert.deepEqual(await installSelawik({ dir, downloads: join(home, "downloads"), pin, download }), { installed: false }, "in place: nothing fetched again");
  assert.equal(asked.length, 2);
  // A font that doesn't match its own pin, or one the archive lacks: refused, nothing written.
  const other = join(home, "other");
  await assert.rejects(installSelawik({ dir: other, downloads: join(home, "downloads"), pin: { ...pin, fonts: { "a.ttf": sha(b) } }, download }), /a\.ttf doesn't match its pinned SHA-256/);
  await assert.rejects(installSelawik({ dir: other, downloads: join(home, "downloads"), pin: { ...pin, fonts: { "c.ttf": sha(b) } }, download }), /has no c\.ttf/);
  assert.equal(existsSync(other), false);
});

test("Microsoft's EULA: shown in full and accepted only by a typed yes; recorded once; never answered for the person", async () => {
  const text = readFileSync(EULA_FILE, "utf8");
  assert.match(text, /^END-USER LICENSE AGREEMENT FOR\nMICROSOFT SOFTWARE/);
  assert.match(text, /You may not rename, edit or create\n\s+any derivative works from the SOFTWARE PRODUCT/);
  const run = async (answer, opts = {}) => {
    const printed = [], questions = [];
    const r = await eulaAnswer({ distro: "debian", ask: async (q) => { questions.push(q); return answer; }, print: (l) => printed.push(l), ...opts });
    return { r, printed: printed.join("\n"), questions };
  };
  const yes = await run(" YES ");
  assert.deepEqual(yes.r, { accepted: true, how: "typed", sha256: sha(text) });
  assert.ok(yes.printed.includes(text.trimEnd()), "the whole licence is shown before the question");
  assert.match(yes.questions[0], /Type "yes" to accept Microsoft's licence/);
  assert.deepEqual((await run("y")).r, { accepted: false, how: "declined" }, "only yes itself");
  assert.deepEqual((await run("")).r, { accepted: false, how: "declined" });
  assert.deepEqual((await run(null)).r, { accepted: false, how: "no answer" }, "no terminal: never taken as yes");
  const again = await run(null, { record: { coreFonts: { eula: { sha256: sha(text) } } } });
  assert.deepEqual(again.r, { accepted: true, how: "recorded" });
  assert.deepEqual(again.questions, [], "accepted once: not asked again");
  assert.equal((await run(null, { record: { coreFonts: { eula: { sha256: "0".repeat(64) } } } })).r.accepted, false, "another text is asked again");
  // Ubuntu's package shows it and asks itself: PairBrowse asks only whether to go ahead.
  const ubuntu = await run("yes", { distro: "ubuntu" });
  assert.deepEqual(ubuntu.r, { accepted: true, how: "package" });
  assert.ok(!ubuntu.printed.includes("GRANT OF LICENSE"));
  // The owner's acceptance set beforehand (an unattended server): accepted without a question, the
  // text not shown but named, where it came from recorded; a recorded acceptance still comes first.
  const preset = await run(null, { preset: "server.acceptMsCoreFontsEula in config.json" });
  assert.deepEqual(preset.r, { accepted: true, how: "preset", source: "server.acceptMsCoreFontsEula in config.json", sha256: sha(text) });
  assert.deepEqual(preset.questions, []);
  assert.ok(!preset.printed.includes("GRANT OF LICENSE") && preset.printed.includes(EULA_FILE) && preset.printed.includes("accepted by the owner beforehand (server.acceptMsCoreFontsEula in config.json)"));
  assert.deepEqual((await run(null, { preset: "the --accept-ms-corefonts-eula flag", record: { coreFonts: { eula: { sha256: sha(text) } } } })).r, { accepted: true, how: "recorded" });
  assert.deepEqual((await run("yes", { distro: "ubuntu", preset: "the --accept-ms-corefonts-eula flag" })).r, { accepted: true, how: "preset", source: "the --accept-ms-corefonts-eula flag", sha256: sha(text) });
  // Where the owner's acceptance comes from: the flag, else config.json's server block, else nowhere.
  assert.equal(eulaPreset({}, []), null);
  assert.equal(eulaPreset({ server: { acceptMsCoreFontsEula: true } }, []), `${EULA_CONFIG_KEY} in config.json`);
  assert.equal(eulaPreset({ server: { acceptMsCoreFontsEula: "yes" } }, []), null, "true itself, never a truthy value");
  assert.equal(eulaPreset({ server: { acceptMsCoreFontsEula: true } }, [EULA_FLAG]), `the ${EULA_FLAG} flag`);
  assert.equal(EULA_CONFIG_KEY, "server.acceptMsCoreFontsEula");
  assert.equal(EULA_FLAG, "--accept-ms-corefonts-eula");
  assert.equal(UBUNTU_EULA_PRESEED, `${CORE_PACKAGE} msttcorefonts/accepted-mscorefonts-eula select true\n`);
  // Nothing in the setup answers the package's question or accepts for the person: no -y, no
  // noninteractive front end, and debconf is given an answer only from the owner's preset
  // (the one place the preseed text exists is its constant, used only after how === "preset").
  const src = readFileSync(join(root, "scripts", "native", "fontsetup.mjs"), "utf8");
  assert.doesNotMatch(src, /apt-get[^"\n]*-y\b|"-y"|DEBIAN_FRONTEND=/);
  assert.match(src, /delete env\.DEBIAN_FRONTEND/);
  assert.equal(src.split("accepted-mscorefonts-eula").length - 1, 1, "the preseed text once, in its constant");
  assert.match(src, /if \(answer\.how === "preset" && s\.distro === "ubuntu"\) \{\s*preseeded = deps\.preseed\(UBUNTU_EULA_PRESEED\) === 0;/);
  assert.equal(src.split("deps.preseed(").length - 1, 1);
});

// A computer for runFontSetup: its distribution, dpkg's answers, apt's candidate, the person's
// answers; what ran interactively is kept.
function machine({ os = "ID=debian\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n", installed = [], candidate = "3.8.1", answers = [], fc = "Arial:style=Regular\n", aptStatus = 0, hasSudo = true, uid = 1001, preseedStatus = 0 } = {}) {
  const home = scratch("setup");
  const calls = [], ran = [];
  const state = { installed: new Set(installed) };
  const deps = {
    platform: "linux", uid, user: "pb", hasSudo,
    readOs: () => os,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "dpkg-query") return { status: 0, stdout: args.slice(2).map((p) => `${p} ${state.installed.has(p) ? "ii" : "un"} `).join("\n") };
      if (cmd === "apt-cache") return { status: 0, stdout: `${args[1]}:\n  Installed: (none)\n  Candidate: ${candidate ?? "(none)"}\n` };
      if (cmd === "fc-list") return { status: 0, stdout: fc };
      return { status: 0, stdout: "" };
    },
    interactive: (cmd, args) => {
      ran.push([cmd, ...args]);
      if (aptStatus === 0 && args[1] === "install") for (const p of args.slice(3)) state.installed.add(p);
      return aptStatus;
    },
    ask: async () => answers.shift() ?? null,
    preseed: (selections) => { ran.push(["sudo", "debconf-set-selections", selections]); return preseedStatus; },
    installSelawik: async ({ dir }) => { mkdirSync(dir, { recursive: true }); return { installed: true }; },
    installStandIns: async () => ({ installed: [], failed: [] }),
    now: () => Date.parse("2026-10-22T10:00:00Z"),
    exec: null,
    fontsDir: join(home, "fonts"), record: join(home, "fonts", "setup.json"), conf: join(home, "fonts.conf"),
  };
  return { deps, calls, ran, home, state };
}

test("install on Debian: the free packages, then the core fonts only after the typed yes, Selawik, the record and the alias file", async () => {
  const m = machine({ answers: ["yes"] });
  const printed = [];
  const code = await runFontSetup(["install"], { deps: m.deps, config: {}, print: (l) => printed.push(l) });
  assert.equal(code, 0, printed.join("\n"));
  assert.deepEqual(m.ran, [
    ["sudo", "apt-get", "update"],
    ["sudo", "apt-get", "install", "--no-install-recommends", ...freePackages(PACKAGES.debian)],
    ["sudo", "apt-get", "install", "--no-install-recommends", CORE_PACKAGE],
  ], "apt's own confirmation stays with the person (no -y)");
  const record = JSON.parse(readFileSync(m.deps.record, "utf8"));
  assert.deepEqual(record.coreFonts.eula, { acceptedAt: "2026-10-22T10:00:00.000Z", how: "typed", sha256: sha(readFileSync(EULA_FILE, "utf8")), user: "pb" });
  assert.equal(record.distro, "debian");
  assert.equal(statSync(m.deps.record).mode & 0o777, 0o600);
  assert.match(readFileSync(m.deps.conf, "utf8"), /Stand-ins: on/, "the alias file, on by default");
  assert.ok(m.calls.some((c) => c[0] === "fc-cache"), "Selawik's folder cached");
  assert.ok(printed.some((l) => /^Windows fonts: present Arial/.test(l)), "the check after");
  // Run again: everything in place, the licence accepted once, nothing asked or installed.
  const again = { ...m.deps, ask: async () => assert.fail("asked again") };
  m.ran.length = 0;
  assert.equal(await runFontSetup(["install"], { deps: again, config: { pairbrowse: { fontStandIns: false } }, print: () => {} }), 0);
  assert.deepEqual(m.ran, []);
  assert.match(readFileSync(m.deps.conf, "utf8"), /Stand-ins: off/, "the switch followed");
});

test("install: no answer or no yes skips the core fonts and installs the rest; no contrib or multiverse says how; root refused", async () => {
  const quiet = machine({ answers: [] });
  const printed = [];
  assert.equal(await runFontSetup(["install"], { deps: quiet.deps, config: {}, print: (l) => printed.push(l) }), 0);
  assert.ok(!quiet.ran.some((r) => r.includes(CORE_PACKAGE)), "never installed without the person's yes");
  assert.ok(printed.some((l) => /core fonts: skipped \(nobody answered: run this in a terminal/.test(l)));
  assert.equal(JSON.parse(readFileSync(quiet.deps.record, "utf8")).coreFonts, undefined);
  const no = machine({ answers: ["no"] });
  await runFontSetup(["install"], { deps: no.deps, config: {}, print: () => {} });
  assert.ok(!no.ran.some((r) => r.includes(CORE_PACKAGE)));
  const debian = machine({ candidate: null, answers: ["yes"] });
  const said = [];
  await runFontSetup(["install"], { deps: debian.deps, config: {}, print: (l) => said.push(l) });
  assert.ok(said.some((l) => /in Debian's contrib section, which this computer's package sources don't include/.test(l)));
  assert.ok(!debian.ran.some((r) => r.includes(CORE_PACKAGE)));
  const ubuntu = machine({ os: "ID=ubuntu\nID_LIKE=debian\n", candidate: null });
  const told = [];
  await runFontSetup(["install"], { deps: ubuntu.deps, config: {}, print: (l) => told.push(l) });
  assert.ok(told.some((l) => /sudo add-apt-repository multiverse/.test(l)));
  // The package's own EULA question declined: apt fails, the fonts stay absent, no record of acceptance.
  const declined = machine({ os: "ID=ubuntu\nID_LIKE=debian\n", installed: freePackages(PACKAGES.ubuntu), answers: ["yes"], aptStatus: 100 });
  assert.equal(await runFontSetup(["install"], { deps: declined.deps, config: {}, print: () => {} }), 1);
  assert.equal(JSON.parse(readFileSync(declined.deps.record, "utf8")).coreFonts, undefined);
  const root = machine({ uid: 0 });
  const rootSaid = [];
  assert.equal(await runFontSetup(["install"], { deps: root.deps, config: {}, print: (l) => rootSaid.push(l) }), 2);
  assert.match(rootSaid[0], /not as root/);
  assert.deepEqual(root.ran, []);
});

test("install with the owner's preset acceptance: no question, the core fonts installed, the source recorded; Ubuntu preseeded first; a preseed that fails skips them", async () => {
  // Debian, config.json: nobody at a terminal (ask answers null), the fonts still go in.
  const debian = machine({ answers: [] });
  const printed = [];
  assert.equal(await runFontSetup(["install"], { deps: debian.deps, config: { server: { acceptMsCoreFontsEula: true } }, print: (l) => printed.push(l) }), 0, printed.join("\n"));
  assert.ok(debian.ran.some((r) => r.includes(CORE_PACKAGE)), "installed on the owner's acceptance");
  assert.ok(!debian.ran.some((r) => r[1] === "debconf-set-selections"), "Debian's package asks nothing: no preseed");
  const record = JSON.parse(readFileSync(debian.deps.record, "utf8"));
  assert.deepEqual(record.coreFonts.eula, { acceptedAt: "2026-10-22T10:00:00.000Z", how: "preset", source: "server.acceptMsCoreFontsEula in config.json", sha256: sha(readFileSync(EULA_FILE, "utf8")), user: "pb" });
  assert.ok(printed.some((l) => /accepted by the owner beforehand \(server\.acceptMsCoreFontsEula in config\.json\)/.test(l)));
  assert.ok(!printed.some((l) => /GRANT OF LICENSE/.test(l)), "the text is named, not shown");
  // Ubuntu, the flag: debconf is given the owner's answer before the package installs.
  const ubuntu = machine({ os: "ID=ubuntu\nID_LIKE=debian\n", installed: freePackages(PACKAGES.ubuntu), answers: [] });
  assert.equal(await runFontSetup(["install", "--accept-ms-corefonts-eula"], { deps: ubuntu.deps, config: {}, print: () => {} }), 0);
  const at = ubuntu.ran.findIndex((r) => r[1] === "debconf-set-selections");
  assert.ok(at >= 0, "preseeded");
  assert.deepEqual(ubuntu.ran[at], ["sudo", "debconf-set-selections", `${CORE_PACKAGE} msttcorefonts/accepted-mscorefonts-eula select true\n`]);
  assert.ok(ubuntu.ran.findIndex((r) => r.includes(CORE_PACKAGE)) > at, "the package after the preseed");
  assert.equal(JSON.parse(readFileSync(ubuntu.deps.record, "utf8")).coreFonts.eula.source, "the --accept-ms-corefonts-eula flag");
  // The preseed fails: the package would ask in a terminal nobody is at, so it is skipped and the
  // run says so (exit 1); no acceptance recorded.
  const failed = machine({ os: "ID=ubuntu\nID_LIKE=debian\n", installed: freePackages(PACKAGES.ubuntu), preseedStatus: 1 });
  const said = [];
  assert.equal(await runFontSetup(["install", "--accept-ms-corefonts-eula"], { deps: failed.deps, config: {}, print: (l) => said.push(l) }), 1);
  assert.ok(!failed.ran.some((r) => r.includes(CORE_PACKAGE)));
  assert.ok(said.some((l) => /debconf didn't take the owner's acceptance/.test(l)));
  assert.equal(JSON.parse(readFileSync(failed.deps.record, "utf8")).coreFonts, undefined);
  // Without a preset nothing changes: no answer skips them and names the config key as the way for a server.
  const quiet = machine({ answers: [] });
  const told = [];
  await runFontSetup(["install"], { deps: quiet.deps, config: { server: { keepAlive: true } }, print: (l) => told.push(l) });
  assert.ok(!quiet.ran.some((r) => r.includes(CORE_PACKAGE)) && !quiet.ran.some((r) => r[1] === "debconf-set-selections"));
  assert.ok(told.some((l) => /record your acceptance as server\.acceptMsCoreFontsEula in config\.json/.test(l)));
  // The flag belongs to install only.
  const usage = [];
  assert.equal(await runFontSetup(["check", "--accept-ms-corefonts-eula"], { deps: quiet.deps, config: {}, print: (l) => usage.push(l) }), 2);
  assert.deepEqual(usage, [USAGE]);
  assert.match(USAGE, /install \[--accept-ms-corefonts-eula\]/);
});

test("install elsewhere names the packages; check reports; off Linux and a wrong command say so", async () => {
  const fedora = machine({ os: "ID=fedora\nPRETTY_NAME=\"Fedora Linux 41\"\n" });
  const printed = [];
  assert.equal(await runFontSetup(["install"], { deps: fedora.deps, config: {}, print: (l) => printed.push(l) }), 1, "not in place while the packages are missing");
  assert.ok(printed.includes(`On this distribution install the packages yourself: sudo dnf install ${freePackages(PACKAGES.fedora).join(" ")}`));
  assert.ok(printed.some((l) => /never takes them from elsewhere/.test(l)));
  assert.ok(printed.includes(`Fonts missing: ${FREE_FAMILIES.join(", ")}`));
  assert.match(printed.at(-1), /^Fonts the browser needs are still missing/);
  assert.deepEqual(fedora.ran, [], "nothing run with sudo there");
  // Once the person has installed them (fontconfig lists their fonts): in place.
  const done = machine({ os: "ID=arch\n", fc: "Noto Color Emoji:style=Regular\nNoto Sans CJK JP:style=Regular\nCarlito:style=Regular\nCaladea:style=Regular\nLiberation Sans:style=Regular\nLiberation Serif:style=Regular\nLiberation Mono:style=Regular\n" });
  const doneSaid = [];
  assert.equal(await runFontSetup(["install"], { deps: done.deps, config: {}, print: (l) => doneSaid.push(l) }), 0, doneSaid.join("\n"));
  assert.ok(doneSaid.includes("Fonts: emoji and CJK installed"));
  // A distribution the setup doesn't know: the same check.
  assert.equal(await runFontSetup(["install"], { deps: machine({ os: "ID=gentoo\n" }).deps, config: {}, print: () => {} }), 1);
  assert.deepEqual(freeFamiliesLacking(null), [...FREE_FAMILIES], "fc-list not asked: nothing counts as installed");
  const m = machine({ installed: ["fontconfig"], fc: "Carlito:style=Regular\nLiberation Sans:style=Regular\n" });
  const lines = [];
  assert.equal(await runFontSetup(["check"], { deps: m.deps, config: {}, print: (l) => lines.push(l) }), 0);
  assert.deepEqual(m.ran, [], "check installs nothing");
  assert.equal(lines[0], "Distribution: Debian GNU/Linux 12 (bookworm)");
  assert.match(lines[1], /^Packages missing: fonts-noto-color-emoji fonts-noto-cjk$/);
  assert.match(lines[2], /core fonts: not installed \(install asks you about Microsoft's licence first\)/);
  assert.match(lines.at(-1), /^Windows fonts: standing in Arial \(Liberation Sans\); absent /, "Liberation, the system's own alias, while Arimo isn't installed");
  assert.ok(lines.includes(`Open stand-ins: not installed: ${STAND_IN_DIRS.join(", ")} (install takes them from their publishers, pinned)`));
  const notLinux = [];
  assert.equal(await runFontSetup(["check"], { deps: { ...m.deps, platform: "darwin" }, config: {}, print: (l) => notLinux.push(l) }), 0);
  assert.match(notLinux[0], /for a Linux server/);
  const usage = [];
  assert.equal(await runFontSetup(["remove"], { deps: m.deps, config: {}, print: (l) => usage.push(l) }), 2);
  assert.deepEqual(usage, [USAGE]);
});

test("one distinct stand-in per Windows family: no two Windows names answer with one font", () => {
  const standIns = STAND_INS.map((s) => s.standIn);
  assert.equal(new Set(standIns).size, standIns.length, "every Windows family its own stand-in");
  assert.equal(new Set(STAND_INS.map((s) => s.family)).size, STAND_INS.length);
  for (const s of STAND_INS) assert.ok(REPORT_FONTS.includes(s.family), `${s.family} is reported`);
  // Every other name for a Windows family's faces leans on that family, never a stand-in of its own.
  for (const a of NAME_ALIASES) {
    assert.ok(STAND_INS.some((s) => s.family === a.of), a.name);
    assert.ok(!STAND_INS.some((s) => s.family === a.name), `${a.name} has no stand-in of its own`);
  }
  // The probe a width check draws ("mmmmmmmmmmlli", in em at the font's default instance), as
  // measured from the pinned files (hmtx advances; docs/server.md, Fonts): pairwise apart, so
  // width(Verdana) == width(Arial) and its like never hold where Windows has them apart.
  const probe = { Selawik: 9.3398, "Selawik Light": 8.8330, "Selawik Semilight": 9.0889, "Selawik Semibold": 9.7896, Carlito: 8.6768, Caladea: 8.9490, Arimo: 8.9966, Tinos: 8.6118,
    Cousine: 7.8013, Gelasio: 9.6738, "DejaVu Sans": 10.5747, "DejaVu Sans Condensed": 9.5146, "Fira Sans": 9.4380, "Comic Relief": 8.5967, Anton: 8.3223, Inconsolata: 6.5 };
  assert.deepEqual(Object.keys(probe).sort(), [...standIns].sort(), "each stand-in measured");
  const widths = Object.values(probe);
  for (let i = 0; i < widths.length; i++) for (let j = i + 1; j < widths.length; j++) assert.ok(Math.abs(widths[i] - widths[j]) > 0.01, `${Object.keys(probe)[i]} and ${Object.keys(probe)[j]} measure apart`);
  // Which family each pinned folder carries: every stand-in but Selawik's (its own pin) and DejaVu
  // Sans Condensed (DejaVu's folder) has one.
  const pinned = new Set(STAND_IN_FONTS.map((f) => f.family));
  for (const s of standIns) if (!/^Selawik/.test(s) && s !== "DejaVu Sans Condensed") assert.ok(pinned.has(s), `${s} pinned`);
});

test("the stand-ins' files: each from its publisher, every font and licence pinned, published names kept", () => {
  assert.match(GOOGLE_FONTS_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(new Set(STAND_IN_DIRS).size, STAND_IN_DIRS.length);
  assert.ok(!STAND_IN_DIRS.includes("selawik"), "Selawik keeps its own folder and pin");
  for (const pin of STAND_IN_FONTS) {
    assert.match(pin.dir, /^[a-z]+$/);
    assert.ok(Object.keys(pin.fonts).length > 0, pin.dir);
    for (const [name, h] of Object.entries(pin.fonts)) { assert.match(h, /^[0-9a-f]{64}$/, name); assert.match(name, /\.ttf$/); assert.doesNotMatch(name, /[/\\]/); }
    assert.match(pin.license.sha256, /^[0-9a-f]{64}$/);
    assert.ok(["OFL.txt", "LICENSE"].includes(pin.license.file), "the licence under its published name");
    if (pin.archive) {
      assert.match(pin.archive.url, /^https:\/\/github\.com\/dejavu-fonts\/dejavu-fonts\/releases\/download\/version_2_37\//);
      assert.match(pin.archive.sha256, /^[0-9a-f]{64}$/);
      assert.ok(pin.license.inArchive);
    } else {
      assert.equal(pin.base, `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/${pin.dir}/`, "Google Fonts' own repository at the pinned commit");
      assert.match(pin.license.url, /^https:\/\/raw\.githubusercontent\.com\/(google\/fonts|googlefonts\/[a-z]+)\/[0-9a-f]{40}\//, "a licence from the publisher, at a commit");
      assert.equal(pin.licence, "SIL OFL 1.1");
    }
  }
  // Only publishers' own addresses: Google Fonts' repository, the family's own repository under
  // googlefonts, DejaVu's release.
  const urls = STAND_IN_FONTS.flatMap((p) => [p.base, p.license.url, p.archive?.url].filter(Boolean));
  for (const u of urls) assert.match(u, /^https:\/\/(raw\.githubusercontent\.com\/(google\/fonts|googlefonts\/tinos)\/|github\.com\/dejavu-fonts\/dejavu-fonts\/releases\/)/, u);
  assert.equal(urlName("Inconsolata[wdth,wght].ttf"), "Inconsolata%5Bwdth%2Cwght%5D.ttf");
});

test("a stand-in installs only as pinned: fonts and licence checked, from a URL or the release archive, nothing else written", async () => {
  const a = Buffer.from("font a ".repeat(40)), b = Buffer.from("font b"), lic = Buffer.from("SIL Open Font License 1.1");
  const served = new Map([["https://example.test/f/A%5Bwght%5D.ttf", a], ["https://example.test/f/B.ttf", b], ["https://example.test/f/OFL.txt", lic]]);
  const asked = [];
  const download = async (url, dest, want) => {
    asked.push(url);
    const data = served.get(url);
    if (!data || sha(data) !== want) throw new Error("doesn't match its pinned SHA-256");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, data);
    return dest;
  };
  const home = scratch("standin");
  const pin = { dir: "fam", family: "Fam", base: "https://example.test/f/", fonts: { "A[wght].ttf": sha(a), "B.ttf": sha(b) }, license: { file: "OFL.txt", url: "https://example.test/f/OFL.txt", sha256: sha(lic) } };
  const dir = join(home, "fonts", "fam");
  assert.deepEqual(await installStandIn({ dir, pin, downloads: join(home, "dl"), download }), { installed: true });
  assert.deepEqual(readdirSync(dir).sort(), ["A[wght].ttf", "B.ttf", "OFL.txt"], "published names, the licence beside them");
  assert.deepEqual(readFileSync(join(dir, "A[wght].ttf")), a, "unchanged");
  assert.ok(standInInstalled(dir, pin));
  assert.deepEqual(await installStandIn({ dir, pin, downloads: join(home, "dl"), download }), { installed: false });
  assert.equal(asked.length, 3, "in place: nothing fetched again");
  // A file off its pin: nothing written at all.
  const bad = join(home, "fonts", "bad");
  await assert.rejects(installStandIn({ dir: bad, pin: { ...pin, fonts: { "B.ttf": sha(a) } }, downloads: join(home, "dl2"), download }), /pinned SHA-256/);
  assert.equal(existsSync(bad), false);
  // From a release archive: only the pinned fonts and the licence, under their own names.
  const archive = zip([["rel/ttf/A.ttf", a, 8], ["rel/ttf/Other.ttf", b, 0], ["rel/LICENSE", lic, 8]]);
  const apin = { dir: "rel", family: "Rel", archive: { url: "https://example.test/rel.zip", file: "rel.zip", sha256: sha(archive), prefix: "rel/ttf/" }, fonts: { "A.ttf": sha(a) }, license: { file: "LICENSE", inArchive: "rel/LICENSE", sha256: sha(lic) } };
  served.set("https://example.test/rel.zip", archive);
  const rdir = join(home, "fonts", "rel");
  assert.deepEqual(await installStandIn({ dir: rdir, pin: apin, downloads: join(home, "dl"), download }), { installed: true });
  assert.deepEqual(readdirSync(rdir).sort(), ["A.ttf", "LICENSE"]);
  await assert.rejects(installStandIn({ dir: join(home, "fonts", "x"), pin: { ...apin, fonts: { "C.ttf": sha(a) } }, downloads: join(home, "dl"), download }), /Rel's release has no C\.ttf/);
  await assert.rejects(installStandIn({ dir: join(home, "fonts", "y"), pin: { ...apin, license: { ...apin.license, sha256: sha(a) } }, downloads: join(home, "dl"), download }), /Rel's LICENSE doesn't match/);
  // All of them: each family on its own, a failure named and the rest still installed.
  const all = await installStandIns({ fontsDir: join(home, "all"), pins: [pin, { ...pin, dir: "broken", fonts: { "B.ttf": sha(a) } }, apin], downloads: join(home, "dl"), download });
  assert.deepEqual(all.installed, ["fam", "rel"]);
  assert.deepEqual(all.failed.map((f) => f.dir), ["broken"]);
  assert.deepEqual(standInsMissing(join(home, "all"), [pin, apin]), []);
  assert.deepEqual(standInsMissing(join(home, "none"), [pin, apin]), ["fam", "rel"]);
});

test("install puts the stand-ins in place, caches their folders, records them, and fails while one is missing", async () => {
  const m = machine({ installed: [...freePackages(PACKAGES.debian), CORE_PACKAGE] });
  m.deps.installStandIns = async ({ fontsDir }) => { assert.equal(fontsDir, m.deps.fontsDir); return { installed: ["arimo"], failed: [{ dir: "tinos", error: "Tinos's Tinos-Bold.ttf doesn't match its pinned SHA-256" }] }; };
  const said = [];
  assert.equal(await runFontSetup(["install"], { deps: m.deps, config: {}, print: (l) => said.push(l) }), 1);
  assert.ok(said.includes("Open stand-ins installed from their publishers (pinned, unchanged): arimo."));
  assert.ok(said.includes("The open stand-in tinos couldn't be installed: Tinos's Tinos-Bold.ttf doesn't match its pinned SHA-256"));
  assert.ok(m.calls.some((c) => c[0] === "fc-cache" && c[1] === join(m.deps.fontsDir, "arimo")));
  assert.ok(!m.calls.some((c) => c[0] === "fc-cache" && c[1] === join(m.deps.fontsDir, "tinos")), "a failed family isn't cached");
  assert.deepEqual(JSON.parse(readFileSync(m.deps.record, "utf8")).standInFonts, [], "the record lists only the families in place as pinned");
});
