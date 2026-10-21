// The page script never makes the driver rewrite documents (browser/launch.mjs addPageScript):
// under Patchright an init script, exposeBinding, exposeFunction, the clock or tracing installs a
// route that fulfills every http(s) document itself, and a fulfilled document has no certificate
// (the address bar said "Not secure" on every HTTPS page an agent loaded).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { addPageScript } from "../scripts/daemon/browser/launch.mjs";

const fakeContext = () => { const added = []; return { added, addInitScript: async (s) => { added.push(s); } }; };

test("under Patchright the page script is never an init script; under Playwright it is", async () => {
  const p = fakeContext();
  assert.equal(await addPageScript(p, "patchright", "src"), false);
  assert.deepEqual(p.added, []);
  const w = fakeContext();
  assert.equal(await addPageScript(w, "playwright", "src"), true);
  assert.deepEqual(w.added, [{ content: "src" }]);
});

test("the helper calls none of the driver's document-rewriting APIs anywhere else", () => {
  const root = join(import.meta.dirname, "..", "scripts");
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) { if (n !== "dev") walk(f); } else if (/\.m?js$/.test(n)) files.push(f); } };
  walk(root);
  const found = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\.(addInitScript|exposeBinding|exposeFunction|routeFromHAR|route|routeWebSocket)\(|\.clock\.install\(|\.tracing\.start\(/g)) {
      const rel = relative(root, f);
      if (rel === join("daemon", "browser", "launch.mjs") && m[1] === "addInitScript") continue;
      // paced-motion.mjs forwards the engine pack's own one init script call (the cursor, fast set only) to the context; it adds none of its own.
      if (rel === join("native", "paced-motion.mjs") && m[1] === "addInitScript") continue;
      found.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(found, []);
});
