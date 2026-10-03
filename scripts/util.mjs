// Small helpers shared by the helper, the hooks and the install steps (Node's standard library only).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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

// `promise`, or a rejection with `message` once `ms` have passed.
export function withTimeout(promise, ms, message = `timed out after ${ms} ms`) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}
