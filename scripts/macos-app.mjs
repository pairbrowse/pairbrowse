// The PairBrowse look of a macOS browser app: its name in Chromium's interface text, its icon and
// logo, and the ad-hoc signatures and Launch Services registration that go with changing them. Used
// for both macOS builds: the branded ungoogled-chromium copy (browser.mjs) and the native build
// (native-install.mjs).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { sha256 } from "./util.mjs";

const run = promisify(execFile);
const BROWSER_DIR = join(dirname(fileURLToPath(import.meta.url)), "browser");
export const ICON = join(BROWSER_DIR, "pairbrowse.icns");
// The flat app icon, where the browser draws its own small logo (the web UI's product icon).
const PRODUCT_ICON = join(BROWSER_DIR, "product-icon.svg");
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const NOTIFICATION_HELPERS = ["Chromium Helper (Alerts).app", "Chromium Helper (Aperitif Alerts).app"];
const frameworkOf = (app) => join(app, "Contents", "Frameworks", "Chromium Framework.framework");

// Make macOS read the app's name and icon now (it caches them per path, also for notifications).
export const registerApp = (app) => run(LSREGISTER, ["-f", "-R", app]).catch(() => {});

export async function verifySignature(app) {
  await run("codesign", ["--verify", "--deep", "--strict", app], { timeout: 300_000 })
    .catch((e) => { throw new Error(`the app's signature doesn't verify: ${(e.stderr || e.message).trim()}`); });
}

// A fresh ad-hoc signature that keeps the part's entitlements and flags, and its identifier unless
// a new one is given (a renamed bundle ID must be signed under that ID).
const resign = (target, identifier) => run("codesign", ["--force", "--sign", "-",
  ...(identifier ? ["--identifier", identifier, "--preserve-metadata=entitlements,flags"] : ["--preserve-metadata=identifier,entitlements,flags"]), target], { timeout: 300_000 });

const readPlist = async (file) => JSON.parse((await run("plutil", ["-convert", "json", "-o", "-", file])).stdout);
const setString = (file, key, value) => run("plutil", ["-replace", key, "-string", value, file]);

// The name macOS shows in the notification permission prompt and in Notifications settings comes
// from the notification helper, and from its localized InfoPlist.strings before its Info.plist:
// Chromium ships base.lproj with "Chromium", and with no English one macOS falls back to it. So
// both, in every language folder, say PairBrowse, and Chromium's lookup ID (the app's ID plus
// ".framework.AlertNotificationService") stays matched. Returns the new bundle ID when it changed,
// true for other changes, false when the helper was already branded.
async function brandNotificationHelper(helper, appId) {
  const plist = join(helper, "Contents", "Info.plist");
  const info = await readPlist(plist);
  let changed = false;
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    if (info[key] !== "PairBrowse") { await setString(plist, key, "PairBrowse"); changed = true; }
  }
  if (info.CFBundleIconName !== undefined) { await run("plutil", ["-remove", "CFBundleIconName", plist]); changed = true; }
  const id = `${appId}.framework.AlertNotificationService`;
  const idChanged = info.CFBundleIdentifier !== id;
  if (idChanged) await setString(plist, "CFBundleIdentifier", id);
  const resources = join(helper, "Contents", "Resources");
  mkdirSync(join(resources, "en.lproj"), { recursive: true });
  const english = join(resources, "en.lproj", "InfoPlist.strings");
  try { writeFileSync(english, '"CFBundleDisplayName" = "PairBrowse";\n"CFBundleName" = "PairBrowse";\n', { flag: "wx" }); changed = true; } catch {} // wx: only when it isn't there
  for (const folder of readdirSync(resources).filter((name) => name.endsWith(".lproj"))) {
    const strings = join(resources, folder, "InfoPlist.strings");
    if (!existsSync(strings)) continue;
    const names = await readPlist(strings).catch(() => ({}));
    if (names.CFBundleDisplayName === "PairBrowse" && names.CFBundleName === "PairBrowse") continue;
    // Written whole: plutil can't edit the text (OpenStep) form these files may come in.
    writeFileSync(strings, JSON.stringify({ ...names, CFBundleDisplayName: "PairBrowse", CFBundleName: "PairBrowse" }));
    await run("plutil", ["-convert", "binary1", strings]);
    changed = true;
  }
  return idChanged ? id : changed;
}

// Chromium's resource packs (.pak, format version 5): a header, a table of resource ids and
// offsets, aliases, then the resources. Writes the pack again with each resource that
// `change(resource, id)` returns a Buffer for replaced; the rest are copied byte for byte. null for
// another format.
function rewritePak(buf, change) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== 5) return null;
  const count = buf.readUInt16LE(8);
  const aliases = buf.readUInt16LE(10);
  const tableStart = 12;
  const dataStart = tableStart + (count + 1) * 6 + aliases * 4;
  const offsets = [];
  for (let i = 0; i <= count; i++) offsets.push({ id: buf.readUInt16LE(tableStart + i * 6), at: buf.readUInt32LE(tableStart + i * 6 + 2) });
  const parts = [];
  for (let i = 0; i < count; i++) {
    const resource = buf.subarray(offsets[i].at, offsets[i + 1].at);
    parts.push(change(resource, offsets[i].id) || resource);
  }
  const out = Buffer.alloc(dataStart + parts.reduce((n, p) => n + p.length, 0));
  buf.copy(out, 0, 0, dataStart); // header and aliases are unchanged
  let at = dataStart;
  for (let i = 0; i <= count; i++) {
    out.writeUInt16LE(offsets[i].id, tableStart + i * 6);
    out.writeUInt32LE(at, tableStart + i * 6 + 2);
    if (i < count) { parts[i].copy(out, at); at += parts[i].length; }
  }
  return out;
}

// Chromium's interface text ("About Chromium", "Customize Chromium", settings pages) lives in UTF-8
// locale.pak files. The product is PairBrowse; Chromium keeps its credit: its copyright strings
// (`attribution`, resource ids found in the English pack) and the link to the Chromium project.
// A pack branded before that rule is put right again.
const PROJECT_LINK = />(?:Chromium|PairBrowse)<\/a>/;
function brandText(text, attribution) {
  if (attribution) return text.replaceAll("PairBrowse", "Chromium");
  return text.split(new RegExp(`(${PROJECT_LINK.source})`)).map((part, i) => (i % 2 ? ">Chromium</a>" : part.replaceAll("Chromium", "PairBrowse"))).join("");
}

// The ids of the copyright strings, from the English pack ("Copyright ... The Chromium Authors").
export function attributionIds(englishPak) {
  const ids = new Set();
  rewritePak(englishPak, (text, id) => { if (/\b(Chromium|PairBrowse) Authors\b/.test(text.toString("utf8"))) ids.add(id); return null; });
  return ids;
}

// One locale.pak, rebranded. null for another format.
export function rebrandPak(buf, attribution = new Set()) {
  if (buf.length < 5 || buf[4] !== 1) return null; // UTF-8 packs only
  return rewritePak(buf, (resource, id) => {
    if (!resource.includes("Chromium") && !resource.includes("PairBrowse")) return null;
    const before = resource.toString("utf8");
    const after = brandText(before, attribution.has(id));
    return after === before ? null : Buffer.from(after, "utf8");
  });
}

// Rebrands every locale.pak inside an app's Chromium framework. Returns whether any changed.
export async function rebrandInterfaceText(app) {
  const { stdout } = await run("find", [frameworkOf(app), "-name", "locale.pak"], { maxBuffer: 4 << 20 }).catch(() => ({ stdout: "" }));
  const files = stdout.trim().split("\n").filter(Boolean);
  const english = files.find((f) => /[/\\]en(\.lproj|-US)?[/\\]locale\.pak$/.test(f) || /[/\\]en-US\.pak$/.test(f));
  const attribution = english ? attributionIds(readFileSync(english)) : new Set();
  let changed = false;
  for (const file of files) {
    const before = readFileSync(file);
    const after = rebrandPak(before, attribution);
    if (after && !after.equals(before)) { writeFileSync(file, after); changed = true; }
  }
  return changed;
}

// Chromium's product logo images in this Chromium version (16 to 256 px, both scales), by SHA-256.
const CHROMIUM_LOGOS = new Set([
  "32ea0cf8a4f67b8fde3225391201f72bb4ef117295b104961c68d0502a7142d8", "a393eac540413ebbc51ba033b96d6f87918d1039f1ec16cd8c0e6a57818f2ea1",
  "7a431699c78af352352932f6dd4e04848b57990c0a5675a66695e1dd454cb592", "9fef85f58e6e4a2cdcbe8b0d3d8fe833547362ab1501ab700d745876fd830f4e",
  "c29f2c754d619246062db49e4ba1c3b8e96fcce18ec4524f5ef371172af385ad", "926700351f770f2ae5d1298c75aa269da1416d1511e90a1eed07a5ac5e27e85e",
  "aa7f129dcfe02276ebd365781c6a0c3c8ab1ca41abf3408ca47e604e7fe12018", "ea2d5a7c15ae1e03138d2bb227d3ed4684808c7de10a1443d776cde3ca3dcd9d",
  "e14120fdefb8eb455f44eac572f34bda75c32c9404e5c3745d44793dae217331",
]);
// The web UI's product icon (Settings' "About" entry), in the gzipped web UI files.
const CHROMIUM_ICON_START = '<g id="chrome-product" viewBox="0 -960 960 960">';
const CHROMIUM_ICON = /<g id="chrome-product" viewBox="0 -960 960 960">[\s\S]*?<\/g>/g;
const isPng = (buf) => buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
const isChromiumLogo = (buf) => isPng(buf) && CHROMIUM_LOGOS.has(sha256(buf));

// PairBrowse's icon as PNGs, rendered from the .icns at each size asked for.
async function iconRenderer() {
  const dir = await mkdtemp(join(tmpdir(), "pairbrowse-icon-"));
  await run("iconutil", ["-c", "iconset", "-o", join(dir, "pb.iconset"), ICON]);
  const source = join(dir, "pb.iconset", "icon_512x512@2x.png");
  const rendered = new Map();
  return {
    async png(size) {
      if (!rendered.has(size)) {
        const out = join(dir, `${size}.png`);
        await run("sips", ["-z", String(size), String(size), source, "--out", out]);
        rendered.set(size, readFileSync(out));
      }
      return rendered.get(size);
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

// The product icon for the web UI's icon set: the flat app icon's shapes.
function productIconGroup() {
  let svg = readFileSync(PRODUCT_ICON, "utf8");
  for (let before; before !== svg;) { before = svg; svg = svg.replace(/<!--[\s\S]*?-->/g, ""); } // until none are left
  const shapes = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1].trim();
  return `<g id="chrome-product" viewBox="100 100 824 824">${shapes.replace(/\s*\n\s*/g, "")}</g>`;
}

// Swaps Chromium's logo for PairBrowse's in the framework's resources: the logo images (in the
// resource packs and as loose files, each at its own pixel size) and the web UI's product icon.
// Returns whether anything changed.
export async function rebrandLogos(app) {
  const resources = join(frameworkOf(app), "Resources");
  if (!existsSync(resources)) return false;
  const icon = await iconRenderer();
  const productIcon = productIconGroup();
  let changed = false;
  try {
    for (const name of readdirSync(resources)) {
      const file = join(resources, name);
      if (/^product_logo_\d+\.png$/.test(name)) {
        const data = readFileSync(file);
        if (isChromiumLogo(data)) { writeFileSync(file, await icon.png(data.readUInt32BE(16))); changed = true; }
        continue;
      }
      if (!name.endsWith(".pak")) continue;
      const before = readFileSync(file);
      // Render the sizes this pack needs first: the rewrite itself runs synchronously.
      const logos = new Map();
      rewritePak(before, (resource) => { if (isChromiumLogo(resource)) logos.set(sha256(resource), resource.readUInt32BE(16)); return null; });
      for (const [hash, width] of logos) logos.set(hash, await icon.png(width));
      const after = rewritePak(before, (resource) => {
        if (isPng(resource)) return logos.get(sha256(resource)) || null;
        if (!isGzip(resource)) return null;
        const text = gunzipSync(resource).toString("utf8");
        return text.includes(CHROMIUM_ICON_START) ? gzipSync(text.replace(CHROMIUM_ICON, productIcon), { level: 9 }) : null;
      });
      if (after && !after.equals(before)) { writeFileSync(file, after); changed = true; }
    }
  } finally {
    await icon.close();
  }
  return changed;
}

// Bumped when brandNativeApp() learns something new: an installed build branded by an older
// version gets it again on the next start (when the browser isn't open).
export const BRANDING = 5;

// The PairBrowse name and icon in a native build (package.py sets its bundle names already): the
// icon in the app and its notification helpers, the helpers' names (the notification prompt
// shows them), PairBrowse instead of Chromium in the interface
// text, in every language, and PairBrowse's logo instead of Chromium's in the browser's own pages.
// What changed gets fresh signatures, inside out. Returns whether anything changed.
export async function brandNativeApp(app, log = () => {}) {
  const plist = join(app, "Contents", "Info.plist");
  for (const [key, want] of [["CFBundleName", "PairBrowse"], ["CFBundleExecutable", "pairbrowse"]]) {
    const { stdout } = await run("plutil", ["-extract", key, "raw", plist]).catch(() => ({ stdout: "" }));
    if (stdout.trim() !== want) throw new Error(`the app's ${key} isn't ${want}: not a PairBrowse build`);
  }
  const appId = (await readPlist(plist)).CFBundleIdentifier;
  const icon = readFileSync(ICON);
  const versions = join(frameworkOf(app), "Versions");
  const icons = [join(app, "Contents", "Resources", "app.icns")];
  const helpers = [];
  for (const version of existsSync(versions) ? readdirSync(versions).filter((v) => v !== "Current") : []) {
    for (const helper of NOTIFICATION_HELPERS) {
      const bundle = join(versions, version, "Helpers", helper);
      if (!existsSync(join(bundle, "Contents", "Info.plist"))) continue;
      helpers.push(bundle);
      icons.push(join(bundle, "Contents", "Resources", "app.icns"));
    }
  }
  // Each changed helper, with its new bundle ID when that changed (signed under it).
  const helpersChanged = new Map();
  for (const helper of helpers) {
    const result = await brandNotificationHelper(helper, appId);
    if (result) helpersChanged.set(helper, typeof result === "string" ? result : undefined);
  }
  let appIconChanged = false;
  for (const file of icons) {
    if (existsSync(file) && readFileSync(file).equals(icon)) continue;
    copyFileSync(ICON, file);
    const bundle = dirname(dirname(dirname(file)));
    if (bundle === app) appIconChanged = true; else if (!helpersChanged.has(bundle)) helpersChanged.set(bundle, undefined);
  }
  const textChanged = await rebrandInterfaceText(app);
  const logosChanged = await rebrandLogos(app);
  if (!appIconChanged && !helpersChanged.size && !textChanged && !logosChanged) return false;
  log("adding the PairBrowse name and icon");
  for (const [helper, identifier] of helpersChanged) await resign(helper, identifier);
  if (helpersChanged.size || textChanged || logosChanged) await resign(frameworkOf(app));
  await resign(app);
  return true;
}
