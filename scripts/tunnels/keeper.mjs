// Keeps one Quick Tunnel (tunnels/quick.mjs) for as long as a PairBrowse helper is around: it runs
// cloudflared, and stops it when the helper's heartbeat file (touched every few seconds while a
// helper runs) has been still for the grace period. A restart of the helper (an update, a crash
// it comes back from) takes seconds, so join codes outlive it; a helper that doesn't come back
// leaves no public address forwarding to a port anyone on this computer could then take.
// Runs as its own process from the fixed entry scripts/tunnel-keeper.mjs, the name adoptTunnel
// knows keepers by.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

// args: [cloudflared, port, heartbeat file, grace ms]
export function runKeeper([exe, port, alive, graceArg]) {
  const grace = Number(graceArg) || 120_000;
  const child = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${Number(port)}`], { stdio: "inherit" });
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(0); }, 3000).unref();
  };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
  process.on("SIGHUP", () => {}); // a closed terminal isn't the helper going away
  child.on("error", () => process.exit(1));
  child.on("exit", (code) => process.exit(code ?? 0));
  setInterval(() => {
    let at = 0;
    try { at = statSync(alive).mtimeMs; } catch {}
    if (Date.now() - at > grace) end();
  }, 5000);
}
