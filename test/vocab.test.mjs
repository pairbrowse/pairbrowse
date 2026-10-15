// One copy of each shared truth (ui/vocab.js, ui/urls.js, ui/limits.js): the helper, the page
// script and the pages read the same values, and the live view serves every module its page imports.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as vocab from "../ui/vocab.js";
import { hudSource } from "../scripts/hud/assemble.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The page script is read joined, as the helper injects it (scripts/hud/).
const read = (f) => f === "scripts/hud/" ? hudSource() : readFileSync(join(root, f), "utf8");

test("the helper's color and word lists are vocab.js's own", async () => {
  const hud = await import("../scripts/daemon/hud.mjs");
  const tabsync = await import("../scripts/sharing/tabsync.mjs");
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
  const files = ["scripts/hud/", "scripts/liveview.js", "scripts/sharing/tabsync.mjs", "scripts/daemon.mjs", "scripts/daemon/follow.mjs", "scripts/daemon/approvals.mjs",
    "scripts/liveview/push.mjs", "ui/right/right.js", "ui/screen/screen.js", "ui/capture/record.js"];
  for (const f of files) assert.ok(!read(f).toLowerCase().includes(vocab.AGENT_COLOR), `${f} names the color itself`);
});

test("the tools' enums are the vocabulary's", async () => {
  const { STATUS_TOOL, INVITE_TOOL } = await import("../scripts/rules/policy.mjs");
  assert.deepEqual(STATUS_TOOL.inputSchema.properties.kind.enum, [...vocab.STATUS_KINDS]);
  assert.deepEqual(INVITE_TOOL.inputSchema.properties.role.enum, [...vocab.ROLES]);
  assert.deepEqual(INVITE_TOOL.inputSchema.properties.mode.enum, [...vocab.SHARE_MODES]);
});

test("the browser's own addresses have one set of rules, for the helper and the pages", async () => {
  const urls = await import("../ui/urls.js");
  const policy = await import("../scripts/rules/policy.mjs");
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
  for (const f of ["ui/pairbrowse-adapter.js", "ui/common.js", "ui/approve/approve.js", "scripts/rules/policy.mjs", "scripts/daemon/context.mjs", "scripts/daemon/browser/launch.mjs", "scripts/daemon/browser/tabs.mjs", "scripts/daemon/sessions/picker.mjs", "scripts/daemon/follow.mjs", "scripts/daemon/join/screens.mjs"]) {
    // Comments, and the sentence that tells an agent so (CHROME_PAGE_RULE), name them in words.
    const code = read(f).replace(/^\s*\/\/.*$/gm, "").replace(/^export const CHROME_PAGE_RULE = .*$/m, "");
    const spelled = code.match(/chrome:\/\/pairbrowse|"pairbrowse\.top-chrome"|(HOST|host) = "pairbrowse"|pairbrowse:\\\/\\\/screen/);
    assert.equal(spelled?.[0], undefined, f);
  }
});

test("the limits two sides keep are stated once and fit together", async () => {
  const limits = await import("../ui/limits.js");
  const { BODY_MAX } = await import("../scripts/liveview/http.mjs");
  const channel = await import("../scripts/liveview/capture.mjs");
  for (const name of ["CAPTURE_VALUE_MAX", "CAPTURE_SDP_MAX", "CAPTURE_ERROR_MAX"]) assert.equal(channel[name], limits[name], name);
  // The capture page's reply route holds its largest answer: a value, or a recording's piece as base64.
  assert.ok(BODY_MAX.capture > limits.CAPTURE_VALUE_MAX + 1000);
  assert.ok(Math.ceil(limits.PAGE_CHUNK_BYTES / 3) * 4 < limits.CAPTURE_VALUE_MAX, "a piece as base64 is an answer's value");
  assert.ok(limits.CAPTURE_SDP_MAX < limits.CAPTURE_VALUE_MAX);
  // A joiner's helper sends pointers more slowly than the host's takes them.
  assert.ok(1000 / limits.JOINER_POINTER_EVERY_MS < limits.JOINER_POINTERS_PER_SECOND);
  assert.ok(limits.PICK_FILE_MAX <= limits.PICK_TOTAL_MAX && limits.FRAME_SKIP_BYTES < limits.STALLED_BYTES);
  // The pages' join name fields hold what the helper takes.
  for (const page of ["picker", "sessions"]) assert.match(read(`ui/${page}/index.html`), new RegExp(`id="join-name"[^>]*maxlength="${limits.JOIN_NAME_MAX}"`), page);
  // No page or helper module restates them.
  for (const [f, re] of [["ui/capture/transport-native.js", /CAPTURE_\w+_MAX = |CHUNK_BYTES = /], ["ui/screen/screen.js", /50 \* 1024 \* 1024/], ["scripts/daemon/follow.mjs", /50 \* 1024 \* 1024|slice\(0, 20\)/],
    ["scripts/liveview.mjs", /FRAME_EVERY_MS = |_BYTES = \d/], ["scripts/liveview/push.mjs", /_BYTES = \d/], ["scripts/daemon/screenshare.mjs", /FRAME_EVERY_MS = /],
    ["ui/left/left.js", /DRIVING_MS = /], ["ui/right/right.js", /DRIVING_MS = /], ["ui/timeline/timeline.js", /DRIVING_MS = /], ["scripts/daemon/pick.mjs", /_MAX = \d/]]) {
    assert.doesNotMatch(read(f), re, f);
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
