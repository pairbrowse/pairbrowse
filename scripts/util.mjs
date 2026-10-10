// Small helpers shared by the helper, the hooks and the install steps (Node's standard library only).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A JSON file's contents, or `fallback` when it's missing or not valid JSON.
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

// Downloads url to dest only if the bytes match the pinned SHA-256. It goes through a .part file,
// so an interrupted or wrong download never looks finished. A matching dest is reused as it is.
export async function downloadPinned(url, dest, sha256Hex, { timeoutMs = 30 * 60_000 } = {}) {
  if (existsSync(dest) && (await sha256File(dest)) === sha256Hex) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`couldn't download ${basename(dest)} (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    if ((await sha256File(part)) !== sha256Hex) throw new Error(`the ${basename(dest)} download doesn't match its pinned SHA-256`);
    renameSync(part, dest);
    return dest;
  } finally {
    rmSync(part, { force: true });
  }
}

// `promise`'s value, or null once `ms` have passed (for checks that give up quietly).
export const within = (ms, promise) => Promise.race([promise, sleep(ms).then(() => null)]);

// Until a page has loaded, at most maxMs, by asking it first: a page restored by Back (the
// browser's cache) fires no load event again, and Playwright's waitForLoadState("load") then
// waits its whole bound for one. Right after a move the old document may be gone and the new
// one not yet answering (no answer within probeMs): then a short wait for domcontentloaded and a
// second ask, and only a page that says it's still loading waits for the load event.
export async function pageLoaded(page, { maxMs = 4000, probeMs = 400, dclMs = 1000 } = {}) {
  const ask = () => within(probeMs, page.evaluate(() => document.readyState).catch(() => "")).catch(() => "");
  let ready = await ask();
  if (ready === "complete") return;
  if (!ready) {
    await within(dclMs, page.waitForLoadState("domcontentloaded").catch(() => {}));
    ready = await ask();
    if (ready === "complete") return;
  }
  await within(maxMs, page.waitForLoadState("load").catch(() => {}));
}

// `promise`, or a rejection with `message` once `ms` have passed.
export function withTimeout(promise, ms, message = `timed out after ${ms} ms`) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

// This computer's account: its full name (macOS: id -F; Linux: the passwd GECOS field, from
// /etc/passwd or getent for directory accounts) and login. Tests pass their own lookups.
export function readAccount({ platform = process.platform, user = () => userInfo(), run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }), passwd = () => readFileSync("/etc/passwd", "utf8") } = {}) {
  let username = "";
  try { username = String(user().username || ""); } catch {}
  const attempt = (fn) => { try { return String(fn() || "").trim(); } catch { return ""; } };
  // GECOS: "Full Name,room,phone,..."; "&" stands for the login, capitalized.
  const gecos = (line) => {
    const f = String(line || "").split("\n")[0].split(":");
    return f.length >= 5 ? f[4].split(",")[0].replace(/&/g, username.charAt(0).toUpperCase() + username.slice(1)).trim() : "";
  };
  let fullName = "";
  if (platform === "darwin") fullName = attempt(() => run("id", ["-F"]));
  else if (platform !== "win32" && username) {
    fullName = gecos(attempt(passwd).split("\n").find((l) => l.startsWith(`${username}:`)))
      || gecos(attempt(() => run("getent", ["passwd", username])));
  }
  return { fullName, username };
}
// Read once: an account's name doesn't change while the helper runs, and id/getent cost a process.
let account = null;
export const currentAccount = () => (account ??= readAccount());
