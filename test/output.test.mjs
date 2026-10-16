import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutput } from "../scripts/daemon/output.mjs";

const setup = (values = { SHOP_PW: "hunter2-secret" }) => {
  const dir = mkdtempSync(join(tmpdir(), "pb-output-"));
  return { dir, out: createOutput({ dir, secretValues: () => values }) };
};

test("passwords in results become their names, and the newest saved ones count", () => {
  const values = { SHOP_PW: "hunter2-secret" };
  const { out } = setup(values);
  assert.equal(out.mask("typed hunter2-secret twice: hunter2-secret"), "typed <secret>SHOP_PW</secret> twice: <secret>SHOP_PW</secret>");
  values.BANK_PW = "correct-horse";
  assert.equal(out.mask("correct-horse"), "<secret>BANK_PW</secret>", "a password saved after start is masked at once");
});

test("a password that starts with another saved one is masked whole", () => {
  const { out } = setup({ SHORT: "hunter2", LONG: "hunter2xyz9" });
  const masked = out.mask("a=hunter2 b=hunter2xyz9");
  assert.equal(masked, "a=<secret>SHORT</secret> b=<secret>LONG</secret>");
  assert.ok(!masked.includes("xyz9"));
});

test("snapshot files a result links to are masked; your own files and unlinked ones are left alone", () => {
  const { dir, out } = setup();
  const snap = join(dir, "page-2026-10-06T10-00-00-000Z.yml");
  const other = join(dir, "page-2026-10-06T11-00-00-000Z.yml");
  const mine = join(dir, "notes.txt");
  for (const f of [snap, other, mine]) writeFileSync(f, "password: hunter2-secret\n");
  out.maskLinkedFiles(`- [Snapshot](${snap}) and [mine](${mine})`);
  assert.equal(readFileSync(snap, "utf8"), "password: <secret>SHOP_PW</secret>\n");
  assert.equal(readFileSync(other, "utf8"), "password: hunter2-secret\n", "only linked files");
  assert.equal(readFileSync(mine, "utf8"), "password: hunter2-secret\n", "never a file that isn't Playwright's output");
});

test("a link can't reach outside the files folder", () => {
  const { dir, out } = setup();
  const outside = mkdtempSync(join(tmpdir(), "pb-outside-"));
  const name = "page-2026-10-06T10-00-00-000Z.yml";
  writeFileSync(join(outside, name), "hunter2-secret");
  out.maskLinkedFiles(`[x](${join(outside, name)}) [y](../${name})`);
  assert.equal(readFileSync(join(outside, name), "utf8"), "hunter2-secret");
  assert.ok(!existsSync(join(dir, name)));
});

test("a long snapshot is cut at a line and the whole of it saved where Claude is told", () => {
  const { dir, out } = setup();
  const short = "x".repeat(24_000 * 1.25);
  assert.equal(out.capSnapshot(short), short, "a little over isn't cut");
  const lines = Array.from({ length: 4000 }, (_, i) => `- line ${i} ${"y".repeat(10)}`).join("\n");
  const capped = out.capSnapshot(lines);
  assert.ok(capped.length < lines.length);
  const head = capped.split("\n```\n")[0];
  assert.ok(head.length <= 24_000 && lines.startsWith(`${head}\n`), "whole lines only");
  const file = capped.match(/The whole snapshot is in (\S+)\.$/)[1];
  assert.equal(join(dir, file.split(/[\\/]/).pop()), file);
  // The note's shape is what a joiner's masking (serve.mjs forJoiner) turns into the file's name.
  assert.match(capped, /The whole snapshot is in [^\s]*page-[^\s]*\.yml\.$/);
  assert.equal(readFileSync(file, "utf8"), lines);
  assert.match(capped, /about \d+ tokens/);
});

// An action's result as the browser server writes it: the snapshot in a file, linked.
const actionResult = (file) => `### Ran Playwright code\n\`\`\`js\nawait page.goto('https://x.test/');\n\`\`\`\n### Page\n- Page URL: https://x.test/\n- Page Title: X\n### Snapshot\n- [Snapshot](${file})`;
const yaml = '- generic [active] [ref=e1]:\n  - heading "X" [level=1] [ref=e2]\n  - textbox "Password" [ref=e3]: hunter2-secret\n  - button "Go" [ref=e4]\n';

test("an action's linked snapshot file comes into the result as browser_snapshot prints it, masked", () => {
  const { dir, out } = setup();
  const file = join(dir, "page-2026-10-10T10-00-00-000Z.yml");
  writeFileSync(file, yaml);
  const text = out.inlineSnapshot(actionResult(file));
  const masked = yaml.replace("hunter2-secret", "<secret>SHOP_PW</secret>");
  assert.equal(text, `${actionResult(file).split("\n- [Snapshot]")[0]}\n\`\`\`yaml\n${masked.trimEnd()}\n\`\`\``);
  assert.ok(!text.includes("[Snapshot]"), "the link is gone: the text is here");
  assert.match(text, /### Page\n- Page URL: https:\/\/x\.test\/\n- Page Title: X\n### Snapshot\n```yaml\n- generic/);
  assert.equal(readFileSync(file, "utf8"), masked, "the file on disk is masked too");
  // A file that already carries a fence isn't fenced twice.
  writeFileSync(file, `\`\`\`yaml\n${yaml}\`\`\`\n`);
  assert.equal(out.inlineSnapshot(actionResult(file)).match(/```/g).length, 4, "one js fence, one yaml fence");
});

test("an action's snapshot comes shorter: long link addresses cut, long option lists counted, ad frames in a line", () => {
  const long = `https://ad.doubleclick.net/ddm/clk/${"x".repeat(3000)}`;
  const years = Array.from({ length: 200 }, (_, i) => `    - option "${2026 - i}"${i === 30 ? " [selected]" : ""}`);
  const snap = [
    "- generic [ref=e1]:",
    `  - link "Shop" [ref=e2] [cursor=pointer]:`,
    `    - /url: https://shop.test/${"p".repeat(400)}`,
    `  - combobox "Year" [ref=e3]:`,
    ...years,
    `  - combobox "Size" [ref=e4]:`,
    `    - option "S"`,
    `    - option "M" [selected]`,
    "  - iframe [ref=e5]:",
    `    - link "Ad" [ref=f2e1] [cursor=pointer]:`,
    `      - /url: ${long}`,
    `      - img [ref=f2e2]`,
    `    - link "Why this ad?" [ref=f2e3]:`,
    `      - /url: https://adssettings.googlesyndication.com/whythisad`,
    "  - iframe [ref=e6]:",
    `    - textbox "Card" [ref=f3e1]`,
    `    - link "Help" [ref=f3e2]:`,
    `      - /url: https://pubmatic.com/help`,
    `  - button "Next" [ref=e7]`,
  ].join("\n");
  const { dir, out } = setup();
  const file = join(dir, "page-2026-10-10T10-00-00-001Z.yml");
  writeFileSync(file, snap);
  const text = out.inlineSnapshot(`### Page\n- Page URL: https://x.test/\n### Snapshot\n- [Snapshot](${file})`);
  assert.ok(text.length < snap.length / 3, `${text.length} of ${snap.length}`);
  assert.match(text, /- \/url: https:\/\/shop\.test\/p{140,170}…\n/, "a long address cut");
  assert.doesNotMatch(text, /x{300}/);
  assert.match(text, /- option "2026"\n/, "the first options stay");
  assert.match(text, /- option "1996" \[selected\]/, "the chosen one stays");
  assert.match(text, /- option "1827"\n/, "and the last");
  assert.match(text, /- \(\d+ more options\)/);
  assert.match(text, /# 200 options in all; browser_select_option takes any by its text/);
  assert.match(text, /- option "S"\n {4}- option "M" \[selected\]/, "a short list stays whole");
  assert.match(text, /- iframe \[ref=e5\]: an ad \(5 lines left out\)/);
  assert.doesNotMatch(text, /Why this ad/);
  assert.match(text, /textbox "Card" \[ref=f3e1\]/, "a frame with a field stays, whatever its links");
  assert.match(text, /button "Next" \[ref=e7\]/);
});

test("a snapshot link to a missing file, a file outside the files folder or one that isn't Playwright's stays a link", () => {
  const { dir, out } = setup();
  const missing = actionResult(join(dir, "page-2026-10-10T10-00-00-000Z.yml"));
  assert.equal(out.inlineSnapshot(missing), missing);
  const outside = mkdtempSync(join(tmpdir(), "pb-outside-"));
  writeFileSync(join(outside, "page-2026-10-10T10-00-00-001Z.yml"), yaml);
  const far = actionResult(join(outside, "page-2026-10-10T10-00-00-001Z.yml"));
  assert.equal(out.inlineSnapshot(far), far, "only the files folder is read");
  writeFileSync(join(dir, "notes.yml"), yaml);
  const mine = actionResult(join(dir, "notes.yml"));
  assert.equal(out.inlineSnapshot(mine), mine, "never a file that isn't Playwright's output");
  assert.equal(out.inlineSnapshot("### Result\nClicked.\n### Page\n- Page URL: https://x.test/"), "### Result\nClicked.\n### Page\n- Page URL: https://x.test/", "a result without a snapshot is left alone");
});

test("typing and hovering get a short snapshot inline; a long one keeps its link and says to snapshot", () => {
  const { dir, out } = setup();
  const file = join(dir, "page-2026-10-10T10-00-00-000Z.yml");
  writeFileSync(file, yaml);
  assert.match(out.inlineSnapshot(actionResult(file), { short: true }), /```yaml\n- generic/, "under the limit: inline");
  const long = Array.from({ length: 400 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`).join("\n");
  assert.ok(long.length > 6000 && long.length < 24_000);
  writeFileSync(file, long);
  const kept = out.inlineSnapshot(actionResult(file), { short: true });
  assert.ok(kept.includes(`- [Snapshot](${file}): long (about ${Math.round(long.length / 4)} tokens). Take a browser_snapshot for fresh refs.`), kept);
  assert.ok(!kept.includes("```yaml"));
  assert.match(out.inlineSnapshot(actionResult(file)), /```yaml\n- link "Item 0"/, "a click or a navigation gets it whatever its length (capSnapshot cuts a very long one)");
});

test("a very long inlined snapshot is cut as browser_snapshot's is, and only then is a file named", () => {
  const { dir, out } = setup();
  const file = join(dir, "page-2026-10-10T10-00-00-000Z.yml");
  const lines = Array.from({ length: 4000 }, (_, i) => `- line ${i} ${"y".repeat(10)}`).join("\n");
  writeFileSync(file, lines);
  const inlined = out.inlineSnapshot(actionResult(file));
  assert.ok(!/\]\(/.test(inlined), "no link before the cut");
  const capped = out.capSnapshot(inlined);
  assert.match(capped, /^### Ran Playwright code\n[\s\S]*### Snapshot\n```yaml\n- line 0 /, "the result's own sections stay in front");
  assert.match(capped, /\n```\n\n### PairBrowse\n- This page's snapshot is long \(about \d+ tokens\)[\s\S]*The whole snapshot is in \S+page-[^ ]+\.yml\.$/);
  assert.ok(capped.length < inlined.length);
});

test("at start, old snapshot files are masked and those over an hour old are swept", () => {
  const { dir, out } = setup();
  const fresh = join(dir, "console-2026-10-06T10-00-00-000Z.log");
  const old = join(dir, "page-2026-10-01T10-00-00-000Z.yml");
  const mine = join(dir, "page-old-notes.yml");
  for (const f of [fresh, old, mine]) writeFileSync(f, "hunter2-secret");
  const longAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
  utimesSync(old, longAgo, longAgo);
  utimesSync(mine, longAgo, longAgo);
  out.start();
  assert.equal(readFileSync(fresh, "utf8"), "<secret>SHOP_PW</secret>");
  assert.ok(!existsSync(old));
  assert.equal(readFileSync(mine, "utf8"), "hunter2-secret", "not Playwright's name: kept and untouched");
});

test("a files folder that isn't there doesn't stop the helper", () => {
  const out = createOutput({ dir: join(tmpdir(), "pb-missing-", String(Date.now())), secretValues: () => ({}) });
  assert.doesNotThrow(() => out.start());
  assert.doesNotThrow(() => out.maskLinkedFiles("[x](page-2026-10-06T10-00-00-000Z.yml)"));
});

test("the main frame's refs come to Claude plain whatever Playwright numbers the frame; frames keep theirs", async () => {
  const { createRefNames } = await import("../scripts/daemon/output.mjs");
  const refs = createRefNames();
  // The first page in a tab: Playwright's refs are plain already.
  assert.equal(refs.toPlain('- button "One" [ref=e4]', true), '- button "One" [ref=e4]');
  assert.equal(refs.toFrame({ target: "e4" }).target, "e4");
  // After a navigation Playwright numbers the main frame (f3), and a frame inside it (f4).
  const snap = ['- generic [active] [ref=f3e1]:', '  - button "Two" [ref=f3e4]', '  - iframe [ref=f3e5]:', '    - button "In frame" [ref=f4e2]'].join("\n");
  assert.equal(refs.mainFrameSeq(snap), 3);
  const plain = refs.toPlain(snap, true);
  assert.equal(plain, ['- generic [active] [ref=e1]:', '  - button "Two" [ref=e4]', '  - iframe [ref=e5]:', '    - button "In frame" [ref=f4e2]'].join("\n"));
  // What Claude sends gets the number back, for refs it was given; a frame's ref and a selector go as they are.
  assert.deepEqual(refs.toFrame({ element: "Two", target: "e4" }), { element: "Two", target: "f3e4" });
  assert.deepEqual(refs.toFrame({ startTarget: "e4", endTarget: "f4e2" }), { startTarget: "f3e4", endTarget: "f4e2" });
  assert.deepEqual(refs.toFrame({ fields: [{ name: "a", target: "e1", value: "x" }, { name: "b", target: "#id", value: "y" }] }).fields.map((f) => f.target), ["f3e1", "#id"]);
  // A ref from the page before (never handed out for this one) stays as it is: Playwright turns it away, as before.
  const stale = { target: "e9" };
  assert.equal(refs.toFrame(stale), stale);
  // A later result about the same page (an error naming the ref) reads plain too.
  assert.equal(refs.toPlain("Ref f3e4 not found"), "Ref e4 not found");
  // The next navigation numbers the frame anew: the old plain refs are forgotten with it.
  // A snapshot of one element inside a frame, or a find result, never changes the number: its
  // frame's refs keep their prefix (f9e2 is in a frame, not the page).
  assert.equal(refs.toPlain('- combobox "Pet" [ref=f9e2]'), '- combobox "Pet" [ref=f9e2]');
  assert.equal(refs.toFrame({ target: "f9e2" }).target, "f9e2");
  refs.toPlain('- button "Three" [ref=f6e2]', true);
  assert.equal(refs.toFrame({ target: "e4" }).target, "e4");
  assert.equal(refs.toFrame({ target: "e2" }).target, "f6e2");
  assert.equal(refs.plainOf("f6e2"), "e2", "a message about that call names the ref as Claude sent it");
  // A whole snapshot of another tab sets the number anew (the agent works there now).
  assert.equal(refs.toPlain('- button [ref=f9e2]', true).includes("f9e2"), false);
});

test("a snapshot whose first refs are inside a frame still finds the main frame's number", async () => {
  const { createRefNames } = await import("../scripts/daemon/output.mjs");
  const refs = createRefNames();
  const snap = ['- generic:', '  - iframe [ref=f2e1]:', '    - button "In frame" [ref=f5e2]', '  - button "Main" [ref=f2e3]'].join("\n");
  assert.equal(refs.mainFrameSeq(snap), 2);
  const noRefOnFrame = ['- generic:', '  - iframe:', '    - button "In frame" [ref=f5e2]', '  - button "Main" [ref=f2e3]'].join("\n");
  assert.equal(refs.mainFrameSeq(noRefOnFrame), 2);
  assert.equal(refs.mainFrameSeq("no refs here"), null);
});

test("after the page moved on with no whole-page snapshot, the frame numbers to ask about are named, and the main one learned comes plain", async () => {
  const { createRefNames } = await import("../scripts/daemon/output.mjs");
  const refs = createRefNames();
  refs.toPlain('- button "A" [ref=f3e1]', true); // the main frame is f3
  const found = '- button "Next" [ref=f45e7]\n- button "Ad" [ref=f46e2]\n- link [ref=f3e9]\n- button [ref=f45e8]';
  assert.deepEqual(refs.unknownSeqs(found), [{ seq: 45, ref: "f45e7" }, { seq: 46, ref: "f46e2" }], "the known main frame's isn't asked about; each number once");
  assert.equal(refs.toPlain(found).includes("f45e7"), true, "until the page says, nothing changes");
  refs.learnMain(45);
  const plain = refs.toPlain(found);
  assert.match(plain, /\[ref=e7\]/);
  assert.match(plain, /\[ref=f46e2\]/, "a frame keeps its number");
  assert.equal(refs.toFrame({ target: "e7" }).target, "f45e7", "a plain ref goes back framed");
  refs.learnMain(0);
  refs.learnMain("x");
  assert.match(refs.toPlain("[ref=f45e8]"), /\[ref=e8\]/, "a bad number changes nothing");
});

test("a result's snapshot can be taken out, inline or linked, and something put in its place", async () => {
  const { withoutSnapshot } = await import("../scripts/daemon/serve/result.mjs");
  const linked = "### Result\n- ok\n### Page\n- Page URL: https://x.test/\n### Snapshot\n- [Snapshot](page-2026-10-10T10-00-00-000Z.yml)\n";
  assert.equal(withoutSnapshot(linked, "### Page outline\nPage: X\n"), "### Result\n- ok\n### Page\n- Page URL: https://x.test/\n### Page outline\nPage: X\n");
  const inline = "### Page\n- Page URL: https://x.test/\n### Snapshot\n```yaml\n- button [ref=e1]\n```\n### Events\n";
  assert.equal(withoutSnapshot(inline), "### Page\n- Page URL: https://x.test/\n### Events\n");
  assert.equal(withoutSnapshot("no snapshot", "x"), "no snapshot");
});
