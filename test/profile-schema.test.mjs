// A browser profile record's one schema (spec server-mode Phase D, D6, D10, D17, D19;
// scripts/profiles/schema.mjs): typed settings only, strict (any unknown key, wrong value or
// broken cross-field rule refuses the whole record, named by its key), never a path, extension,
// proxy server, launch option, agent option, canvas bridge or hardware value; messages never
// repeat a string value.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkConfig, configProblem, configWarnings, PROFILE_SELECT, PROFILE_SELECT_REFUSED } from "../scripts/config-schema.mjs";
import { checkProfile, profileProblem, profileDefaults, PROFILE_SCHEMA, FORBIDDEN_KEYS, SCHEMA_VERSION, FORMAT_VERSION, HISTORY_MAX, licenseRank, mostRestrictive, forbiddenWhy, canonicalJson } from "../scripts/profiles/schema.mjs";

const RECORD = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
const record = (change = {}) => ({ ...structuredClone(RECORD), ...structuredClone(change) });
const problems = (r) => checkProfile(r).problems;
const refused = (r, pattern) => {
  const { profile, problems: list } = checkProfile(r);
  assert.equal(profile, null, `refused: ${JSON.stringify(list)}`);
  assert.ok(list.some((p) => pattern.test(p)), `${pattern} in ${JSON.stringify(list)}`);
};

test("the versions are the first ones", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(FORMAT_VERSION, 1);
});

test("the spec's example record passes as written, copied (never the caller's object)", () => {
  const { profile, problems: list } = checkProfile(RECORD);
  assert.deepEqual(list, []);
  assert.deepEqual(profile, RECORD);
  assert.notEqual(profile, RECORD);
  assert.equal(profileProblem(RECORD), "");
});

test("defaults with the store's identity fields make a valid record; the config-backed default is kind config", () => {
  const base = { schema: 1, id: "p-0000000000000001", revision: 1, status: "active", created: "2026-10-20T10:00:00.123Z", engine: null };
  assert.deepEqual(problems({ ...base, name: "work", kind: "store", ...profileDefaults() }), []);
  assert.deepEqual(problems({ ...base, name: "default", kind: "config", ...profileDefaults() }), []);
  refused({ ...base, name: "work", kind: "config", ...profileDefaults() }, /^kind "config" is only the "default" profile's/);
  refused({ ...base, name: "Default", kind: "store", ...profileDefaults() }, /the name "Default" is the config-backed profile's/);
  // Each call answers fresh objects.
  const a = profileDefaults();
  a.locale.source = "set";
  assert.equal(profileDefaults().locale.source, "system");
});

test("wrong values refused with the key, unknown keys named", () => {
  refused(record({ screen: { ...RECORD.screen, width: 100000 } }), /^screen\.width is a whole number from 320 to 16384, not 100000 \(a whole number\)\.$/);
  refused(record({ screen: { ...RECORD.screen, devicePixelRatio: 9 } }), /^screen\.devicePixelRatio is a number from 0\.5 to 5, not 9/);
  refused(record({ screen: { ...RECORD.screen, colorDepth: 8 } }), /^screen\.colorDepth is 16, 24, 30 or 32, not 8/);
  refused(record({ browser: { kind: "firefox" } }), /^browser\.kind is "pairbrowse" or "pairbrowse-open", not a string\.$/);
  refused(record({ id: "p-XYZ" }), /^id is "p-" and 16 hex digits, not a string\.$/);
  refused(record({ name: "../other" }), /^name is a name of letters/);
  refused(record({ revision: 0 }), /^revision is a whole number of 1 or more, not 0/);
  refused(record({ status: "gone" }), /^status is "active" or "retired"/);
  refused(record({ created: "yesterday" }), /^created is a UTC time/);
  refused(record({ created: "2026-02-31T99:00:00Z" }), /^created is not a real date and time\.$/);
  // Impossible dates that Date.parse rolls over are refused too.
  refused(record({ created: "2026-02-30T10:00:00Z" }), /^created is not a real date and time\.$/);
  refused(record({ created: "2026-04-31T10:00:00.250Z" }), /^created is not a real date and time\.$/);
  assert.deepEqual(problems(record({ created: "2028-02-29T10:00:00.250Z" })), [], "a leap day is a real date");
  refused(record({ locale: { ...RECORD.locale, timezone: "Mars/Olympus" } }), /^locale\.timezone is not a time zone this computer knows\.$/);
  refused(record({ locale: { ...RECORD.locale, languages: ["de-DE", "not a tag"] } }), /^locale\.languages\[1\] is a language tag/);
  refused(record({ locale: { ...RECORD.locale, languages: Array(11).fill("en") } }), /^locale\.languages holds at most 10 entries, not 11\.$/);
  refused(record({ locale: { ...RECORD.locale, source: "guess" } }), /^locale\.source is "set", "system" or "geoip"/);
  refused(record({ graphics: { backend: "metal", require: null } }), /^graphics\.backend is "auto", "software" or "gpu"/);
  refused(record({ graphics: { backend: "gpu", require: { webgl: 3, webgpu: true, platforms: ["linux"] } } }), /^graphics\.require\.webgl is 1 or 2, or null, not 3/);
  refused(record({ graphics: { backend: "gpu", require: { webgl: 2, webgpu: true, platforms: ["windows"] } } }), /^graphics\.require\.platforms\[0\] is "linux" or "macos"/);
  refused(record({ persona: { source: "auto", seed: null } }), /^persona\.source is "seed" or "host"/);
  refused(record({ persona: { source: "seed", seed: "off" } }), /^persona\.seed is a seed of letters/);
  refused(record({ engine: { major: "150", build: "151.0.1.2" } }), /^engine\.build isn't a build of engine\.major 150\.$/);
  refused(record({ screen: { ...RECORD.screen, availWidth: 2000 } }), /^screen\.availWidth \(2000\) is wider than screen\.width \(1920\)\.$/);
  refused(record({ history: [{ revision: 9, at: "2026-10-20T11:00:00Z", change: [], by: "person" }] }), /^history has revision 9, after the record's revision 4\.$/);
  refused(record({ persona: { source: "host", seed: "abc" } }), /persona\.seed is null when persona\.source is "host"/);
  // A missing key is named with what it takes; nothing is filled in.
  const { locale: _, ...noLocale } = RECORD;
  refused(noLocale, /^locale is missing \(an object \{ \.\.\. \}\)\.$/);
  refused(record({ display: { colorScheme: "dark" } }), /^display\.reducedMotion is missing/);
  // Unknown keys: named when they look like a field name, counted otherwise; at the top and inside.
  refused(record({ nickname: "x", "<script>": 1 }), /^unknown keys "nickname", 1 other \(a profile holds only its typed settings\)\.$/);
  refused(record({ display: { ...RECORD.display, contrast: "more" } }), /^unknown key "contrast" in display/);
  // Keys on Object.prototype are unknown keys like any other, at the top and inside a section, and
  // never throw (records come from files: JSON.parse makes "__proto__" an own key).
  for (const k of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "__defineGetter__"]) {
    const top = JSON.parse(JSON.stringify(RECORD).replace(/^\{/, `{${JSON.stringify(k)}:"secretvalue",`));
    refused(top, new RegExp(`^unknown key "${k}" \\(a profile holds only its typed settings\\)\\.$`));
    const inner = JSON.parse(JSON.stringify(RECORD).replace(/"display":\{/, `"display":{${JSON.stringify(k)}:{"values":1},`));
    refused(inner, new RegExp(`^unknown key "${k}" in display`));
  }
  // Every problem is listed, not only the first.
  assert.equal(problems(record({ status: "x", revision: -1, nickname: 1 })).length, 3);
});

test("a record of another schema is refused here: newer never read, older only through the upgrader", () => {
  refused(record({ schema: 2 }), /schema 2, newer than this PairBrowse reads \(1\); update PairBrowse, the file is left as it is/);
  refused(record({ schema: 0 }), /no schema version this PairBrowse knows/);
  refused(record({ schema: "1" }), /no schema version this PairBrowse knows/);
  refused({ ...RECORD, schema: undefined }, /no schema version/);
  for (const v of [null, [], "x", 3]) refused(v, /^a profile record is an object/);
});

test("a profile can't name a path, extension, proxy server, launch option, canvasBridge or hardware value", () => {
  const cases = {
    executablePath: "/Applications/Other.app", userDataDir: "/tmp/x", extensions: ["/tmp/ext"], loadExtension: "/tmp/ext",
    proxy: "http://user:secret@proxy.example:8080", proxyServer: "socks5://h:1080", browserArgs: ["--remote-debugging-port=9222"],
    args: ["--no-sandbox"], env: { LD_PRELOAD: "/tmp/x.so" }, headless: true, browserSandbox: false, canvasBridge: "ws://x",
    humanize: false, gpuVendor: "NVIDIA", gpuRenderer: "RTX 4090", hardwareConcurrency: 64, deviceMemory: 64, maxTouchPoints: 5,
    platform: "Win32", brandVersion: "1.0", webgl: { vendor: "x" }, webgpu: {}, fonts: ["Arial"], fingerprintProfile: "x",
  };
  for (const [key, value] of Object.entries(cases)) {
    const list = problems(record({ [key]: value }));
    assert.ok(list.length && list.every((p) => p.startsWith(`${key}: a profile can't name a `)), `${key}: ${JSON.stringify(list)}`);
    // The value, a credential perhaps, is never repeated.
    for (const p of list) assert.ok(!p.includes("secret") && !p.includes("/tmp") && !p.includes("NVIDIA"), p);
  }
  // Inside a section too, and each says why.
  refused(record({ screen: { ...RECORD.screen, gpuRenderer: "x" } }), /^screen\.gpuRenderer: a profile can't name a hardware value; graphics and hardware are measured/);
  refused(record({ locale: { ...RECORD.locale, proxy: "x" } }), /^locale\.proxy: a profile can't name a proxy server; choose a network by its id in "network"/);
  refused(record({ window: { ...RECORD.window, args: [] } }), /^window\.args: a profile can't name a launch option\.$/);
  // network takes an id, never a server or credentials; the message doesn't repeat it.
  const net = problems(record({ network: "http://user:pw@proxy.example:3128" }));
  assert.deepEqual(net, ["network is a network id from config.json's network.proxies, or null, not a string."]);
  assert.deepEqual(problems(record({ network: "home-vpn" })), []);
  // None of the forbidden names is a field of the schema at any depth.
  const fieldNames = new Set();
  const walk = (fields) => { for (const [k, s] of Object.entries(fields)) { fieldNames.add(k); if (s.fields) walk(s.fields); if (s.each?.fields) walk(s.each.fields); if (s.entries?.value.fields) walk(s.entries.value.fields); } };
  walk(PROFILE_SCHEMA);
  // Only graphics.require names webgl and webgpu: whether the backend must offer them (E8), a
  // requirement checked against the measured browser, never a value set; anywhere else refused.
  assert.deepEqual(FORBIDDEN_KEYS.filter((k) => fieldNames.has(k)), ["webgl", "webgpu"]);
  assert.deepEqual(Object.keys(PROFILE_SCHEMA.graphics.fields.require.fields).filter((k) => FORBIDDEN_KEYS.includes(k)), ["webgl", "webgpu"]);
  refused(record({ graphics: { ...RECORD.graphics, webgl: { vendor: "x" } } }), /^graphics\.webgl: a profile can't name a hardware value/);
});

// Spec D8 (F2): config.json's pairbrowse.profileSelect is closed. Its fields are the engine pack's
// persona-picking options, typed; an option that would run a program, ask another service or fetch
// files is refused by name (its value never repeated) and left out of what is used; any other key
// is named as unknown. Settings refuse to write either. A profile never holds it (D6, D9).
test("profileSelect is closed", () => {
  assert.deepEqual(Object.keys(PROFILE_SELECT.fields).filter((k) => !PROFILE_SELECT_REFUSED.includes(k)),
    ["os", "mode", "topN", "key", "preferLocal", "offline", "maxEncodedSize", "quiet"]);
  assert.deepEqual(PROFILE_SELECT_REFUSED, ["python", "converter", "apiBase", "licenseKey", "localDir", "autoDownload", "autoDownloadCount"]);
  const fine = { os: "macos", mode: "best", topN: 5, key: "k", preferLocal: false, offline: true, maxEncodedSize: 24000, quiet: true };
  const ok = checkConfig({ pairbrowse: { profileSelect: fine } });
  assert.deepEqual(ok.wrong, []);
  assert.deepEqual(ok.unknown, []);
  assert.deepEqual(ok.config.pairbrowse.profileSelect, fine);
  for (const key of PROFILE_SELECT_REFUSED) {
    const value = key === "autoDownload" ? true : key === "autoDownloadCount" ? 3 : "/tmp/secret-program";
    const r = checkConfig({ pairbrowse: { profileSelect: { mode: "best", [key]: value } } });
    assert.equal(r.wrong.length, 1, key);
    assert.match(r.wrong[0], new RegExp(`^pairbrowse\\.profileSelect\\.${key} is refused: PairBrowse never runs a program, asks a service or fetches files to pick a persona`));
    assert.ok(!r.wrong[0].includes("secret") && !configWarnings(r, "config.json")[0].includes("secret"), "the value is never repeated");
    assert.deepEqual(r.config.pairbrowse.profileSelect, { mode: "best" }, `${key} left out of what is used`);
    assert.match(configProblem({ pairbrowse: { profileSelect: { [key]: value } } }), /is refused: .*nothing was written\.$/, `${key}: Settings write nothing`);
  }
  const unknown = checkConfig({ pairbrowse: { profileSelect: { scriptPath: "/x", apibase: "http://x" } } });
  assert.deepEqual(unknown.unknown, ["pairbrowse.profileSelect.scriptPath", "pairbrowse.profileSelect.apibase"]);
  const wrong = checkConfig({ pairbrowse: { profileSelect: { mode: "service", topN: 0, preferLocal: "yes" } } });
  assert.equal(wrong.wrong.length, 3);
  assert.deepEqual(wrong.config.pairbrowse.profileSelect, {});
  refused(record({ profileSelect: { mode: "best" } }), /^unknown key "profileSelect"/);
});

test("provenance, validation and history keep their shapes, bounded", () => {
  const prov = { format: "engine-device/1", file: "capture.json", sha256: "a".repeat(64), importedAt: "2026-10-20T10:00:00Z", by: "person",
    source: "my laptop", license: "own-capture", terms: null, collectedAt: null, tool: null };
  assert.deepEqual(problems(record({ provenance: [prov], license: "CC-BY-4.0" })), []);
  refused(record({ provenance: [{ ...prov, file: "../../etc/passwd" }] }), /^provenance\[0\]\.file is a file's base name/);
  refused(record({ provenance: [{ ...prov, file: ".hidden" }] }), /^provenance\[0\]\.file is a file's base name/);
  refused(record({ provenance: [{ ...prov, sha256: "x" }] }), /^provenance\[0\]\.sha256 is 64 hex digits/);
  refused(record({ provenance: [{ ...prov, by: "agent" }] }), /^provenance\[0\]\.by is "person"/);
  refused(record({ provenance: [{ ...prov, format: "other/1" }] }), /^provenance\[0\]\.format is /);
  refused(record({ provenance: [{ ...prov, source: "x".repeat(201) }] }), /^provenance\[0\]\.source is a string/);
  refused(record({ license: "GPL 3 or whatever; rm -rf" }), /^license is an SPDX license id/);
  assert.deepEqual(problems(record({ license: "MIT OR Apache-2.0" })), []);
  const { schema: _s, id: _i, ...rest } = RECORD;
  refused({ ...rest, schema: 1, id: RECORD.id, kind: "config", name: "default", provenance: [prov] }, /the "default" profile comes from config\.json and has no imported provenance/);

  const item = { field: "locale.timezone", rule: null, class: "C", status: "applied", requested: "Europe/Berlin", measured: "Europe/Berlin", severity: "info", reason: null };
  const entry = { status: "validated", at: "2026-10-20T10:00:00Z", pack: "b".repeat(64), runtimeKey: "c".repeat(64), graphics: { kind: "hardware" }, items: [item] };
  assert.deepEqual(problems(record({ validation: { "150.0.7871.114": entry } })), []);
  const { runtimeKey: _r, graphics: _g, ...plain } = entry;
  assert.deepEqual(problems(record({ validation: { "150.0.7871.114": plain } })), [], "runtimeKey and graphics are optional");
  refused(record({ validation: { "../x": entry } }), /^validation has an entry whose key isn't a build/);
  refused(record({ validation: { "150.0.7871.114": { ...entry, status: "ok" } } }), /^validation\["150\.0\.7871\.114"\]\.status is "validated", "unverified" or "failed"/);
  refused(record({ validation: { "150.0.7871.114": { ...entry, items: [{ ...item, status: "spoofed" }] } } }), /items\[0\]\.status is "applied", "not-applied"/);
  refused(record({ validation: { "150.0.7871.114": { ...entry, graphics: { blob: "x".repeat(20001) } } } }), /graphics is at most 20000 characters as JSON/);
  refused(record({ validation: { "150.0.7871.114": { ...entry, items: [{ ...item, measured: "x".repeat(3000) }] } } }), /items\[0\]\.measured is a short JSON value/);
  // Values with no JSON text (a BigInt, a cycle) are problems, never a throw.
  refused(record({ validation: { "150.0.7871.114": { ...entry, items: [{ ...item, requested: 1n }] } } }), /items\[0\]\.requested is a short JSON value/);
  const cycle = record({ validation: { "150.0.7871.114": entry } });
  cycle.validation["150.0.7871.114"].graphics.self = cycle.validation["150.0.7871.114"].graphics;
  refused(cycle, /\.graphics is a JSON object\.$/);

  refused(record({ history: [{ revision: 1, at: "2026-10-20T10:00:00Z", change: ["../x"], by: "person" }] }), /^history\[0\]\.change\[0\] is a field/);
  refused(record({ history: [{ revision: 1, at: "2026-10-20T10:00:00Z", change: [], by: "agent" }] }), /^history\[0\]\.by is "person", "config", "migration" or "upgrade"/);
  const many = Array.from({ length: HISTORY_MAX + 1 }, () => ({ revision: 1, at: "2026-10-20T10:00:00Z", change: [], by: "person" }));
  refused(record({ history: many }), new RegExp(`^history holds at most ${HISTORY_MAX} entries`));
});

test("license: never looser than the most restrictive source; ranks read SPDX expressions", () => {
  const prov = { format: "engine-device/1", file: "a.json", sha256: "a".repeat(64), importedAt: "2026-10-20T10:00:00Z", by: "person",
    source: "s", license: "GPL-3.0-only", terms: null, collectedAt: null, tool: null };
  assert.deepEqual(problems(record({ provenance: [prov], license: "GPL-3.0-only" })), []);
  assert.deepEqual(problems(record({ provenance: [prov], license: "AGPL-3.0-only" })), [], "stricter than its sources is allowed");
  refused(record({ provenance: [prov], license: "MIT" }), /^license is looser than its sources'/);
  refused(record({ provenance: [{ ...prov, license: "unknown" }], license: "GPL-3.0-only" }), /"unknown"/);
  assert.ok(licenseRank("own-capture") < licenseRank("MIT"));
  assert.ok(licenseRank("MIT") < licenseRank("CC-BY-SA-4.0"));
  assert.ok(licenseRank("LGPL-2.1-only") < licenseRank("GPL-2.0-only"));
  assert.ok(licenseRank("GPL-3.0-only") < licenseRank("AGPL-3.0-only"));
  assert.ok(licenseRank("Some-Other-1.0") > licenseRank("AGPL-3.0-only"), "an id not known ranks under unknown only");
  assert.equal(licenseRank("MIT OR GPL-3.0-only"), licenseRank("MIT"));
  assert.equal(licenseRank("GPL-2.0-only WITH Classpath-exception-2.0"), licenseRank("GPL-2.0-only"));
  assert.equal(mostRestrictive([]), "own-capture");
  assert.equal(mostRestrictive(["MIT", "Apache-2.0"]), "MIT", "the first of equals");
  assert.equal(forbiddenWhy("gpuVendor"), "hardware value");
  assert.equal(forbiddenWhy("timezone"), null);
  assert.equal(canonicalJson({ b: [1, { d: 2, c: null }], a: undefined }), '{"a":null,"b":[1,{"c":null,"d":2}]}');
});
