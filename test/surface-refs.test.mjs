// The surface references (scripts/dev/surface-refs.mjs), a dev tool: its names and the native
// harness's surfaces always; with PAIRBROWSE_TEST_RUNTIME, a real run: every named reference
// written at its size, references.json saying the same, and every sampled color on its token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { REFERENCES, SURFACES, PAD, TOLERANCE } from "../scripts/dev/surface-refs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

function png(file) {
  const b = readFileSync(file);
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("surface references: the names, sizes and the native harness's surfaces", () => {
  assert.deepEqual(Object.keys(REFERENCES), ["menu", "bubble", "field", "field-focus", "buttons"]);
  assert.deepEqual(REFERENCES.menu, { w: 360 + 2 * PAD, h: 560 + 2 * PAD }, "the left dock's switcher popover, 360 x 560");
  assert.equal(REFERENCES.bubble.w, 364, "the approval bubble, 364 px");
  // 560's --surface names, each mapped to known references only.
  const names = ["app-menu", "context-menu", "omnibox-popup", "permission", "download", "bookmark", "find", "tooltip", "dialog-alert", "dialog-auth",
    "dialog-leave", "page-info", "status", "infobar", "extensions", "fullscreen", "settings", "history", "downloads-page", "bookmarks-page"];
  assert.deepEqual(Object.keys(SURFACES).sort(), [...names].sort());
  for (const [s, refs] of Object.entries(SURFACES)) for (const r of refs) assert.ok(r in REFERENCES, `${s}: ${r}`);
  for (const r of Object.keys(REFERENCES)) assert.ok(Object.values(SURFACES).some((refs) => refs.includes(r)), `${r} is used`);
});

test("surface references: a run writes every reference at its size", { skip: !runtime, timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-sr-"));
  try {
    const r = spawnSync(process.execPath, ["scripts/dev/surface-refs.mjs", "--out", dir], { cwd: root, encoding: "utf8", timeout: 170_000 });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const json = JSON.parse(readFileSync(join(dir, "references.json"), "utf8"));
    assert.equal(json.pass, true);
    assert.equal(json.scale, 1);
    assert.equal(json.tolerance, TOLERANCE);
    assert.deepEqual(Object.keys(json.references).sort(), Object.keys(REFERENCES).sort());
    assert.deepEqual(json.surfaces, SURFACES);
    for (const [name, want] of Object.entries(REFERENCES)) {
      const ref = json.references[name];
      assert.equal(ref.file, `${name}.png`);
      const size = png(join(dir, ref.file));
      assert.deepEqual(size, { w: ref.width, h: ref.height }, `${name}: the PNG is the size references.json says`);
      assert.equal(size.w, want.w, `${name} width`);
      if (want.h !== null) assert.equal(size.h, want.h, `${name} height`);
      else assert.ok(size.h >= 120 && size.h <= 320, `${name} height ${size.h}`);
      // The surface sits inside the PNG.
      assert.ok(ref.box.x >= 0 && ref.box.y >= 0 && ref.box.x + ref.box.w <= size.w && ref.box.y + ref.box.h <= size.h, `${name} box`);
      for (const k of ["fill", "border"].filter((c) => name !== "buttons" || c === "border")) assert.ok(ref.colors[k]?.at, `${name}: ${k} sampled`);
      for (const [k, c] of Object.entries(ref.colors)) {
        assert.match(c.expected, /^#[0-9A-F]{6}$/, `${name} ${k}`);
        if (c.at) assert.equal(c.pass, true, `${name} ${k}: ${c.sampled} for ${c.token} ${c.expected}`);
      }
    }
    // D2's radii as the pages draw them: the popover 10 (--r-3), the card 12, the buttons 8 (--r-2).
    assert.deepEqual([json.references.menu.radius, json.references.bubble.radius.px, json.references.buttons.radius], [{ px: 10, token: "--r-3" }, 12, { px: 8, token: "--r-2" }]);
    assert.equal(json.references.menu.colors.selectedRow.token, "--hover");
    assert.equal(json.references.bubble.colors.primaryButton.token, "--accent-fill");
    assert.equal(json.references["field-focus"].colors.border.token, "--accent");
    assert.deepEqual(json.log.filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
