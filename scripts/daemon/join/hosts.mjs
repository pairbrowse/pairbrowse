// The address a join code leads to: the person's decision. A code whose address isn't a Quick
// Tunnel or one they allowed is a question for the person alone (the side panel, the session
// picker): Allow once (this run), Always allow (joinHosts in config.json) or Cancel.
// api.command(args, { owner, app }): pairbrowse_join (daemon/follow.mjs), for the join a yes starts.
import { joinHostsOf, cleanHost, saveJoinHosts, createHostAsks } from "../../sharing/join.mjs";

export function createJoinHosts({ config, log, note, onHostChange, configFile }, api) {
  // A code whose address isn't a Quick Tunnel or one they allowed is a question for the person
  // alone (the side panel, the session picker): Allow once (this run), Always allow (joinHosts in
  // config.json) or Cancel. Agents are refused and told to ask them; no tool allows an address.
  const onceHosts = new Set(); // allowed for this run of the helper
  const hostAsks = createHostAsks();
  const allowedHosts = () => [...new Set([...joinHostsOf(config), ...onceHosts])];
  // For the side panel: the questions waiting, and the addresses allowed (always, or this time).
  const hostState = () => ({
    asks: hostAsks.list(),
    hosts: [...joinHostsOf(config).map((host) => ({ host, always: true })), ...[...onceHosts].filter((h) => !joinHostsOf(config).includes(h)).map((host) => ({ host, always: false }))],
  });
  const hostsChanged = () => { try { onHostChange(hostState()); } catch (e) { log("join hosts", e?.message || e); } };
  hostAsks.onChange(hostsChanged);
  // Questions time out like join requests do: the panel hears of it.
  setInterval(() => hostAsks.list(), 30_000).unref();
  const hostLine = () => {
    const { asks, hosts } = hostState();
    const lines = [];
    if (asks.length) lines.push(`Waiting for the user to allow ${[...new Set(asks.map((a) => a.host))].join(", ")} in the PairBrowse side panel (a code leads there).`);
    if (hosts.length) lines.push(`Join addresses allowed besides *.trycloudflare.com: ${hosts.map((h) => `${h.host} (${h.always ? "always" : "this time"})`).join(", ")}. The user removes one in the side panel.`);
    return lines.join(" ");
  };

  // The person's answer about a code's address, from the side panel or the picker (a real
  // click there; the live view takes it with the owner's key from the extension's origin only).
  // op: { op: "allow", id, always } (the join starts at once, with the code and name the question
  // kept), { op: "cancel", id }, or { op: "forget", host } (Remove: this run's and config.json's).
  // Returns { ok, text, owner, joined, host } ({ error } when it can't be done).
  async function decideHost(op) {
    const kind = String(op?.op || "");
    if (kind === "forget") {
      const host = cleanHost(op.host);
      if (!host) return { error: "No such address." };
      onceHosts.delete(host);
      if (joinHostsOf(config).includes(host)) {
        try { saveJoinHosts(config, joinHostsOf(config).filter((h) => h !== host), configFile); } catch (e) { return { error: `Couldn't change config.json: ${e?.message || e}` }; }
      }
      log(`join address ${host} removed by the user`);
      hostsChanged();
      return { ok: true, host };
    }
    if (kind !== "allow" && kind !== "cancel") return { error: "Unknown request." };
    const ask = hostAsks.take(op.id);
    if (!ask) return { error: "That question is gone (answered, or it timed out after 10 minutes)." };
    if (kind === "cancel") { log(`join address ${ask.host}: Cancel from the user`); return { ok: true, host: ask.host, owner: ask.owner }; }
    if (op.always === true) {
      try { saveJoinHosts(config, [...joinHostsOf(config), ask.host], configFile); } catch (e) { hostsChanged(); return { error: `Couldn't write config.json: ${e?.message || e}. Nothing was allowed.` }; }
    } else onceHosts.add(ask.host);
    log(`join address ${ask.host} allowed by the user (${op.always === true ? "always" : "this time"}); joining`);
    hostsChanged();
    const r = await api.command({ action: "join", code: ask.code, name: ask.name }, { owner: ask.owner, app: ask.app });
    // The agent that brought the code hears how it went in its next result.
    if (ask.owner !== "picker") note(r.error ? `The user allowed ${ask.host} in the side panel, but joining didn't work: ${r.text}` : `The user allowed ${ask.host} in the side panel and the join started. ${r.text}`);
    return { ok: !r.error, text: r.text, owner: ask.owner, joined: !r.error, host: ask.host };
  }

  return { onceHosts, hostAsks, allowedHosts, hostState, hostsChanged, hostLine, decideHost };
}
