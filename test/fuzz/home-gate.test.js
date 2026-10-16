// Property-based fuzzing of the project settings gate (scripts/home.mjs settingsNames): a project's
// .claude settings (JSON) or .codex settings (TOML) that set a gated variable, however the key is
// spelled with escapes, always name it; a file that sets none of them never names one.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { settingsNames, PROJECT_GATED } from "../../scripts/home.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });

const gated = fc.constantFrom(...PROJECT_GATED);
const hex = (n, width, upper) => { const h = n.toString(16).padStart(width, "0"); return upper ? h.toUpperCase() : h; };
// Each character as itself or as \uXXXX (either hex case); TOML also takes \UXXXXXXXX.
const spelled = (name, toml) => fc.array(fc.constantFrom(...(toml ? ["plain", "u", "uu", "U"] : ["plain", "u", "uu"])), { minLength: name.length, maxLength: name.length })
  .map((how) => [...name].map((c, i) => {
    const code = c.charCodeAt(0);
    return how[i] === "plain" ? c : how[i] === "U" ? `\\U${hex(code, 8, true)}` : `\\u${hex(code, 4, how[i] === "uu")}`;
  }).join(""));
const otherKey = fc.string({ maxLength: 20 }).filter((k) => !PROJECT_GATED.includes(k.toUpperCase()));
const jsonValue = fc.jsonValue({ maxDepth: 2 });

test("a .claude settings file setting a gated variable names it, however the key is escaped", () => {
  check(fc.property(gated.chain((g) => fc.tuple(fc.constant(g), spelled(g, false))), fc.dictionary(otherKey, jsonValue, { maxKeys: 4 }), fc.boolean(),
    ([name, key], extra, nested) => {
      const envBody = `{${[...Object.entries(extra).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`), `"${key}":"/evil"`].join(",")}}`;
      const text = nested ? `{"permissions":{"allow":[]},"env":${envBody}}` : `{"env":${envBody}}`;
      assert.equal(JSON.parse(text).env[name], "/evil", "Claude Code would read the variable");
      assert.ok(settingsNames("json", text).includes(name), text);
    }));
});

test("a .codex settings file setting a gated variable names it, however the key is escaped", () => {
  check(fc.property(gated.chain((g) => fc.tuple(fc.constant(g), spelled(g, true))), fc.constantFrom("[shell_environment_policy.set]\n", "[mcp_servers.pairbrowse_browser.env]\n", ""), fc.boolean(),
    ([name, key], table, quoted) => {
      const line = quoted || /\\/.test(key) ? `"${key}" = "/evil"` : `${key} = "/evil"`;
      assert.ok(settingsNames("toml", `${table}${line}\n`).includes(name), line);
    }));
});

test("a settings file that sets none of the gated variables names none", () => {
  check(fc.property(fc.dictionary(otherKey, fc.dictionary(otherKey, jsonValue, { maxKeys: 4 }), { maxKeys: 4 }), (obj) => {
    assert.deepEqual(settingsNames("json", JSON.stringify(obj)), []);
  }));
  const tomlKey = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/).filter((k) => !PROJECT_GATED.some((g) => k.includes(g)));
  check(fc.property(fc.array(fc.tuple(tomlKey, fc.stringMatching(/^[a-z0-9 /._-]{0,20}$/)), { maxLength: 6 }), (pairs) => {
    assert.deepEqual(settingsNames("toml", `[shell_environment_policy.set]\n${pairs.map(([k, v]) => `${k} = "${v}"`).join("\n")}\n`), []);
  }));
});

test("any text never throws, and JSON that doesn't parse names every gated variable", () => {
  check(fc.property(fc.string({ unit: "binary", maxLength: 200 }), (t) => {
    const names = settingsNames("json", t);
    let parses = true;
    try { JSON.parse(t.replace(/^\uFEFF/, "")); } catch { parses = false; }
    if (!parses) assert.deepEqual([...names].sort(), [...PROJECT_GATED].sort());
    settingsNames("toml", t);
  }));
});
