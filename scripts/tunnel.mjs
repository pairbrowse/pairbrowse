// Cloudflare Quick Tunnels for sharing a session with someone on another computer: a temporary
// https://<words>.trycloudflare.com address that reaches only the live view's joiner port on this
// computer (never the owner's), with no Cloudflare account and no open ports (cloudflared connects
// out). That port still listens on 127.0.0.1 only and serves nothing without an approved join code.
// cloudflared itself is downloaded once from Cloudflare's GitHub releases, pinned by SHA-256.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Resolver, lookup } from "node:dns/promises";
import { existsSync, rmSync, renameSync, chmodSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { paths } from "./paths.mjs";
import { downloadPinned } from "./util.mjs";

const run = promisify(execFile);

// A new version is a deliberate change here, with the SHA-256s from its GitHub release.
export const CLOUDFLARED = {
  version: "2026.9.3",
  assets: {
    "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", sha256: "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095" },
    "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", sha256: "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977" },
    "linux-x64": { file: "cloudflared-linux-amd64", sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2" },
    "linux-arm64": { file: "cloudflared-linux-arm64", sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d" },
    "win32-x64": { file: "cloudflared-windows-amd64.exe", sha256: "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2" },
  },
};

// The cloudflared program for this computer: downloaded and checked once, then reused.
export async function ensureCloudflared(log = () => {}, platform = process.platform, arch = process.arch) {
  const asset = CLOUDFLARED.assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`sharing needs cloudflared, which has no build for ${platform}-${arch}`);
  const dir = join(paths.home, "tools", `cloudflared-${CLOUDFLARED.version}`);
  const exe = join(dir, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(exe)) return exe;
  const download = join(dir, asset.file);
  try {
    if (!existsSync(download)) log(`downloading cloudflared ${CLOUDFLARED.version} for sharing (about 20-55 MB, once)`);
    await downloadPinned(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED.version}/${asset.file}`, download, asset.sha256, { timeoutMs: 10 * 60_000 });
    if (asset.file.endsWith(".tgz")) {
      await run("tar", ["-xzf", download, "-C", dir]);
      if (!existsSync(exe)) throw new Error("the cloudflared archive has no cloudflared program");
    } else {
      renameSync(download, exe);
    }
    if (platform !== "win32") chmodSync(exe, 0o700);
    return exe;
  } catch (e) {
    rmSync(exe, { force: true });
    throw e;
  } finally {
    rmSync(download, { force: true });
  }
}

// The public address cloudflared prints once the Quick Tunnel is up.
export const tunnelUrl = (text) => String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] || null;

// Whether a new tunnel's name resolves yet, asked of Cloudflare's own resolver (the joiner's
// resolver must never ask too early: trycloudflare.com's "no such name" is cached for a minute).
async function resolvesAtCloudflare(host) {
  const r = new Resolver({ timeout: 2000, tries: 1 });
  r.setServers(["1.1.1.1", "1.0.0.1"]);
  try { return (await r.resolve4(host)).length > 0; } catch { return false; }
}

// Why cloudflared stopped, in plain words, from its last error line (its log, text). Cloudflare
// turns new Quick Tunnels away with a 429 (error 1015) when too many came from one place.
export function tunnelExitReason(code, text) {
  const lines = String(text || "").split("\n").filter((l) => /\bERR\b|error/i.test(l));
  const last = lines.at(-1)?.replace(/^.*?\b(ERR)\b\s*/, "").trim().slice(0, 200) || "";
  if (/\b429\b|\b1015\b|Too Many Requests/i.test(last)) return "Cloudflare is rate-limiting new tunnels from here; wait a few minutes and try again";
  return `the sharing tunnel stopped (exit ${code})${last ? `: ${last}` : ""}`;
}
// Whether the name resolves with this computer's own resolver (joiners' resolvers are much like
// it): a new name may take seconds more to reach it than Cloudflare's own.
const resolvesHere = async (host) => { try { await lookup(host); return true; } catch { return false; } };

// Starts a Quick Tunnel to http://127.0.0.1:<port>. Resolves { url, host, pid, stop, child } once
// it's reachable: cloudflared has registered a connection and the name resolves (or DNS_WAIT_MS
// went by). cloudflared runs under a keeper of its own (tunnel-keeper.mjs, pid), writing to a
// private file (logDir): it outlives a restart of the helper, whose next run takes it over
// (adoptTunnel), so joiners just reconnect to the same address; and it stops by itself when no
// helper has touched the heartbeat file (helperAlive) for KEEP_GRACE_MS. stop() ends it.
const DNS_WAIT_MS = 15_000;
const LOCAL_DNS_WAIT_MS = 10_000; // more, for the system resolver to see the name too
export const KEEP_GRACE_MS = Number(process.env.PAIRBROWSE_TEST_KEEP_GRACE_MS) || 120_000;
const KEEPER = join(dirname(fileURLToPath(import.meta.url)), "tunnel-keeper.mjs");
export const heartbeatFile = () => join(paths.home, "run", "helper-alive");
// The helper is here (sharing.mjs touches it every few seconds).
export function helperAlive() {
  try { mkdirSync(join(paths.home, "run"), { recursive: true, mode: 0o700 }); writeFileSync(heartbeatFile(), String(Date.now()), { mode: 0o600 }); } catch {}
}
export async function startQuickTunnel(port, { log = () => {}, timeoutMs = 60_000, exe, resolves = resolvesAtCloudflare, resolvesLocally = resolvesHere, logDir = join(paths.home, "tunnels") } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad live view port");
  const program = exe || await ensureCloudflared(log);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = join(logDir, `${port}-${randomBytes(4).toString("hex")}.log`);
  const fd = openSync(file, "a", 0o600);
  helperAlive();
  let child;
  try { child = spawn(process.execPath, [KEEPER, program, String(port), heartbeatFile(), String(KEEP_GRACE_MS)], { stdio: ["ignore", fd, fd], detached: process.platform !== "win32" }); } finally { closeSync(fd); }
  child.unref();
  const stop = () => { if (child.exitCode === null) { try { child.kill("SIGTERM"); } catch {} } rmSync(file, { force: true }); };
  try {
    const url = await new Promise((ok, no) => {
      let found = null;
      const timer = setTimeout(() => { clearInterval(poll); no(new Error("the sharing tunnel didn't start in time")); }, timeoutMs);
      const poll = setInterval(() => {
        let seen = "";
        try { seen = readFileSync(file, "utf8").slice(-16000); } catch {}
        found ||= tunnelUrl(seen);
        if (found && /Registered tunnel connection/.test(seen)) { clearTimeout(timer); clearInterval(poll); ok(found); }
      }, 150);
      child.once("error", (e) => { clearTimeout(timer); clearInterval(poll); no(e); });
      child.once("exit", (code) => {
        clearTimeout(timer); clearInterval(poll);
        let seen = "";
        try { seen = readFileSync(file, "utf8").slice(-16000); } catch {}
        no(new Error(tunnelExitReason(code, seen)));
      });
    });
    for (const end = Date.now() + DNS_WAIT_MS; !(await resolves(new URL(url).host)) && Date.now() < end;) await new Promise((r) => setTimeout(r, 500));
    // The code goes out only once this computer's resolver sees the name too: a joiner asking
    // too early gets "no such name", cached for a minute.
    for (const end = Date.now() + LOCAL_DNS_WAIT_MS; !(await resolvesLocally(new URL(url).host)) && Date.now() < end;) await new Promise((r) => setTimeout(r, 500));
    log(`sharing tunnel up: ${new URL(url).host}`);
    return { url, host: new URL(url).host, pid: child.pid, log: file, stop, child };
  } catch (e) {
    stop();
    throw e;
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const defaultPs = async (pid) => (await run("ps", ["-p", String(pid), "-o", "command="])).stdout;
// Whether pid is still a tunnel keeper of ours for this port (a pid can be reused by anything).
async function isKeeper(pid, port, psCommand = defaultPs) {
  if (!pidAlive(pid)) return false;
  let command;
  try { command = String(await psCommand(pid)); } catch { return false; }
  const m = command.match(/tunnel-keeper\.mjs \S*cloudflared\S* (\d+) /);
  return !!m && Number(m[1]) === port;
}

// A tunnel a previous run of the helper started (its saved { url, pid, port, log }), taken over
// if it is still that: our keeper of a cloudflared to this very port. Anything else: null.
// Before any signal it's checked again, so a reused pid is never stopped by mistake.
export async function adoptTunnel(saved, { psCommand = defaultPs } = {}) {
  if (process.platform === "win32" || !saved) return null;
  const { url, pid, port } = saved;
  if (tunnelUrl(url) !== url || !Number.isInteger(pid) || pid < 2 || !Number.isInteger(port)) return null;
  if (!(await isKeeper(pid, port, psCommand))) return null;
  const file = typeof saved.log === "string" && saved.log.startsWith(join(paths.home, "tunnels")) ? saved.log : null;
  const t = { url, host: new URL(url).host, pid, port, log: file, child: null, adopted: true, gone: false };
  t.check = () => isKeeper(pid, port, psCommand);
  t.stop = () => {
    if (t.gone) return;
    t.gone = true;
    if (file) rmSync(file, { force: true });
    t.check().then((ours) => { if (ours) { try { process.kill(pid, "SIGTERM"); } catch {} } }, () => {});
  };
  return t;
}

// fn() once the tunnel's cloudflared has ended: its exit, or (taken over) its process gone.
export function onTunnelExit(t, fn, everyMs = 2000) {
  if (t.child) return t.child.once("exit", fn);
  const timer = setInterval(async () => { if (t.gone || !(await (t.check ? t.check() : pidAlive(t.pid)))) { clearInterval(timer); t.gone = true; fn(); } }, everyMs);
  timer.unref?.();
}

// Keeps an eye on a running tunnel from the outside: a request to its public address every
// everyMs. Any answer from this computer's server (below 500, a 429 included: busy, not down)
// counts as up; Cloudflare's own errors (502, 530: the tunnel lost its connection) or no answer
// count as down. After `misses` downs in a row the tunnel is stopped, and the code that started
// it replaces it (its exit handler). Returns stop().
export function watchTunnel(t, { everyMs = 30_000, misses = 2, timeoutMs = 10_000, log = () => {}, probe } = {}) {
  let down = 0;
  const check = probe || (async () => {
    try { return (await fetch(t.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })).status < 500; } catch { return false; }
  });
  const timer = setInterval(async () => {
    if ((t.child?.exitCode ?? null) !== null || t.gone) return clearInterval(timer);
    if (await check()) { down = 0; return; }
    if (++down < misses) return;
    clearInterval(timer);
    log(`tunnel ${t.host} isn't answering; replacing it`);
    try { t.stop(); } catch {}
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
