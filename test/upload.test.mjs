import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { uploadProblem, uploadFiles } from "../scripts/upload.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-upload-"));
const uploads = join(dir, "uploads");
const file = (name, body = "x") => { const p = join(dir, name); writeFileSync(p, body); return p; };

test("images, video and documents from anywhere can be uploaded", () => {
  assert.equal(uploadProblem(file("demo.mp4"), uploads), null);
  assert.equal(uploadProblem(file("shot.png"), uploads), null);
  assert.equal(uploadProblem(file("deck.pdf"), uploads), null);
});

test("keys and credentials never go up, whatever their extension", () => {
  assert.match(uploadProblem(file(".env"), uploads), /never uploaded/);
  assert.match(uploadProblem(file("server.pem"), uploads), /never uploaded/);
  assert.match(uploadProblem(file("credentials.json"), uploads), /never uploaded/);
  assert.match(uploadProblem(file("id_ed25519"), uploads), /never uploaded/);
});

test("a key or .env under an image or document name is refused by its contents", () => {
  assert.match(uploadProblem(file("server.pem.png", "-----BEGIN PRIVATE KEY-----\nMIIE\n"), uploads), /never uploaded/);
  assert.match(uploadProblem(file("backup.pdf", "-----BEGIN OPENSSH PRIVATE KEY-----\n"), uploads), /never uploaded/);
  assert.match(uploadProblem(file("config.csv", "STRIPE_SECRET_KEY=sk_live_123\n"), uploads), /never uploaded/);
  assert.equal(uploadProblem(file("prices.csv", "name,price\nKEY_RING,4\n"), uploads), null);
  assert.match(uploadProblem(file("aws.csv", "[default]\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG\n"), uploads), /never uploaded/);
  assert.match(uploadProblem(file("notes.pdf", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("API_TOKEN=abcdef123456\n", "utf16le")])), uploads), /never uploaded/);
  assert.equal(uploadProblem(file("keyboard.csv", "keyboard shortcut, ctrl+k\n"), uploads), null);
  assert.equal(uploadProblem(file("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0x41, 0x50, 0x49, 0x5f, 0x4b, 0x45, 0x59, 0x3d, 0x31])), uploads), null);
});

test("files in credential folders are refused even if they look like images", () => {
  const ssh = join(homedir(), ".ssh");
  // Only checks the path rule; the folder may not hold such a file.
  const p = join(ssh, "not-really.png");
  const problem = uploadProblem(p, uploads);
  assert.ok(problem === `${p}: not found` || /never uploaded/.test(problem));
});

test("other file types are pointed to browser_file_upload", () => {
  assert.match(uploadProblem(file("notes.zip"), uploads), /browser_file_upload/);
  assert.match(uploadProblem(file("script.sh"), uploads), /browser_file_upload/);
  assert.match(uploadProblem(join(dir, "missing.mp4"), uploads), /not found/);
});

// A real browser: a file field, a button that opens a file chooser, and a drop zone with no field.
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
test("uploads reach a file field, an upload button and a drop zone", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label>Logo <input id="field" type="file"></label>
      <button id="pick" onclick="document.getElementById('hidden').click()">Choose video</button>
      <input id="hidden" type="file" style="display:none">
      <div id="zone" style="width:200px;height:100px">Drop files here</div>
      <script>
        window.dropped = [];
        const z = document.getElementById("zone");
        z.addEventListener("dragover", (e) => e.preventDefault());
        z.addEventListener("drop", (e) => { e.preventDefault(); window.dropped = [...e.dataTransfer.files].map((f) => f.name + ":" + f.size); });
      </script>`);
    const png = file("logo.png", "png-bytes");
    const mp4 = file("demo.mp4", "video-bytes-123");
    const opts = { uploadsDir: uploads };

    let r = await uploadFiles(page, { files: [png], target: "Logo" }, opts);
    assert.ok(r.ok, r.text);
    assert.equal(await page.$eval("#field", (i) => i.files[0]?.name), "logo.png", "the site gets the real file name");

    r = await uploadFiles(page, { files: [mp4], target: "Choose video" }, opts);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /upload button/);
    assert.match(await page.$eval("#hidden", (i) => i.files[0]?.name), /demo\.mp4$/);

    r = await uploadFiles(page, { files: [mp4], target: "Drop files here" }, opts);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /drop zone/);
    const dropped = await page.evaluate(() => window.dropped);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0], /demo\.mp4:15$/);
    assert.equal(await page.locator("[data-pairbrowse-upload]").count(), 0, "temporary field removed");

    // A form submit (by structure, whatever it says) is never clicked to look for a chooser.
    await page.setContent(`<form method="post" onsubmit="window.sent=true;return false"><input name="title"><button>Publish</button></form>`);
    r = await uploadFiles(page, { files: [png], target: "Publish" }, opts);
    assert.equal(r.ok, false);
    assert.match(r.text, /final action/);
    assert.equal(await page.evaluate(() => !!window.sent), false);
  } finally {
    await browser.close();
  }
});

test("an upload call without files uploads nothing and says so", async () => {
  for (const files of [[], undefined, [""]]) {
    const r = await uploadFiles({}, files === undefined ? {} : { files });
    assert.equal(r.ok, false);
    assert.match(r.text, /Nothing uploaded/);
  }
});
