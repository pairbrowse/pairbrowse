import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-runner-"));
const { preflight, substitute, savePlaybook, loadPlaybook, listPlaybooks, riskReason } = await import("../scripts/runner.mjs");
const uploads = join(process.env.PAIRBROWSE_HOME, "files", "uploads");

test("a run needs between 1 and 200 steps", () => {
  assert.equal(preflight([]), "No steps.");
  assert.equal(preflight(null), "No steps.");
  assert.equal(preflight(Array.from({ length: 201 }, () => ({ press: "Tab" }))), "Too many steps (max 200).");
  assert.equal(preflight(Array.from({ length: 200 }, () => ({ press: "Tab" }))), null);
});

test("go steps open only web pages, and never the local network", () => {
  assert.equal(preflight([{ go: "https://example.com/signup" }]), null);
  assert.match(preflight([{ fill: { Email: "a@b.c" } }, { go: "file:///etc/passwd" }]), /^Step 2 \(go\): .*only opens web pages/);
  assert.match(preflight([{ go: "javascript:alert(1)" }]), /only opens web pages/);
  assert.match(preflight([{ go: "not a url" }]), /Not a valid URL/);
  assert.match(preflight([{ go: "http://192.168.1.1/admin" }]), /local network\. Use browser_navigate/);
  assert.match(preflight([{ go: "http://localhost:3000/" }]), /local network/);
});

test("unknown and empty steps are refused before anything runs", () => {
  assert.match(preflight([{ eval: "document.cookie" }]), /^Step 1 \(eval\): unknown step/);
  assert.match(preflight([{}]), /^Step 1 \(undefined\): unknown step/);
  assert.match(preflight([null]), /unknown step/);
  for (const kind of ["fill", "check", "uncheck", "select", "press", "waitFor", "expect", "handoff", "click"]) assert.equal(preflight([{ [kind]: "x" }]), null, kind);
});

test("drag steps take 2 to 200 points as fractions of the page, and must move", () => {
  assert.equal(preflight([{ drag: [[0.1, 0.1], [0.5, 0.5]] }]), null);
  for (const bad of [[[0.1, 0.1]], [[0, 0], [1.5, 0]], [[0, 0], [-0.1, 0]], [[0, 0], [0.5]], [[0, 0], ["0.5", 0]], "0,0", Array.from({ length: 201 }, (_, i) => [i / 201, 0])]) {
    assert.match(preflight([{ drag: bad }]), /drag takes 2 to 200 points/, JSON.stringify(bad));
  }
  assert.match(preflight([{ drag: [[0.5, 0.5], [0.505, 0.5], [0.5, 0.505]] }]), /has to move/);
});

test("scroll steps take up, down or a non-zero number of pixels up to 20000", () => {
  for (const ok of ["down", "up", 400, -400, "250", 20000, -20000]) assert.equal(preflight([{ scroll: ok }]), null, String(ok));
  for (const bad of ["left", 0, 20001, "fast", null, Infinity]) assert.match(preflight([{ scroll: bad }]), /scroll takes/, String(bad));
});

test("upload steps get the same file checks as pairbrowse_upload", () => {
  mkdirSync(uploads, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "pb-upl-"));
  const logo = join(dir, "logo.png");
  writeFileSync(logo, "png");
  const script = join(dir, "run.sh");
  writeFileSync(script, "echo");
  const key = join(dir, "id_rsa");
  writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.equal(preflight([{ upload: { Logo: logo } }], uploads), null);
  assert.match(preflight([{ upload: { Logo: logo, Other: join(dir, "missing.png") } }], uploads), /^Step 1 \(upload\): .*not found/);
  assert.match(preflight([{ upload: { File: script } }], uploads), /only images, video and documents/);
  assert.match(preflight([{ upload: { Key: key } }], uploads), /never uploaded/);
});

test("vars fill in {{name}} everywhere in the steps, keys included", () => {
  const steps = [{ go: "https://{{host}}/signup" }, { fill: { "{{label}}": "{{email}}", Plain: "x" } }, { drag: [[0.1, 0.2], [0.3, 0.4]] }, { scroll: 300 }];
  assert.deepEqual(substitute(steps, { host: "shop.test", label: "Email", email: "a@b.c" }), [
    { go: "https://shop.test/signup" }, { fill: { Email: "a@b.c", Plain: "x" } }, { drag: [[0.1, 0.2], [0.3, 0.4]] }, { scroll: 300 },
  ]);
  assert.equal(substitute("{{n}} items", { n: 3 }), "3 items");
  assert.equal(substitute("{{ spaced }} and {{a-b}}", {}), "{{ spaced }} and {{a-b}}", "only {{word}} is a var");
  assert.equal(substitute(null, {}), null);
});

test("a var that isn't given stops the run, even one named like an object's own property", () => {
  assert.throws(() => substitute([{ fill: { Email: "{{email}}" } }], {}), /missing var email/);
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => substitute(`{{${name}}}`, {}), new RegExp(`missing var ${name}`), name);
  }
  assert.equal(substitute("{{toString}}", { toString: "given" }), "given");
});

test("playbooks round-trip by name, list their vars, and can't leave their folder", () => {
  const steps = [{ go: "https://{{host}}/" }, { fill: { Email: "{{email}}", Name: "{{name}}", Again: "{{email}}" } }];
  savePlaybook("Shop Signup", steps);
  assert.deepEqual(loadPlaybook("Shop Signup"), steps);
  assert.deepEqual(loadPlaybook("shop-signup"), steps, "names are matched by their slug");
  savePlaybook("../../outside", [{ press: "Tab" }]);
  const folder = join(process.env.PAIRBROWSE_HOME, "playbooks");
  assert.deepEqual(readdirSync(folder).sort(), ["outside.json", "shop-signup.json"]);
  writeFileSync(join(folder, "broken.json"), "{ not json");
  writeFileSync(join(folder, "nosteps.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(folder, "notes.txt"), "ignored");
  assert.deepEqual(listPlaybooks().sort(), ["../../outside (1 steps)", "Shop Signup (2 steps; vars: host, email, name)"]);
  assert.throws(() => loadPlaybook("never saved"), /ENOENT/);
});

test("a risky click's refusal says why and what kind of final action it is", () => {
  assert.equal(riskReason({ why: ["a card field on the page"], word: "pay" }), "a card field on the page: a final action (pay)");
  assert.equal(riskReason({ why: [], word: "submit" }), "it commits something: a final action (submit)");
});

test("a stroke stops where it is when a person takes over, and the button is let go", async () => {
  const { runSteps } = await import("../scripts/runner.mjs");
  const did = [];
  const cdp = { send: async (m, p) => { did.push(p.type === "mouseMoved" ? `move ${p.x},${p.y}` : p.type === "mousePressed" ? "down" : "up"); }, detach: async () => {} };
  const page = {
    evaluate: async () => [1000, 800],
    context: () => ({ newCDPSession: async () => cdp }),
    mouse: { move: async (x, y) => { did.push(`reach ${x},${y}`); } },
  };
  let moves = 0;
  const r = await runSteps(page, [{ drag: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.5, 0.5]] }], {
    activity() {}, cursor: async () => {},
    interrupted: () => (++moves > 2 ? "The user took over this tab mid-step" : ""),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /took over/);
  assert.equal(did.at(-1), "up", "never left holding the button");
  assert.equal(did[0], "reach 100,80", "the hand reaches the start first");
  assert.equal(did[1], "down", "pressed right where it reached");
  assert.ok(!did.some((d) => d.startsWith("move 500")), "it stopped before the end");
});

test("dates for date fields: only ones that can mean a single day become YYYY-MM-DD", async () => {
  const { isoDate } = await import("../scripts/runner.mjs");
  assert.equal(isoDate("03/15/1990"), "1990-03-15");
  assert.equal(isoDate("15.03.1990"), "1990-03-15");
  assert.equal(isoDate("March 15, 1990"), "1990-03-15");
  assert.equal(isoDate("15 Mar 1990"), "1990-03-15");
  assert.equal(isoDate("1990-03-15"), "1990-03-15");
  assert.equal(isoDate("03/04/1990"), "", "ambiguous: never a guess");
  assert.equal(isoDate("13/13/1990"), "");
});
