// A session's network at each launch (spec server-mode C4, C5; section 3.2 step 3): which proxy it
// uses (config.json's `network`, read from the file each time: net/config.mjs), the driver's proxy
// option with this computer's own addresses always around it, the strict switches, and for a proxy
// with a username and password the owner-only auth file the browser reads them from (C1). A
// session whose network can't be used is refused with one sentence, never launched direct instead.
// The egress checks after the launch (checkAtLaunch, C6, C7) come next to this.
//
// deps: log; configFile, secretsFile, runDir (paths.mjs's, tests pass their own).
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths } from "../paths.mjs";
import { loadSecrets } from "../rules/secrets.mjs";
import { readNetwork, networkFor, launchPart, applyLaunchPart, sessionRefusal, PROXY_AUTH_SWITCH } from "../net/config.mjs";

// The auth file's name under ~/.pairbrowse/run: a fresh one each launch, like the pages' key file.
export const PROXY_AUTH_PREFIX = "proxy-auth-";

// The auth file (engine contract, patch 962): one line of JSON, this account's only (0600, in the
// 0700 run folder), a fresh name. Files a killed helper left behind go first: one helper per home,
// and the previous browser is closed when a launch starts. Not writeJsonAtomic: nothing reads this
// file while it is written (the browser it is named to starts after), and a rename gains nothing for
// a new owner-only file that `wx` already refuses to open over anything there.
export function writeProxyAuthFile(content, dir = paths.run) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(dir)) if (f.startsWith(PROXY_AUTH_PREFIX)) rmSync(join(dir, f), { force: true });
  const path = join(dir, PROXY_AUTH_PREFIX + randomBytes(16).toString("hex"));
  const line = `${JSON.stringify({ server: content.server, username: content.username, password: content.password })}\n`;
  writeFileSync(path, line, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600); // a umask can strip owner bits
  return path;
}
export function dropProxyAuthFile(path) {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* gone or unreachable: nothing to do */ }
}

export function createNetwork({ log = () => {}, configFile = paths.config, secretsFile = paths.secrets, runDir = paths.run } = {}) {
  let last = null; // the network of the browser started last: { session, id, source, strict } (no address)

  // The launch's network for `session` (profileNetwork: its browser profile's network id, Phase D;
  // shell: the browser's, browser/choice.mjs; native: a native build, which reads strict mode's
  // WebRTC switch in its own spelling). Throws the refusal sentence; else { id, source,
  // strict, proxy, apply(options), drop(), started() }: apply adds the proxy and switches to the
  // launch options (the user's --host-resolver-rules dropped and logged where the helper sets its
  // own), drop removes the auth file (once the browser is up, or its launch failed), started records
  // this network as the running browser's (called once the browser is up). A launch attempt clears
  // the record first: one refused or failed leaves none. Nothing it logs names an address or a
  // credential.
  function forLaunch(session, { profileNetwork, shell = null, native = false } = {}) {
    last = null;
    const read = readNetwork(configFile);
    if (read.problem) throw new Error(sessionRefusal(session, read.problem));
    const net = networkFor({ network: read.network }, session, { profileNetwork });
    // Secrets are read from the file only for a proxy that needs them (and fresh: one set while
    // the helper runs counts at the next launch).
    const secrets = net.proxy?.auth && shell?.proxyAuthFile ? loadSecrets(secretsFile) : null;
    const part = launchPart(net, { shell, secrets, native });
    if (part.problem) throw new Error(part.problem);
    let authPath = null;
    if (part.authFile) {
      try { authPath = writeProxyAuthFile(part.authFile, runDir); } catch (e) {
        throw new Error(sessionRefusal(session, `the proxy's auth file couldn't be written (${e?.code || "error"})`));
      }
    }
    const record = { session, id: net.id, source: net.source, strict: !!net.proxy && net.strict };
    const args = authPath ? [...part.args, `${PROXY_AUTH_SWITCH}=${authPath}`] : part.args;
    if (net.proxy) log(`launch: network "${net.id}" (${net.source}${net.strict ? ", strict" : ""}${authPath ? ", auth file" : ""})`);
    return {
      id: net.id, source: net.source, strict: record.strict, proxy: part.proxy,
      apply(options) {
        const { options: out, dropped } = applyLaunchPart(options, { ...part, args });
        if (dropped.length) log(`launch: ${dropped.join(", ")} in browserArgs dropped: a proxied session looks names up only through its proxy`);
        return out;
      },
      drop: () => { dropProxyAuthFile(authPath); authPath = null; },
      started: () => { last = record; },
    };
  }

  return {
    forLaunch,
    // The network of the browser started last ({ session, id, source, strict }), or null before
    // any, and from the start of a launch until that browser is up.
    current: () => last,
    // Whether the browser started last is a strict proxied session (C11 reads it).
    strict: () => !!last?.strict,
  };
}
