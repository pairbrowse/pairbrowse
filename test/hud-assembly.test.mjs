// The page script is kept in parts (scripts/hud/*.js) and injected as one: the parts joined in
// order are the script as it was in one file (same SHA-256), one valid script, and every
// placeholder hudScript() fills is in it and filled.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import vm from "node:vm";
import { HUD_PARTS, hudPart, hudSource } from "../scripts/hud/assemble.mjs";
import { hudScript } from "../scripts/browser.mjs";

// SHA-256 of scripts/hud.js before the split (commit 9c462de): the parts change nothing. A
// deliberate change to the page script updates this value with it (last: the
// shadow roots' CSS as constructed stylesheets, so a page whose CSP allows no inline styles keeps
// the bar, the badge, the cursor and the pointers styled).
const PRE_SPLIT_SHA256 = "fb1171e762e995ebd3c79bac9506e21945a744f3d3aadebdcb6e892c07646af4";
const PLACEHOLDERS = ["__PB_NAME__", "__PB_TOKEN__", "__PB_TAG_HUD__", "__PB_TAG_BAR__", "__PB_TAG_CURSOR__", "__PB_AGENT_COLOR__", '"__PB_MOTION__"'];

test("the parts joined are the page script as it was in one file", () => {
  assert.equal(createHash("sha256").update(hudSource()).digest("hex"), PRE_SPLIT_SHA256);
});

test("every part in scripts/hud/ is joined, once, and each ends its last line", () => {
  const files = readdirSync(new URL("../scripts/hud/", import.meta.url)).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual([...HUD_PARTS].sort(), files);
  assert.equal(new Set(HUD_PARTS).size, HUD_PARTS.length);
  for (const f of HUD_PARTS) assert.ok(hudPart(f).endsWith("\n"), `${f} ends its last line`);
});

test("the joined script has each placeholder hudScript fills, and the injected one has none left", () => {
  const raw = hudSource();
  for (const p of PLACEHOLDERS) assert.ok(raw.includes(p), `${p} in the page script`);
  const { source, name, token, tags } = hudScript();
  assert.doesNotMatch(source, /__PB_/);
  assert.ok(source.includes(`"${name}"`) && source.includes(`"${token}"`));
  for (const t of Object.values(tags)) assert.ok(source.includes(`"${t}"`), `tag ${t} in the script`);
  // One script, as a page's init script runs it (parsed, not run).
  assert.doesNotThrow(() => new vm.Script(source, { filename: "hud.js" }));
  assert.doesNotThrow(() => new vm.Script(raw, { filename: "hud.js" }));
});
