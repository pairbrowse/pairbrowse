// One copy of each shared truth (ui/vocab.js, ui/urls.js, ui/limits.js): the helper, the page
// script and the pages read the same values, and the live view serves every module its page imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as vocab from "../ui/vocab.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

test("the helper's color and word lists are vocab.js's own", async () => {
  const hud = await import("../scripts/daemon/hud.mjs");
  const tabsync = await import("../scripts/tabsync.mjs");
  const common = await import("../ui/common.js");
  assert.equal(hud.APP_COLORS, vocab.APP_COLORS);
  assert.equal(hud.AGENT_FALLBACKS, vocab.AGENT_FALLBACKS);
  assert.equal(hud.SPARK_COLORS, vocab.SPARK_COLORS);
  assert.equal(tabsync.PEOPLE_COLORS, vocab.PEOPLE_COLORS);
  assert.equal(common.STATE_WORDS, vocab.STATE_WORDS);
  assert.equal(common.isColor, vocab.isColor);
  assert.equal(vocab.AGENT_COLOR, vocab.SPARK_COLORS[0]);
  for (const c of vocab.PEOPLE_COLORS) assert.ok(!vocab.SPARK_COLORS.includes(c), `${c} is a person's color, never an agent's`);
});

test("Claude's orange is written once: the page script and the sheets take it from vocab.js", async () => {
  const { hudScript } = await import("../scripts/browser.mjs");
  const { source } = hudScript();
  assert.ok(source.includes(vocab.AGENT_COLOR) && !source.includes("__PB_AGENT_COLOR__"));
  assert.match(read("ui/tokens.css"), new RegExp(`--spark: ${vocab.AGENT_COLOR};`));
  const files = ["scripts/hud.js", "scripts/liveview.js", "scripts/tabsync.mjs", "scripts/daemon.mjs", "scripts/daemon/follow.mjs", "scripts/daemon/approvals.mjs",
    "scripts/liveview/push.mjs", "ui/right/right.js", "ui/screen/screen.js", "ui/capture/record.js"];
  for (const f of files) assert.ok(!read(f).toLowerCase().includes(vocab.AGENT_COLOR), `${f} names the color itself`);
});

test("the tools' enums are the vocabulary's", async () => {
  const { STATUS_TOOL, INVITE_TOOL } = await import("../scripts/policy.mjs");
  assert.deepEqual(STATUS_TOOL.inputSchema.properties.kind.enum, [...vocab.STATUS_KINDS]);
  assert.deepEqual(INVITE_TOOL.inputSchema.properties.role.enum, [...vocab.ROLES]);
  assert.deepEqual(INVITE_TOOL.inputSchema.properties.mode.enum, [...vocab.SHARE_MODES]);
});

test("the browser's own addresses have one set of rules, for the helper and the pages", async () => {
  const urls = await import("../ui/urls.js");
  const policy = await import("../scripts/policy.mjs");
  const common = await import("../ui/common.js");
  for (const name of ["isChromePage", "isChromeScreenPage", "hiddenFromLiveView", "CHROME_PAGE_ORIGINS"]) assert.equal(policy[name], urls[name], name);
  for (const name of ["addressToUrl", "servedByBrowser", "REPORT_URL"]) assert.equal(common[name], urls[name], name);
  assert.equal((await import("../scripts/browser.mjs")).extensionOrigin, urls.extensionOrigin);
  assert.deepEqual([...urls.CHROME_PAGE_ORIGINS], ["chrome://pairbrowse", "chrome://pairbrowse.top-chrome"]);
  assert.equal(urls.ownPage("settings#passwords"), "pairbrowse://settings#passwords");
  for (const u of ["pairbrowse://activity", "pairbrowse://activity#x", "chrome://pairbrowse/activity/", "chrome://pairbrowse/activity?y"]) assert.ok(urls.isOwnTabPage("activity", u), u);
  for (const u of ["pairbrowse://activityx", "https://pairbrowse/activity", "", undefined]) assert.ok(!urls.isOwnTabPage("activity", u), String(u));
  assert.ok(!urls.isOwnTabPage("settings", "pairbrowse://settings#a", "\\/|$") && urls.isOwnTabPage("settings", "pairbrowse://settings#a", "\\/|#|$"));
  assert.ok(urls.isShownScreenPage("pairbrowse://screen/#t1") && !urls.isShownScreenPage("chrome://pairbrowse/screen/"));
  assert.equal(urls.extensionUrl("abc", "picker/index.html"), "chrome-extension://abc/picker/index.html");
  // No page or helper module spells the browser's own hosts itself.
  for (const f of ["ui/pairbrowse-adapter.js", "ui/common.js", "ui/approve/approve.js", "scripts/policy.mjs", "scripts/daemon/context.mjs", "scripts/daemon/follow.mjs"]) {
    // Comments, and the sentence that tells an agent so (CHROME_PAGE_RULE), name them in words.
    const code = read(f).replace(/^\s*\/\/.*$/gm, "").replace(/^export const CHROME_PAGE_RULE = .*$/m, "");
    const spelled = code.match(/chrome:\/\/pairbrowse|"pairbrowse\.top-chrome"|(HOST|host) = "pairbrowse"|pairbrowse:\\\/\\\/screen/);
    assert.equal(spelled?.[0], undefined, f);
  }
});

// Every relative import of a served module is itself served (the live view serves a fixed list).
test("the live view serves every module its page imports", async () => {
  const { ASSET_FILES } = await import("../scripts/liveview/http.mjs");
  const served = new Map(Object.entries(ASSET_FILES).map(([name, file]) => [name, normalize(join("scripts", file))]));
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    assert.ok(served.has(name), `${name} is imported by the live view page but not served`);
    const src = read(served.get(name));
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/gm)) {
      assert.match(spec, /^\.\/[a-z0-9-]+\.js$/, `${name} imports ${spec}: the live view serves flat names only`);
      walk(spec.slice(2));
    }
  };
  walk("liveview.js");
  assert.ok(seen.has("vocab.js") && seen.has("common.js"));
});
