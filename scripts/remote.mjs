// Remote mode: Claude Code on your computer, the browser on your server. One SSH connection
// carries Claude's commands and forwards the live view to the same port on your computer.
// Set "remote": "you@server" in ~/.pairbrowse/config.json on your computer, and run
// `node scripts/setup-server.mjs` once on the server. SSH must log in with a key (no prompts).
function posixQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function participantLabel(config, env) {
  const value = config.participantName ?? env.PAIRBROWSE_PARTICIPANT;
  if (value === undefined || value === null) return "";
  // Keep labels useful in terminal/UI output and safe to place in a shell assignment.
  return Array.from(String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, "")).slice(0, 60).join("");
}

function remoteHome(config) {
  if (config.remoteHome === undefined || config.remoteHome === null) return null;
  if (typeof config.remoteHome !== "string" || !config.remoteHome.startsWith("/")) {
    throw new Error('pairbrowse: "remoteHome" must be an absolute path');
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(config.remoteHome)) {
    throw new Error('pairbrowse: "remoteHome" cannot contain control characters');
  }
  return config.remoteHome;
}

// The live view port setup-server.mjs fixes on a server, so the SSH tunnel can forward it.
export const SERVER_LIVE_VIEW_PORT = 47290;

export function remoteCommand(config, env = process.env) {
  const port = Number(config.remoteLiveViewPort) || SERVER_LIVE_VIEW_PORT;
  const node = config.remoteNode || "node";
  const plugin = config.remotePluginPath || "~/.pairbrowse/plugin";
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/.test(String(config.remote))) throw new Error(`pairbrowse: "remote" should look like user@host, got ${config.remote}`);
  const home = remoteHome(config);
  const label = participantLabel(config, env);
  const assignments = ["PAIRBROWSE_ON_SERVER=1"];
  if (home !== null) assignments.push(`PAIRBROWSE_HOME=${posixQuote(home)}`);
  if (label) assignments.push(`PAIRBROWSE_PARTICIPANT=${posixQuote(label)}`);
  return {
    bin: env.PAIRBROWSE_SSH || "ssh",
    args: [
      "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=no",
      "-L", `${port}:127.0.0.1:${port}`,
      config.remote,
      `${assignments.join(" ")} ${node} ${plugin}/scripts/launch.mjs`,
    ],
  };
}
