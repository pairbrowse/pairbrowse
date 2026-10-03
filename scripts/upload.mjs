// pairbrowse_upload: put files from anywhere on this computer into a page's upload field, upload
// button or drag-and-drop zone, in one call. No file picker opens: the browser gets the files
// straight from disk.
//
// The checks run here in the helper, so they hold for every client (Claude Code, Codex, ...):
// images, video and documents go through; key, password and credential files never do; anything
// else is refused with a pointer to browser_file_upload, which asks the user.
import { copyFile, constants, stat, mkdir } from "node:fs/promises";
import { realpathSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { finalActionStrict } from "./guard.mjs";
import { isRef } from "./policy.mjs";
import { buttonLabel } from "./daemon/page.mjs";

export const UPLOAD_TOOL = {
  name: "pairbrowse_upload",
  description:
    "Upload files into the page in one call: an upload field (also hidden ones), an upload button, or a drag-and-drop zone. " +
    "No file picker opens. files: absolute paths anywhere on this computer (a video or screenshot you just made is fine); images, video, PDF and office documents only. " +
    "target: the element ref from the latest snapshot (the field, the button, or the drop zone), or its visible text or label. " +
    "Without a target, the page's only file field is used. Returns what the page now holds.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
      target: { type: "string", description: "Element ref (e.g. e42), a CSS selector, or visible text/label of the field, button or drop zone" },
    },
  },
};

// Images, video and documents: what uploads here, and through browser_file_upload without asking
// (uploadAllowed in guard.mjs).
export const MEDIA = /\.(png|jpe?g|gif|webp|svg|ico|heic|avif|bmp|tiff?|mp4|mov|webm|m4v|pdf|csv|xlsx?|docx?|pptx?)$/i;
// Credentials and keys: never uploaded, whatever the page asks.
const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|id_[a-z0-9]+(\.pub)?|.*\.(pem|p12|pfx|keychain-db|kdbx|asc|gpg)|credentials(\.json)?|secrets?\.(env|json|ya?ml)|\.netrc|\.npmrc|\.pypirc)$/i;
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", "Library/Keychains", ".pairbrowse"];
const MAX_BYTES = 4 * 1024 ** 3;
// A key or .env saved under an innocent name (server.pem.png) is still a key: look inside.
const SECRET_CONTENT = /-----BEGIN ((RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;
// KEY=..., api_key = ..., "client_secret": "..." with a real-looking value (6+ characters).
const ENV_SECRET = /^\s*(export\s+)?["']?[A-Za-z][A-Za-z0-9_.-]*(key|secret|token|password|passwd)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?[^\s"']{6,}/im;
const SCAN_BYTES = 1024 * 1024;

export function secretInside(full) {
  let fd;
  try {
    fd = openSync(full, "r");
    const buf = Buffer.alloc(SCAN_BYTES);
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    // UTF-16 text (a byte-order mark): read it as text, not as bytes with gaps.
    const utf16 = head[0] === 0xff && head[1] === 0xfe ? "utf16le" : head[0] === 0xfe && head[1] === 0xff ? "utf16be" : null;
    const text = utf16 === "utf16le" ? head.toString("utf16le") : utf16 === "utf16be" ? Buffer.from(head).swap16().toString("utf16le") : head.toString("latin1");
    if (SECRET_CONTENT.test(text)) return true;
    return (utf16 || !head.includes(0)) && ENV_SECRET.test(text); // text files only: binary media can hold anything
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function uploadProblem(file, uploadsDir) {
  let full;
  try {
    full = realpathSync(resolve(String(file)));
  } catch {
    return `${file}: not found`;
  }
  const home = homedir();
  const inUploads = full.startsWith(resolve(uploadsDir) + sep);
  if (!inUploads && SECRET_DIRS.some((d) => full.startsWith(join(home, d) + sep))) return `${file}: in a folder with keys or credentials; never uploaded`;
  if (SECRET_NAME.test(full)) return `${file}: looks like a key or credentials file; never uploaded`;
  if (secretInside(full)) return `${file}: contains a private key or password; never uploaded`;
  if (!MEDIA.test(full)) return `${file}: only images, video and documents upload here. For anything else use browser_file_upload, which asks the user`;
  return null;
}

// Copies the files into the uploads folder (an instant clone on APFS), so the browser only ever
// reads from there.
async function stage(files, uploadsDir) {
  await mkdir(uploadsDir, { recursive: true });
  const out = [];
  for (const f of files) {
    const info = await stat(f);
    if (!info.isFile()) throw new Error(`${f}: not a file`);
    if (info.size > MAX_BYTES) throw new Error(`${f}: larger than 4 GB`);
    // A folder of its own, so the site gets the file under its real name.
    const dir = join(uploadsDir, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, basename(f));
    await copyFile(f, dest, constants.COPYFILE_FICLONE);
    out.push(dest);
  }
  return out;
}

// The element the files go to: a ref from the snapshot, or a label/text, or the page's only file field.
async function locate(page, target) {
  if (target && isRef(target)) return page.locator(`aria-ref=${target}`).first();
  if (target) {
    // A CSS selector, like the other browser tools take ("#drop-zone", ".upload input").
    if (/^[#.[]|^[a-z]+[#.[:]/i.test(target)) {
      const l = page.locator(target);
      if (await l.count().catch(() => 0)) return l.first();
    }
    for (const l of [page.getByLabel(target, { exact: false }), page.getByRole("button", { name: target }), page.getByText(target, { exact: false })]) {
      if (await l.count().catch(() => 0)) return l.first();
    }
    throw new Error(`nothing on the page called "${target}"`);
  }
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  if (n === 1) return inputs.first();
  // Drop-zone libraries add hidden fields of their own: the one field you can see is the one.
  const shown = [];
  for (let i = 0; i < Math.min(n, 20); i++) if (await inputs.nth(i).isVisible().catch(() => false)) shown.push(inputs.nth(i));
  if (shown.length === 1) return shown[0];
  throw new Error(n ? `the page has ${n} file fields; name the one you mean as target` : "the page has no file field; give the upload button or drop zone as target");
}

// Puts staged files into the element: a file field directly; a field inside it (drop zones often
// hide one); a button through its file chooser; otherwise a synthetic drop of real File objects.
async function deliver(page, el, files) {
  const isInput = await el.evaluate((n) => n instanceof HTMLInputElement && n.type === "file").catch(() => false);
  if (isInput) {
    await el.setInputFiles(files, { timeout: 10000 });
    return "file field";
  }
  const inner = el.locator('input[type="file"]');
  if (await inner.count().catch(() => 0)) {
    await inner.first().setInputFiles(files, { timeout: 10000 });
    return "file field inside it";
  }
  // A label for a (hidden) file field.
  const forId = await el.evaluate((n) => (n.closest("label") || n).getAttribute("for")).catch(() => null);
  if (forId) {
    const labelled = el.page().locator(`input[type="file"][id="${forId.replace(/"/g, "")}"]`);
    if (await labelled.count().catch(() => 0)) {
      await labelled.first().setInputFiles(files, { timeout: 10000 });
      return "file field of its label";
    }
  }
  // A drop zone: drop the files on it rather than opening its file chooser (which would leave
  // the browser tools waiting on a chooser that's already been answered).
  const dropLike = await el.evaluate((n) => /drop|drag/i.test(`${n.className} ${n.id} ${n.textContent}`.slice(0, 500))).catch(() => false);
  if (dropLike) {
    await dropOn(page, el, files);
    return "drop zone";
  }
  // A caption next to its field ("Picture" beside "Choose File"): the one file field in the same
  // row, a few levels up.
  const near = await el.evaluateHandle((n) => {
    for (let up = n.parentElement, i = 0; up && i < 3; up = up.parentElement, i++) {
      const fields = up.querySelectorAll('input[type="file"]');
      if (fields.length === 1) return fields[0];
      if (fields.length > 1) return null;
    }
    return null;
  }).catch(() => null);
  const nearField = near?.asElement();
  if (nearField) {
    await nearField.setInputFiles(files, { timeout: 10000 });
    return "file field next to it";
  }
  // Never click a submit, publish, pay or delete button just to look for a file chooser.
  const final = finalActionStrict(await el.evaluate(buttonLabel).catch(() => ""));
  if (final) throw new Error(`the target looks like a final action ("${final.word}"); give the upload field or drop zone instead`);
  const chooser = page.waitForEvent("filechooser", { timeout: 2500 }).catch(() => null);
  await el.click({ timeout: 5000 }).catch(() => {});
  const fc = await chooser;
  if (fc) {
    await fc.setFiles(files, { timeout: 10000 });
    return "upload button";
  }
  await dropOn(page, el, files);
  return "drop zone";
}

// Drops real File objects on an element: the files go into a temporary hidden field first (the
// browser reads them from disk, nothing is copied through the page), then onto the zone.
async function dropOn(page, el, files) {
  const tmp = await page.evaluateHandle(() => {
    const i = document.createElement("input");
    i.type = "file";
    i.multiple = true;
    i.style.display = "none";
    i.setAttribute("data-pairbrowse-upload", "");
    document.body.appendChild(i);
    return i;
  });
  try {
    await tmp.asElement().setInputFiles(files, { timeout: 10000 });
    await el.evaluate((zone, input) => {
      const dt = new DataTransfer();
      for (const f of input.files) dt.items.add(f);
      for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, tmp);
  } finally {
    await tmp.evaluate((i) => i.remove()).catch(() => {});
  }
}

// Runs a pairbrowse_upload call. Returns { ok, text }.
export async function uploadFiles(page, { files = [], target } = {}, { uploadsDir, activity = () => {} } = {}) {
  const list = (Array.isArray(files) ? files : [files]).map(String);
  const problems = list.map((f) => uploadProblem(f, uploadsDir)).filter(Boolean);
  if (problems.length) return { ok: false, text: problems.join("\n") };
  try {
    const staged = await stage(list.map((f) => realpathSync(resolve(f))), uploadsDir);
    const el = await locate(page, target);
    const how = await deliver(page, el, staged);
    const names = list.map((f) => basename(f));
    activity(`Uploaded ${names.map((n) => `\`${n}\``).join(", ")}`);
    return { ok: true, text: `Uploaded ${names.join(", ")} through the ${how}. Take a snapshot to check the page accepted it (a preview, a file name, no size or format error).` };
  } catch (e) {
    return { ok: false, text: `Couldn't upload: ${String(e?.message || e).split("\n")[0]}` };
  }
}
