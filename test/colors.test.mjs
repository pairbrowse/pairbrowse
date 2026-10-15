// Agent and people colors: an agent's is its app's (Claude Code orange, Codex purple, Gemini blue),
// a second agent of the same app takes a fallback no agent here has, and people's colors are never
// near any agent's, so a tag's color alone says agent or person.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_COLORS, AGENT_FALLBACKS, SPARK_COLORS, appKey, appColor, pickAgentColor, createHud } from "../scripts/daemon/hud.mjs";
import { PEOPLE_COLORS, personColor } from "../scripts/sharing/tabsync.mjs";

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// OKLab (Ottosson): { L, a, b, h } with h the OKLCH hue in degrees.
function oklab(h) {
  const [r, g, b] = rgb(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a: A, b: B, h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}
const hueGap = (x, y) => { const d = Math.abs(oklab(x).h - oklab(y).h) % 360; return Math.min(d, 360 - d); };
const deltaE = (x, y) => { const p = oklab(x), q = oklab(y); return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b); };

test("each app has the mockup's color, by its MCP client name or its label", () => {
  assert.deepEqual(APP_COLORS, { claude: "#e9763f", codex: "#9b7bfa", gemini: "#4b8ffb" });
  for (const [name, key] of [["claude-code", "claude"], ["remote:claude-code", "claude"], ["Alice · Claude Code", "claude"], ["codex-mcp-client", "codex"], ["remote:codex-mcp-client", "codex"], ["Bob · Codex", "codex"], ["gemini-cli-mcp-client", "gemini"], ["Gemini", "gemini"], ["cursor-vscode", ""], ["", ""], [null, ""]]) {
    assert.equal(appKey(name), key, String(name));
  }
  assert.equal(appColor("claude-code"), "#e9763f");
  assert.equal(appColor("codex-mcp-client"), "#9b7bfa");
  assert.equal(appColor("gemini-cli"), "#4b8ffb");
  assert.equal(appColor("some-agent"), "");
  assert.equal(SPARK_COLORS[0], APP_COLORS.claude, "Claude's own first: the sheets' --spark");
  assert.deepEqual(AGENT_FALLBACKS, ["#4fd1e8", "#e9763f", "#9b7bfa", "#4b8ffb"]);
});

test("a second agent of the same app, or of an app without a color, takes the first fallback no agent has", () => {
  assert.equal(pickAgentColor("claude-code", []), "#e9763f");
  assert.equal(pickAgentColor("claude-code", ["#e9763f"]), "#4fd1e8");
  assert.equal(pickAgentColor("claude-code", ["#e9763f", "#4fd1e8"]), "#9b7bfa");
  assert.equal(pickAgentColor("other", []), "#4fd1e8");
  assert.equal(pickAgentColor("other", ["#4fd1e8"]), "#e9763f");
  assert.equal(pickAgentColor("codex-mcp-client", ["#E9763F"]), "#9b7bfa", "case doesn't matter");
  const all = ["#e9763f", "#9b7bfa", "#4b8ffb", "#4fd1e8"];
  assert.equal(pickAgentColor("claude-code", all), AGENT_FALLBACKS[0], "all taken: repeats");
  assert.equal(pickAgentColor("claude-code", [...all, "#4fd1e8"]), AGENT_FALLBACKS[1]);
});

test("the helper gives each connected agent its color for as long as it's connected", () => {
  const hud = createHud({ pages: async () => [], waiting: () => null, liveView: () => null, notify: () => {} });
  assert.equal(hud.sparkColor("x"), "#e9763f", "not known yet: Claude's orange");
  assert.equal(hud.setApp("a", "claude-code"), "#e9763f");
  assert.equal(hud.setApp("b", "codex-mcp-client"), "#9b7bfa");
  assert.equal(hud.setApp("c", "claude-code"), "#4fd1e8", "a second Claude Code never looks like the first");
  assert.equal(hud.setApp("d", "remote:gemini-cli"), "#4b8ffb", "a joiner's agent: its own app's");
  assert.equal(hud.setApp("a", "codex-mcp-client"), "#e9763f", "a later initialize doesn't recolor it");
  assert.deepEqual(["a", "b", "c", "d"].map(hud.sparkColor), ["#e9763f", "#9b7bfa", "#4fd1e8", "#4b8ffb"]);
  hud.forgetParticipant("a");
  assert.equal(hud.sparkColor("c"), "#4fd1e8", "the others keep theirs when one goes");
  assert.equal(hud.setApp("e", "claude-code"), "#e9763f", "its color is free again");
});

test("people's colors are never near an agent's, nor each other's, and carry the tags' dark ink at WCAG AA", () => {
  const ink = readFileSync(new URL("../scripts/hud.js", import.meta.url), "utf8").match(/const PILL = ".*?;color:(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(ink.toLowerCase(), "#0b1421");
  assert.ok(PEOPLE_COLORS.length >= 5);
  for (const p of PEOPLE_COLORS) {
    assert.ok(!SPARK_COLORS.includes(p), `${p} is an agent color`);
    for (const a of SPARK_COLORS) {
      assert.ok(hueGap(p, a) >= 30, `${p} vs agent ${a}: hue ${hueGap(p, a).toFixed(0)} deg`);
      assert.ok(deltaE(p, a) >= 0.1, `${p} vs agent ${a}: OKLab distance ${deltaE(p, a).toFixed(3)}`);
    }
    for (const q of PEOPLE_COLORS) if (q !== p) assert.ok(hueGap(p, q) >= 20, `${p} vs ${q}: hue ${hueGap(p, q).toFixed(0)} deg`);
    assert.ok(contrast(p, ink) >= 4.5, `${p}: ink contrast ${contrast(p, ink).toFixed(2)}`);
  }
});

test("a person's color is stable per name and always a people color", () => {
  for (const name of ["Kees", "Alice", "Bob", "Sam", "", "Zoë"]) {
    assert.equal(personColor(name), personColor(name));
    assert.ok(PEOPLE_COLORS.includes(personColor(name)), name);
  }
  assert.ok(new Set(["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi"].map(personColor)).size > 1, "names spread over the palette");
});
