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
  const gone = heartbeatWatch({ grace, touched: () => { try { return statSync(alive).mtimeMs; } catch { return 0; } } });
  setInterval(() => { if (gone()) end(); }, 5000);
}

// Whether the helper is gone: its heartbeat file hasn't been touched for grace ms. Measured on a
// clock that never jumps (mono): the file's time is only compared with its own last value, so a
// wall clock set forward doesn't end a tunnel whose helper is fine, nor one set back keep a
// tunnel whose helper is gone. A heartbeat already stale (or missing) when the keeper starts
// counts as last touched then. touched(): the file's time (0: none).
export function heartbeatWatch({ grace, touched, mono = () => performance.now() }) {
  let last = touched();
  let since = mono();
  return () => {
    const at = touched();
    if (at !== last) { last = at; if (at) since = mono(); }
    return mono() - since > grace;
  };
}
