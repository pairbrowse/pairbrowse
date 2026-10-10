// How sharing gets its public address: `sharing.tunnel` in ~/.pairbrowse/config.json. The default
// is a Cloudflare Quick Tunnel (no account); the other kinds are the user's own: a named Cloudflare
// tunnel, ngrok, Tailscale Funnel, or any command that prints an https address. Every kind reaches
// only the live view's guest port. Credentials stay in config.json (mode 600) and go to the
// provider's own process alone; they never show in logs, results, the bar or the panel.
// This file has no side effects: it reads and checks the config, and masks secrets in text.

export const KINDS = ["quick", "cloudflare", "ngrok", "tailscale", "command"];
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const text = (v) => (typeof v === "string" ? v.trim() : "");
const plain = (where, what) => new Error(`${where} in config.json ${what}`);

// A host name as the provider shows it: no scheme, path or port.
function hostnameOf(value, where) {
  const h = text(value).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!HOSTNAME.test(h)) throw plain(where, `needs a host name like share.example.com (got ${JSON.stringify(text(value))})`);
  return h;
}

// The checked tunnel settings: { kind, stable, guestPort, ...kind's fields, secrets, describe(host) }.
// `stable`: the address is the same across restarts (join codes keep working); `secrets`: the
// strings to mask wherever output is read. Throws a plain, one-line message on a bad config.
export function tunnelConfig(config = {}) {
  const sharing = config?.sharing;
  if (sharing !== undefined && (sharing === null || typeof sharing !== "object" || Array.isArray(sharing))) throw plain("sharing", "must be an object: { \"tunnel\": { \"kind\": \"quick\" } }");
  const given = sharing?.tunnel;
  if (given !== undefined && (given === null || typeof given !== "object" || Array.isArray(given))) throw plain("sharing.tunnel", "must be an object with a kind: quick, cloudflare, ngrok, tailscale or command");
  const t = given || {};
  const kind = given === undefined || t.kind === undefined ? "quick" : t.kind;
  if (!KINDS.includes(kind)) throw plain("sharing.tunnel.kind", `${JSON.stringify(kind)} isn't one of quick, cloudflare, ngrok, tailscale or command`);
  const guestPort = sharing?.guestPort === undefined || sharing?.guestPort === null || sharing?.guestPort === 0 ? 0 : sharing.guestPort;
  if (guestPort !== 0 && !(Number.isInteger(guestPort) && guestPort > 0 && guestPort < 65536)) throw plain("sharing.guestPort", "must be a port number (1-65535), or 0 for any");

  const spec = { kind, guestPort, stable: false, secrets: [], describe: () => "a free relay" };
  if (kind === "quick") return spec;
  if (kind === "cloudflare") {
    const token = text(t.token);
    if (!token) throw plain("sharing.tunnel", "needs a token for kind cloudflare: the tunnel token from the Cloudflare dashboard");
    const hostname = hostnameOf(t.hostname, "sharing.tunnel.hostname");
    return { ...spec, token, hostname, stable: true, secrets: [token], describe: () => `your own Cloudflare tunnel ${hostname}` };
  }
  if (kind === "ngrok") {
    const authtoken = text(t.authtoken);
    if (!authtoken) throw plain("sharing.tunnel", "needs an authtoken for kind ngrok (from the ngrok dashboard)");
    const domain = t.domain === undefined || t.domain === null || text(t.domain) === "" ? "" : hostnameOf(t.domain, "sharing.tunnel.domain");
    return { ...spec, authtoken, domain, stable: !!domain, secrets: [authtoken], describe: (host) => `your own ngrok address ${domain || host || "(given when it starts)"}` };
  }
  if (kind === "tailscale") return { ...spec, stable: true, describe: (host) => `your Tailscale Funnel address${host ? ` ${host}` : ""}` };
  // command: the user's own program. Its env values are its credentials, so every one of them
  // is masked wherever its output is read (a plain word there would be masked too: fine).
  const run = text(t.run);
  if (!run) throw plain("sharing.tunnel", "needs run for kind command: the command to start, with {port} where the port goes");
  const argv = splitCommand(run);
  if (!argv.length) throw plain("sharing.tunnel.run", "is empty");
  const url = text(t.url);
  if (!url) throw plain("sharing.tunnel", "needs url for kind command: a regular expression with one capture group that finds the public https address in the command's output");
  let urlRegex;
  try { urlRegex = new RegExp(url); } catch { throw plain("sharing.tunnel.url", "isn't a valid regular expression"); }
  if (new RegExp(`${url}|`).exec("").length !== 2) throw plain("sharing.tunnel.url", "needs exactly one capture group (parentheses) around the https address");
  const env = t.env === undefined || t.env === null ? {} : t.env;
  if (typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) throw plain("sharing.tunnel.env", "must be an object of strings");
  const secrets = Object.values(env).filter((v) => v.length >= 8);
  return { ...spec, run, argv, urlRegex, env, stable: true, secrets, describe: (host) => `your own tunnel command (${argv[0].split(/[\\/]/).pop()}${host ? `, at ${host}` : ""})` };
}

// A command line split into words, the shell's way for the common cases (spaces, single and
// double quotes, backslash escapes); nothing is run through a shell.
export function splitCommand(line) {
  const out = [];
  let cur = null, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; cur ??= ""; }
    else if (c === "\\" && i + 1 < line.length) cur = (cur ?? "") + line[++i];
    else if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } }
    else cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// `s` with every secret replaced by "***" (longest first, so a token holding a shorter one goes whole).
export function maskSecrets(s, secrets = []) {
  let out = String(s ?? "");
  for (const secret of [...new Set(secrets.filter((x) => typeof x === "string" && x.length >= 4))].sort((a, b) => b.length - a.length)) out = out.split(secret).join("***");
  return out;
}
