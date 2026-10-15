// A joiner's own agent at work in the host's browser, from the live view's side: its MCP lines
// and files go to daemon/remote-agents.mjs, its answers go back on the joiner's channel and are
// kept a while for a channel that reconnects. State: the outbox, one list per joiner.
// push: the joiner channel (createPush). remoteAgents: daemon/remote-agents.mjs, or null where
// shared browser mode isn't available. idOf(page), crossesWhole(page), personTab(page),
// joinerKey(j): the live view's.
export function createAgentRelay({ push, remoteAgents, getContext, idOf, crossesWhole, personTab, joinerKey }) {
  // A joiner's agent's answers, kept for a while: their channel can drop and reconnect (a busy
  // computer, the tunnel), and an answer sent just then would be lost, leaving their agent waiting
  // for it. Each goes again when a channel opens; their side takes each answer once.
  const AGENT_KEEP_MS = 120_000;
  const agentOutbox = new Map(); // joiner key -> [{ msg, t }]
  function toJoinerAgent(key, msg) {
    const now = Date.now();
    const list = (agentOutbox.get(key) || []).filter((x) => now - x.t < AGENT_KEEP_MS).slice(-49);
    list.push({ msg, t: now });
    agentOutbox.set(key, list);
    push.broadcast("agent", msg, { to: key });
  }
  function resend(key) {
    const now = Date.now();
    const list = (agentOutbox.get(key) || []).filter((x) => now - x.t < AGENT_KEEP_MS);
    if (!list.length) { agentOutbox.delete(key); return; }
    agentOutbox.set(key, list);
    for (const { msg } of list) push.broadcast("agent", msg, { to: key });
  }

  // A joiner's own agent at work in this browser (daemon/remote-agents.mjs): its MCP messages,
  // its answers back on the channel; files it sends over for an upload.
  async function remoteAgent(body, j) {
    if (!remoteAgents) return { problem: "Shared browser mode isn't available here. Ask the host for a shared browser invite." };
    if (j.invite.role !== "drive") return { problem: "This code is for watching only: your agent can't act in the host's browser. Ask the host for one that can drive." };
    const key = joinerKey(j);
    // The tab they look at: only one whose picture goes to joiners.
    const start = typeof body?.tab === "string" ? (await getContext()).pages().find((p) => idOf(p) === body.tab && crossesWhole(p) && !personTab(p)) || null : null;
    const ok = remoteAgents.line({ name: j.name, app: j.app, key }, String(body?.a || ""), body?.line, (line) => toJoinerAgent(key, { a: String(body.a), line }), start);
    return ok ? { ok: true } : { problem: "Bad message." };
  }
  function remoteFile(body, j) {
    if (!remoteAgents) return { problem: "Shared browser mode isn't available here. Ask the host for a shared browser invite." };
    if (j.invite.role !== "drive") return { problem: "This code is for watching only. Ask the host for one that can drive." };
    return remoteAgents.file({ key: joinerKey(j) }, body);
  }
  // A joiner gone: their kept answers with them.
  const forget = (key) => { agentOutbox.delete(key); };
  return { remoteAgent, remoteFile, resend, forget };
}
