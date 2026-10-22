// config.json's one schema (scripts/config-schema.mjs): loadConfig keeps unknown keys and names
// them, refuses a wrong-typed value (the default for that key, with a message naming the key, what
// it takes and the file), never throws; saveConfig and the Settings route refuse such a value
// before anything is written; pairbrowse_status names the warnings.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveConfig, CONFIG_WARNINGS } from "../scripts/paths.mjs";
import { CONFIG_SCHEMA, checkConfig, configProblem, expected, wrongValue, handoffTimes } from "../scripts/config-schema.mjs";
import { statusLine } from "../scripts/daemon/serve/tools/status.mjs";
import { createSettings } from "../scripts/liveview/settings.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-config-schema-"));
let n = 0;
function file(content) {
  const f = join(dir, `config-${n++}.json`);
  writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  return f;
}

test("the schema has exactly DEFAULT_CONFIG's keys and the older names, and every default fits it", () => {
  const older = Object.keys(CONFIG_SCHEMA).filter((k) => CONFIG_SCHEMA[k].older);
  assert.deepEqual(older.sort(), ["browserEngine", "chromeArgs", "chromeSandbox", "executablePath"]);
  assert.deepEqual(Object.keys(CONFIG_SCHEMA).filter((k) => !CONFIG_SCHEMA[k].older).sort(), Object.keys(DEFAULT_CONFIG).sort());
  const r = checkConfig(DEFAULT_CONFIG);
  assert.deepEqual(r.wrong, []);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
});

test("a good config.json loads as written, with no warnings", () => {
  const given = { browser: "pairbrowse-open", maxTabs: 30, browserArgs: ["--lang=en-US"], layout: { left: "rail", right: "open", strip: 100 },
    sharing: { tunnel: { kind: "ngrok", authtoken: "t" }, guestPort: 8443 }, settleMs: null, dockWidth: 420.5,
    pairbrowse: { humanize: false, typingPace: 0.35, motion: "quick", formMove: "mouse", fingerprintProfile: "x", timezone: "Europe/Berlin" } };
  const config = loadConfig(file(given));
  assert.deepEqual(CONFIG_WARNINGS, []);
  for (const [k, v] of Object.entries(given)) assert.deepEqual(config[k], v, k);
  assert.equal(config.screenshots, true, "the defaults fill the rest");
});

test("unknown keys: kept, named in one warning with the file; the native block is closed too", () => {
  const f = file({ maxTab: 5, screenshot: false, sharing: { tunnel: { kind: "quick" }, guestport: 1 }, pairbrowse: { anything: true } });
  const config = loadConfig(f);
  assert.equal(CONFIG_WARNINGS.length, 1);
  assert.match(CONFIG_WARNINGS[0], /^config\.json: unknown keys "maxTab", "screenshot", "sharing\.guestport", "pairbrowse\.anything" \(not used: check the spelling against docs\/configuration\.md\)/);
  assert.ok(CONFIG_WARNINGS[0].includes(f));
  assert.equal(config.maxTab, 5, "kept: the file is the person's own");
  assert.equal(config.maxTabs, 20);
  assert.deepEqual(config.pairbrowse, { anything: true }, "kept in the file's copy; the native launch leaves it out (native-engine.mjs readSettings)");
});

test("a wrong-typed value is refused: the default for that key, a warning naming the key, what it takes and the file", () => {
  const f = file({ maxTabs: "20", screenshots: "no", display: "always", timelineCap: 500, browserArgs: "--lang=en", liveViewPort: -1,
    cookieChoice: true, browser: 7, layout: { left: "big", strip: 100 }, sharing: { tunnel: "quick", guestPort: 70000 },
    pairbrowse: { humanize: "off", typingPace: 3, motion: "fastest", geoip: true }, joinHosts: ["a.example", 5], timeline: false });
  let config;
  assert.doesNotThrow(() => { config = loadConfig(f); });
  const w = CONFIG_WARNINGS.join("\n");
  for (const k of ["maxTabs", "screenshots", "display", "timelineCap", "browserArgs", "liveViewPort", "cookieChoice", "browser", "layout.left", "sharing.tunnel", "sharing.guestPort", "pairbrowse.humanize", "pairbrowse.typingPace", "pairbrowse.motion", "joinHosts"]) {
    assert.match(w, new RegExp(`^config\\.json: ${k.replace(".", "\\.")} is `, "m"), k);
  }
  assert.equal(CONFIG_WARNINGS.length, 15, "one line each");
  assert.ok(CONFIG_WARNINGS.every((l) => l.includes(`using the default for it until it is fixed in ${f}`)));
  assert.ok(CONFIG_WARNINGS.includes(`config.json: maxTabs is a whole number of 1 or more, not "20" (a string); using the default for it until it is fixed in ${f}`));
  assert.match(w, /display is "auto", "xvfb" or "none", not "always" \(a string\)/);
  assert.match(w, /timelineCap is a whole number from 1 to 200, not 500 \(a whole number\)/);
  assert.match(w, /browser is "pairbrowse", "pairbrowse-open" or an absolute path to a browser, or null, not 7/);
  // The defaults for the refused ones; the good ones beside them kept.
  assert.equal(config.maxTabs, 20);
  assert.equal(config.screenshots, true);
  assert.equal(config.display, "auto");
  assert.equal(config.timelineCap, 200);
  assert.deepEqual(config.browserArgs, []);
  assert.equal(config.liveViewPort, 0);
  assert.equal(config.cookieChoice, "accept");
  assert.equal(config.browser, null);
  assert.equal(config.timeline, false);
  assert.deepEqual(config.layout, { strip: 100 }, "layout's good field kept (the docks' own default fills the rest)");
  assert.deepEqual(config.sharing, {});
  assert.deepEqual(config.pairbrowse, { geoip: true });
  assert.deepEqual(config.joinHosts, DEFAULT_CONFIG.joinHosts);
  // The file itself is never rewritten by a load.
  assert.match(readFileSync(f, "utf8"), /"maxTabs":"20"/);
});

test("a config.json that isn't an object, or isn't there: the defaults, never a throw", () => {
  for (const c of ["[1,2]", "7", "\"text\"", "null"]) {
    const config = loadConfig(file(c));
    assert.equal(config.maxTabs, 20, c);
    if (c !== "null") assert.match(CONFIG_WARNINGS.join("\n"), /the file is .*not an object/, c);
  }
  const config = loadConfig(join(dir, "missing.json"));
  assert.deepEqual(CONFIG_WARNINGS, []);
  assert.equal(config.browserDriver, "patchright");
});

test("any value under any key loads without a throw (a sweep of shapes)", () => {
  const shapes = [null, true, false, 0, -1, 1.5, 1e9, NaN, "", "x", [], ["x"], [1], {}, { a: 1 }, { tunnel: null }];
  for (const key of [...Object.keys(CONFIG_SCHEMA), "unknownKey"]) {
    for (const v of shapes) {
      assert.doesNotThrow(() => loadConfig(file({ [key]: v })), `${key}: ${JSON.stringify(v)}`);
    }
  }
});

test("saveConfig refuses a wrong-typed value with the schema's message and writes nothing", () => {
  const f = file({ participantName: "Ann", maxTabs: 9 });
  const before = readFileSync(f, "utf8");
  const message = configProblem({ maxTabs: "12" });
  assert.equal(message, 'maxTabs is a whole number of 1 or more, not "12" (a string); nothing was written.');
  assert.throws(() => saveConfig({ maxTabs: "12" }, f), { message });
  assert.throws(() => saveConfig({ pairbrowse: { motion: 3 } }, f), /pairbrowse\.motion is "fast", "quick", "combined" or "classic", not 3 \(a whole number\); nothing was written\./);
  assert.equal(readFileSync(f, "utf8"), before);
  // Good values and unknown keys still go through (the file is the person's own).
  assert.deepEqual(saveConfig({ maxTabs: 12, theirOwn: 1, skipped: undefined }, f), { participantName: "Ann", maxTabs: 12, theirOwn: 1 });
  assert.equal(configProblem({ maxTabs: 3, nope: [] }), "");
  assert.match(configProblem([1]), /an object/);
});

test("the Settings route words a refused value the way a load does, and never writes one the schema refuses", async () => {
  const f = file({});
  const config = { ...DEFAULT_CONFIG };
  const settings = createSettings({ config, native: true, save: (fields) => saveConfig(fields, f) });
  const r = await settings.write({ maxTabs: "8" });
  assert.equal(r.error, `${wrongValue("maxTabs", { type: "integer", min: 2, max: 50 }, "8")}.`);
  assert.equal(r.error, 'maxTabs is a whole number from 2 to 50, not "8" (a string).');
  assert.equal((await settings.write({ pictures: "no" })).error, 'pictures is true or false, not "no" (a string).');
  assert.equal((await settings.write({ cookies: 1 })).error, 'cookies is "accept" or "reject", not 1 (a whole number).');
  assert.equal(readFileSync(f, "utf8"), "{}", "nothing written");
  const ok = await settings.write({ maxTabs: 8, pictures: false });
  assert.equal(ok.error, undefined);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { maxTabs: 8, screenshots: false });
});

test("expected() words each kind of spec", () => {
  assert.equal(expected({ type: "boolean" }), "true or false");
  assert.equal(expected({ type: "array", items: "string" }), "a list of strings");
  assert.equal(expected({ type: "string", nullable: true }), "a string, or null");
  assert.equal(expected({ values: ["a", "b"] }), '"a" or "b"');
  assert.equal(expected({ type: "number", min: 0.2, max: 1 }), "a number from 0.2 to 1");
});

test("pairbrowse_status names config.json's warnings", () => {
  const selected = { instance: null, source: "default", home: "/h" };
  assert.equal(statusLine(selected, []), "ok");
  assert.equal(statusLine(selected, ["config.json: unknown key \"x\""]), 'ok; warning: config.json: unknown key "x"');
  loadConfig(file({ maxTabs: "x" }));
  assert.match(statusLine(selected), /^ok; warning: config\.json: maxTabs is a whole number/);
  loadConfig(join(dir, "missing.json"));
  assert.equal(statusLine(selected), "ok");
  assert.ok(!existsSync(join(dir, "missing.json")), "a load never writes");
});

test("under pairbrowse, an extension, a proxy, launch options or switches are unknown keys", () => {
  loadConfig(file({ pairbrowse: { extensions: ["/tmp/evil"], proxy: { server: "http://evil:1" }, args: ["--gpu-launcher=x"], ignoreDefaultArgs: true, agentLlmKey: "k", fingerprint: "seed" } }));
  assert.equal(CONFIG_WARNINGS.length, 1);
  for (const k of ["extensions", "proxy", "args", "ignoreDefaultArgs", "agentLlmKey"]) assert.ok(CONFIG_WARNINGS[0].includes(`"pairbrowse.${k}"`), k);
  assert.ok(!CONFIG_WARNINGS[0].includes("pairbrowse.fingerprint"), "an engine fingerprint option is known");
});

test("virtualScreen bounds and server.keepAlive: good values kept, others refused field by field", () => {
  const good = loadConfig(file({ virtualScreen: { width: 800, height: 4320, depth: 16 }, server: { keepAlive: true } }));
  assert.deepEqual(CONFIG_WARNINGS, []);
  assert.deepEqual(good.virtualScreen, { width: 800, height: 4320, depth: 16 });
  assert.deepEqual(good.server, { keepAlive: true });
  assert.deepEqual(loadConfig(file({ server: { keepAlive: true, acceptMsCoreFontsEula: true } })).server, { keepAlive: true, acceptMsCoreFontsEula: true }, "the owner's recorded EULA acceptance (native/fontsetup.mjs)");
  assert.match(loadConfig(file({ server: { acceptMsCoreFontsEula: "yes" } })) && CONFIG_WARNINGS.join("\n"), /server\.acceptMsCoreFontsEula is true or false, not "yes"/);
  const f = file({ virtualScreen: { width: 7681, height: 599, depth: 30, colors: 3 }, server: { keepAlive: "yes" } });
  const config = loadConfig(f);
  const w = CONFIG_WARNINGS.join("\n");
  assert.match(w, /virtualScreen\.width is a whole number from 800 to 7680, not 7681/);
  assert.match(w, /virtualScreen\.height is a whole number from 600 to 4320, not 599/);
  assert.match(w, /virtualScreen\.depth is 16 or 24, not 30 \(a whole number\)/);
  assert.match(w, /server\.keepAlive is true or false, not "yes"/);
  assert.match(w, /unknown key "virtualScreen\.colors"/);
  assert.deepEqual(config.virtualScreen, { colors: 3 }, "the refused fields left out (screenGeometry fills them)");
  assert.deepEqual(config.server, {});
  assert.equal(loadConfig(file({ virtualScreen: "1280x800" })).virtualScreen, DEFAULT_CONFIG.virtualScreen);
  assert.match(configProblem({ virtualScreen: { width: 100 } }), /^virtualScreen\.width is a whole number from 800 to 7680/);
  assert.deepEqual(DEFAULT_CONFIG.virtualScreen, { width: 1366, height: 900, depth: 24 }, "today's screen");
  assert.deepEqual(DEFAULT_CONFIG.server, { keepAlive: false });
});

test("browserSandbox \"required\" is kept by loadConfig; other strings are refused", () => {
  const config = loadConfig(file({ browserSandbox: "required" }));
  assert.deepEqual(CONFIG_WARNINGS, []);
  assert.equal(config.browserSandbox, "required");
  assert.equal(loadConfig(file({ browserSandbox: false })).browserSandbox, false);
  assert.equal(loadConfig(file({ chromeSandbox: false })).browserSandbox, false, "the older name");
  const refused = loadConfig(file({ browserSandbox: "always" }));
  assert.match(CONFIG_WARNINGS.join("\n"), /browserSandbox is true, false or "required", not "always"/);
  assert.equal(refused.browserSandbox, true, "the default");
  assert.match(configProblem({ browserSandbox: "yes" }), /^browserSandbox is true, false or "required"/);
});

test("handoff: types and defaults; a field left out takes its default; remindMinutes at or after grantMinutes falls back", () => {
  assert.deepEqual(DEFAULT_CONFIG.handoff, { enabled: false, away: false, publicLink: false, grantMinutes: 15, remindMinutes: 10, channels: [], send: { approvals: true, checks: true, submits: true, runs: false }, answer: false });
  let config = loadConfig(file({ handoff: { enabled: true, channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC" }] } }));
  assert.deepEqual(CONFIG_WARNINGS, []);
  assert.deepEqual(config.handoff, { ...DEFAULT_CONFIG.handoff, enabled: true, channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC" }] });
  // Wrong types refused (the default for each), one line each.
  config = loadConfig(file({ handoff: { enabled: "yes", away: 1, publicLink: "no", grantMinutes: 121, remindMinutes: 0, channels: ["webhook"] } }));
  const w = CONFIG_WARNINGS.join("\n");
  for (const k of ["enabled", "away", "publicLink", "grantMinutes", "remindMinutes", "channels"]) assert.match(w, new RegExp(`^config\\.json: handoff\\.${k} is `, "m"), k);
  assert.match(w, /handoff\.grantMinutes is a whole number from 1 to 120, not 121/);
  assert.match(w, /handoff\.channels is a list of objects, not \["webhook"\]/);
  assert.deepEqual(config.handoff, DEFAULT_CONFIG.handoff);
  // A channel's own fields aren't the schema's: daemon/notify/ checks them (and names what it skips).
  assert.equal(loadConfig(file({ handoff: { channels: [{ type: "nope", x: 1 }] } })).handoff.channels.length, 1);
  assert.deepEqual(CONFIG_WARNINGS, []);
  // The reminder must come before the link's end.
  config = loadConfig(file({ handoff: { grantMinutes: 30, remindMinutes: 30 } }));
  assert.equal(config.handoff.remindMinutes, 20);
  assert.deepEqual(CONFIG_WARNINGS, ["config.json: handoff.remindMinutes (30) is at or after handoff.grantMinutes (30); reminding after 20 minutes instead"]);
  config = loadConfig(file({ handoff: { grantMinutes: 5 } }));
  assert.equal(config.handoff.remindMinutes, 3, "the default 10 against a 5 minute link");
  assert.equal(CONFIG_WARNINGS.length, 1);
  assert.deepEqual(handoffTimes({ grantMinutes: 1, remindMinutes: 5 }).remindMinutes, 1, "never under a minute");
  // Any reminder from 1 up is read, so one at or past a 120-minute link falls back, not to the default.
  config = loadConfig(file({ handoff: { grantMinutes: 120, remindMinutes: 120 } }));
  assert.equal(config.handoff.remindMinutes, 80);
  assert.deepEqual(CONFIG_WARNINGS, ["config.json: handoff.remindMinutes (120) is at or after handoff.grantMinutes (120); reminding after 80 minutes instead"]);
  config = loadConfig(file({ handoff: { remindMinutes: 500 } }));
  assert.equal(config.handoff.remindMinutes, 10, "500 against the default 15: two thirds of it");
  assert.deepEqual(handoffTimes({ grantMinutes: 120, remindMinutes: 90 }), { grantMinutes: 120, remindMinutes: 90, warning: "" });
});
