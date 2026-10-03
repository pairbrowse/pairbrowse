// Cloudflare Quick Tunnels for sharing a session with someone on another computer: a temporary
// https://<words>.trycloudflare.com address that reaches only the live view's joiner port on this
// computer (never the owner's), with no Cloudflare account and no open ports (cloudflared connects
// out). That port still listens on 127.0.0.1 only and serves nothing without an approved join code.
// cloudflared itself is downloaded once from Cloudflare's GitHub releases, pinned by SHA-256.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
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

// Starts a Quick Tunnel to http://127.0.0.1:<port>. Resolves { url, stop } once it's reachable.
export async function startQuickTunnel(port, { log = () => {}, timeoutMs = 60_000, exe } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad live view port");
  const program = exe || await ensureCloudflared(log);
  const child = spawn(program, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  try {
    const url = await new Promise((ok, no) => {
      let seen = "";
      const timer = setTimeout(() => no(new Error("the sharing tunnel didn't start in time")), timeoutMs);
      const read = (chunk) => {
        seen = (seen + chunk).slice(-8000);
        const found = tunnelUrl(seen);
        if (found) { clearTimeout(timer); ok(found); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", (e) => { clearTimeout(timer); no(e); });
      child.once("exit", (code) => { clearTimeout(timer); no(new Error(`the sharing tunnel stopped (exit ${code})`)); });
    });
    child.stdout.resume();
    child.stderr.resume();
    log(`sharing tunnel up: ${new URL(url).host}`);
    return { url, host: new URL(url).host, stop, child };
  } catch (e) {
    stop();
    throw e;
  }
}
