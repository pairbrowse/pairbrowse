// Shared browser mode: an agent here works in the host's browser as a participant there. Its
// calls go over the join channel; files it uploads are sent over first (checked as uploads are
// here), and the call names them by where they landed there.
// live: the session joined now (join/state.mjs newFollowState).
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { FAILOVER_MS } from "../../relay.mjs";
import { paths } from "../../paths.mjs";
import { sleep } from "../../util.mjs";
import { pathsIn, withPaths, uploadProblem } from "../../upload.mjs";
import { PICK_FILE_MAX } from "../../../ui/limits.js";
import { waitForLink, waitedLine } from "../linkwait.mjs";
import { AGENT_GONE } from "../remote-agents.mjs";

const AGENT_CALL_MS = 15 * 60_000; // a call there (a hand-off waits for a person) answers within this
const RECONNECT_WAIT_MS = 60_000; // a call while the link to the host is down waits this long for it
export const FILE_PART = 120_000; // bytes of a file per message to the host

export function createJoinAgents(live, { log }) {
  const agentState = new Map(); // participant -> { ready: Promise }
  const pendingCalls = new Map(); // `${agent}|${id}` -> resolve
  let callSeq = 0;
  function onAgent(data, cur) {
    if (live.cur !== cur || typeof data?.line !== "string") return;
    let m;
    try { m = JSON.parse(data.line); } catch { return; }
    if (m?.id === undefined || m.method) return; // their side's notifications: nothing for us
    const k = `${data.a}|${m.id}`;
    const done = pendingCalls.get(k);
    if (done) { pendingCalls.delete(k); done(m); }
  }
  // The host's tab the person here is looking at (its picture page is in sight), or "".
  // In sight now, else the one looked at last.
  const tabInSight = (cur) => {
    let best = "", at = 0;
    for (const [id, page] of cur.pages) {
      const sc = cur.screens.get(page);
      if (!sc) continue;
      if (!sc.hiddenSince) return id;
      if ((sc.seenAt || 0) > at) { at = sc.seenAt; best = id; }
    }
    return best;
  };
  function sendLine(cur, agent, msg, wait = true) {
    if (!wait) return cur.join.agent(agent, JSON.stringify(msg), tabInSight(cur)).then(() => null);
    return new Promise((resolve) => {
      const k = `${agent}|${msg.id}`;
      const timer = setTimeout(() => { pendingCalls.delete(k); resolve({ error: { code: -32000, message: "The host's browser didn't answer in time." } }); }, AGENT_CALL_MS);
      pendingCalls.set(k, (m) => { clearTimeout(timer); resolve(m); });
      cur.join.agent(agent, JSON.stringify(msg)).then((r) => { if (r?.error) { clearTimeout(timer); pendingCalls.delete(k); resolve({ error: { code: -32000, message: `The host's browser refused: ${r.error}` } }); } });
    });
  }
  async function sendFile(cur, path) {
    const problem = uploadProblem(path, paths.uploads);
    if (problem) throw new Error(problem);
    // Size and contents from one open file, so it can't be swapped between the check and the read.
    const fd = openSync(path, "r");
    let data;
    try {
      if (fstatSync(fd).size > PICK_FILE_MAX) throw new Error(`${path} is too large to send (50 MB at most).`);
      data = readFileSync(fd);
    } finally { closeSync(fd); }
    const token = randomBytes(8).toString("hex");
    const parts = Math.max(1, Math.ceil(data.length / FILE_PART));
    for (let part = 0; part < parts; part++) {
      const r = await cur.join.file({ token, name: path.split(/[\\/]/).pop(), part, data: data.subarray(part * FILE_PART, (part + 1) * FILE_PART).toString("base64"), last: part === parts - 1 });
      if (r?.error || r?.problem) throw new Error(r.error || r.problem);
      if (part === parts - 1) return r.path;
    }
  }
  async function remoteCall(participant, msg, { app }) {
    const cur = live.cur;
    if (!cur?.shared) return { error: { code: -32000, message: "Not in a shared browser session." } };
    // The connection to the host is moving to another address: the call waits for it (a few
    // seconds, as a rule) and then runs as usual; only a longer wait is mentioned in the result.
    const waited = await waitForLink(() => cur.join.switching, { max: FAILOVER_MS + 10_000, isCurrent: () => live.cur === cur });
    if (waited > 300) log(`${msg.params?.name} waited ${waited} ms for the connection to the host's session`);
    // The link to the host is down for now: wait for it, up to RECONNECT_WAIT_MS in all.
    for (const end = Date.now() + Math.max(0, RECONNECT_WAIT_MS - waited); cur.join.phase !== "in" && live.cur === cur && Date.now() < end;) await sleep(500);
    const host = cur.join.host || "the host";
    if (live.cur !== cur) return { result: { content: [{ type: "text", text: `${live.ended?.text || "The shared session ended."} Nothing was done in ${host}'s browser.` }], isError: true } };
    // The host may have ended the sharing while the tunnel was down: this side can't tell.
    if (cur.join.phase !== "in") return { result: { content: [{ type: "text", text: `Can't reach ${host}'s browser right now (${cur.join.message}): nothing was done. It reconnects by itself; try again in a minute, or if ${host} ended the sharing, pairbrowse_join leave makes the tabs here your own.` }], isError: true } };
    const agent = participant.slice(0, 16);
    let st = agentState.get(participant);
    if (!st || st.cur !== cur) {
      st = { cur, ready: sendLine(cur, agent, { jsonrpc: "2.0", id: `init-${++callSeq}`, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app || "agent", version: "1" } } })
        .then(() => sendLine(cur, agent, { jsonrpc: "2.0", method: "notifications/initialized" }, false)) };
      agentState.set(participant, st);
    }
    await st.ready;
    const name = msg.params?.name;
    let args = msg.params?.arguments || {};
    const paths = pathsIn(name, args);
    if (paths.length) {
      const map = new Map();
      try { for (const p of paths) map.set(p, await sendFile(cur, p)); } catch (e) { return { result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true } }; }
      args = withPaths(name, args, map);
    }
    const out = await sendLine(cur, agent, { jsonrpc: "2.0", id: `c-${++callSeq}`, method: "tools/call", params: { ...msg.params, arguments: args } });
    const { id: _id, ...rest } = out || {};
    const line = waitedLine(waited, `the connection to ${host}'s session`);
    if (line && Array.isArray(rest.result?.content)) rest.result.content.push({ type: "text", text: `\n### PairBrowse\n- ${line}` });
    return rest.result || rest.error ? rest : { error: { code: -32000, message: "No answer from the host's browser." } };
  }

  // An agent here disconnected: the participant it had in the host's browser goes too.
  function agentGone(participant) {
    const st = agentState.get(participant);
    if (!st) return;
    agentState.delete(participant);
    if (live.cur === st.cur && live.cur.join.phase === "in") live.cur.join.agent(participant.slice(0, 16), JSON.stringify({ jsonrpc: "2.0", method: AGENT_GONE })).catch(() => {});
  }

  // Out of the session: its agents' records go with it.
  function forgetAgents(cur) {
    for (const [participant, st] of agentState) if (st.cur === cur) agentState.delete(participant);
  }

  return { onAgent, tabInSight, sendLine, sendFile, remoteCall, agentGone, forgetAgents };
}
