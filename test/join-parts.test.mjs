// follow.mjs's parts (daemon/join/*.mjs) share the session joined now as live.cur. A local named
// live inside one of them hides it: live.cur reads undefined and the check after an await quietly
// returns (a joiner stopped taking the host's tab order that way).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../scripts/daemon/join/", import.meta.url).pathname;

test("no part of a joined session declares its own live", () => {
  const files = [join(dir, "../follow.mjs"), ...readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => join(dir, f))];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const own = [...src.matchAll(/\b(?:const|let|var)\s+(?:live\b|\[[^\]]*\blive\b|\{[^}]*\blive\b)|\(\s*(?:[^()]*,\s*)?live\s*(?:,[^()]*)?\)\s*=>|\blive\s*=>/g)].map((m) => m[0]);
    const allowed = f.endsWith("follow.mjs") ? ["const live"] : [];
    assert.deepEqual(own.filter((x) => !allowed.includes(x)), [], f);
  }
});
