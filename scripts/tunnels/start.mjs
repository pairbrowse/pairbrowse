// Runs the user's own tunnel (tunnels/config.mjs: cloudflare, ngrok, tailscale or command) to the
// live view's guest port, as a child of the helper, and reads its public https address from what
// it prints. The result has the shape sharing.mjs's pool knows from Quick Tunnels ({ url, host,
// pid, stop, child }), so watching and replacing work the same; `own: true` marks it as ours to
// restart, not to keep across a helper restart (a stable address comes back the same anyway).
// Credentials go to the process through its environment, never on its command line, and every
// line of its output is masked before it is logged or quoted.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ensureCloudflared } from "../tunnel.mjs";
import { maskSecrets } from "./config.mjs";

// The program `name` on PATH (tests pass their own PATH), or null.
export function findOnPath(name, { path = process.env.PATH || "", platform = process.platform } = {}) {
  if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : null;
  const names = platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of path.split(delimiter).filter(Boolean)) for (const n of names) { const p = join(dir, n); if (existsSync(p)) return p; }
  return null;
}

const NGROK_URL = /"url"\s*:\s*"(https:\/\/[^"\s]+)"|\burl=(https:\/\/\S+)/;
const TS_URL = /(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)\b/i;

// What to run for a kind, and how to read its output: { program, args, env, url(text), ready(text),
// refused(text), name }. program: the binary's name; url(): the public address in the output so
// far, or null; ready(): the tunnel takes requests (default: once the address is known).
export async function planFor(spec, port, { log = () => {}, path } = {}) {
  const missing = (name, how) => new Error(`${name} isn't installed${how ? ` (${how})` : ""}; install it and make sure it's on your PATH`);
  if (spec.kind === "cloudflare") {
    // PATH first; else the pinned download sharing uses for Quick Tunnels (as today).
    const program = findOnPath("cloudflared", { path }) || await ensureCloudflared(log).catch(() => null);
    if (!program) throw missing("cloudflared");
    return {
      name: "cloudflared", program, args: ["tunnel", "--no-autoupdate", "run"], env: { TUNNEL_TOKEN: spec.token },
      url: () => `https://${spec.hostname}`,
      // The address is the dashboard's; it works once cloudflared has a connection to the edge.
      ready: (text) => /Registered tunnel connection/.test(text),
      refused: (text) => /token/i.test(text) && /invalid|not valid|parse|unauthori|forbidden|refused|expired/i.test(text),
    };
  }
  if (spec.kind === "ngrok") {
    const program = findOnPath("ngrok", { path });
    if (!program) throw missing("ngrok");
    return {
      name: "ngrok", program, args: ["http", String(port), "--log=stdout", "--log-format=json", ...(spec.domain ? [`--domain=${spec.domain}`] : [])], env: { NGROK_AUTHTOKEN: spec.authtoken },
      url: (text) => { const m = text.match(NGROK_URL); return m ? m[1] || m[2] : null; },
      refused: (text) => /authentication failed|ERR_NGROK_1\d\d|authtoken.*(invalid|not valid)|invalid.*authtoken/i.test(text),
    };
  }
  if (spec.kind === "tailscale") {
    const program = findOnPath("tailscale", { path });
    if (!program) throw missing("tailscale", "Tailscale, with Funnel enabled for this computer");
    // Foreground: it prints "Available on the internet: https://<machine>.<tailnet>.ts.net/" and
    // keeps the funnel open until it ends, which is just how the pool restarts a tunnel.
    return {
      name: "tailscale", program, args: ["funnel", String(port)], env: {},
      url: (text) => text.match(TS_URL)?.[1]?.toLowerCase() || null,
      refused: (text) => /Funnel is not enabled|not allowed|not permitted|access denied|needs to be enabled/i.test(text),
    };
  }
  if (spec.kind === "command") {
    const [first, ...rest] = spec.argv.map((a) => a.replaceAll("{port}", String(port)));
    const program = findOnPath(first, { path });
    if (!program) throw missing(first);
    return {
      name: first.split(/[\\/]/).pop(), program, args: rest, env: spec.env,
      url: (text) => { const m = text.match(spec.urlRegex); return m?.[1] ? m[1] : null; },
      refused: () => false,
    };
  }
  throw new Error(`sharing.tunnel.kind ${JSON.stringify(spec.kind)} isn't one of cloudflare, ngrok, tailscale or command`);
}

// Why the process ended, in plain words, with any secret masked. The agent and the user read it.
export function ownExitReason(plan, code, text, secrets) {
  const seen = maskSecrets(text, secrets);
  if (plan.refused(seen)) return `${plan.name === "ngrok" ? "the authtoken" : plan.name === "tailscale" ? "Funnel" : "the token"} was refused${plan.name === "tailscale" ? " (enable Funnel for this computer in the tailnet's settings)" : " (check sharing.tunnel in config.json)"}`;
  const lines = seen.split("\n").map((l) => l.trim()).filter((l) => /\bERR\b|error|fatal|fail|denied|refused/i.test(l));
  const last = lines.at(-1)?.slice(0, 200) || "";
  return `${plan.name} ended (exit ${code})${last ? `: ${last}` : ""}`;
}

// Starts spec's tunnel to http://127.0.0.1:<port>. Resolves { url, host, pid, stop, child, own,
// kind } once the address is known and the tunnel takes requests, or rejects with a plain reason.
export async function startOwnTunnel(spec, port, { log = () => {}, timeoutMs = 60_000, path, plan: given } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad live view port");
  const plan = given || await planFor(spec, port, { log, path });
  const secrets = [...(spec.secrets || []), ...Object.values(plan.env || {})];
  const mask = (s) => maskSecrets(s, secrets);
  log(`sharing: starting ${mask([plan.name, ...plan.args].join(" "))}`);
  const child = spawn(plan.program, plan.args, { env: { ...process.env, ...plan.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let seen = "";
  const take = (chunk) => { seen = (seen + mask(chunk.toString())).slice(-16000); };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  // The helper going away takes its tunnel with it (a restart starts it again, on the same address).
  const onExit = () => { try { child.kill("SIGTERM"); } catch {} };
  process.once("exit", onExit);
  child.once("exit", () => process.removeListener("exit", onExit));
  const stop = () => { if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGTERM"); } catch {} } };
  try {
    const url = await new Promise((ok, no) => {
      // "close", not "exit": the last line it printed (the reason) is read only once its output ends.
      const done = (fn) => { clearTimeout(timer); clearInterval(poll); child.removeListener("close", exited); child.removeListener("error", errored); fn(); };
      const timer = setTimeout(() => done(() => no(new Error(`${plan.name} didn't give an address in time`))), timeoutMs);
      const poll = setInterval(() => {
        const found = plan.url(seen);
        if (found && (plan.ready ? plan.ready(seen) : true)) done(() => ok(found));
      }, 100);
      const errored = (e) => done(() => no(new Error(`${plan.name} couldn't start: ${e?.code === "ENOENT" ? "not found" : e?.message || e}`)));
      const exited = (code) => done(() => no(new Error(ownExitReason(plan, code, seen, secrets))));
      child.once("error", errored);
      child.once("close", exited);
    });
    let u;
    try { u = new URL(url); } catch { throw new Error(`${plan.name} printed an address that isn't a URL`); }
    if (u.protocol !== "https:") throw new Error(`${plan.name} gave ${u.protocol.replace(":", "")}, not an https address; joiners need https`);
    log(`sharing tunnel up: ${u.host} (${plan.name})`);
    return { url: u.origin, host: u.host, pid: child.pid, stop, child, own: true, kind: spec.kind, output: () => seen };
  } catch (e) {
    stop();
    throw e;
  }
}
