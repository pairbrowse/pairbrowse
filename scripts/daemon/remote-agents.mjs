// Shared browser mode, on the host: a joiner's own Claude or Codex works in this browser as one
// more participant (serve.mjs, with its turns, the guard, presence and its name), its MCP
// messages carried over the join channel. It's a remote participant: what needs the user's OK
// is handed to a person (as for any app that can't ask the host), and it never reaches the
// host's saved passwords, remembered details, sessions or invites, nor files on this computer:
// it uploads only what its own side sent over (file()).
import { Duplex } from "node:stream";
import { mkdirSync, writeFileSync, appendFileSync, statSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";

const FILE_MAX = 50 * 1024 * 1024; // one file sent over by a joiner's agent
const FILES_MAX = 20; // files kept per joiner at once
const LINE_MAX = 200_000;

// serve(sock, { remote }): runs one participant (serve.mjs). dir: where joiners' files go.
export function createRemoteAgents({ serve, dir, log = () => {} }) {
  const conns = new Map(); // `${key}|${agent}` -> duplex
  const files = new Map(); // key -> Map(token -> { path, size, done })

  // The joiner's folder for files: its own, under dir, emptied when they go.
  const folder = (key) => join(dir, `joiner-${key.replace(/[^\w]/g, "").slice(0, 40)}`);

  return {
    // One MCP message from a joiner's agent (agent: its id on their side). send(line): its
    // answers, back to that joiner. who: { name, app, key }.
    line(who, agent, line, send) {
      if (typeof line !== "string" || line.length > LINE_MAX || !/^[\w-]{1,40}$/.test(String(agent))) return false;
      const id = `${who.key}|${agent}`;
      let d = conns.get(id);
      if (!d) {
        d = new Duplex({
          read() {},
          write(chunk, _enc, cb) { for (const l of chunk.toString().split("\n")) if (l) { try { send(l); } catch {} } cb(); },
        });
        d.on("error", () => {});
        conns.set(id, d);
        d.once("close", () => conns.delete(id));
        serve(d, { remote: { name: who.name, key: who.key, files: folder(who.key) } }).catch?.((e) => log("remote agent", e?.message || e));
      }
      d.push(line + "\n");
      return true;
    },
    // A file sent over in parts by a joiner's agent, for an upload in a shared tab: { token,
    // name, part, data (base64), last }. Answers with the path to pass to the upload once the
    // last part is in.
    file(who, body) {
      const key = who.key;
      const list = files.get(key) || new Map();
      files.set(key, list);
      let f = list.get(body?.token);
      if (!f) {
        if (list.size >= FILES_MAX) return { problem: "Too many files at once." };
        if (typeof body?.token !== "string" || !/^[\w-]{8,40}$/.test(body.token)) return { problem: "Bad file." };
        const name = basename(String(body.name || "file")).replace(/[^\w.\- ]/g, "_").slice(0, 120) || "file";
        const where = join(folder(key), randomBytes(6).toString("hex"));
        mkdirSync(where, { recursive: true, mode: 0o700 });
        f = { path: join(where, name), size: 0, done: false, next: 0 };
        writeFileSync(f.path, "", { mode: 0o600 });
        list.set(body.token, f);
      }
      if (f.done || body.part !== f.next) return { problem: "Parts out of order." };
      const data = Buffer.from(String(body.data || ""), "base64");
      if (f.size + data.length > FILE_MAX) { list.delete(body.token); rmSync(f.path, { force: true }); return { problem: "That file is too large (50 MB at most)." }; }
      appendFileSync(f.path, data);
      f.size += data.length;
      f.next++;
      if (body.last) { f.done = true; return { path: f.path, size: statSync(f.path).size }; }
      return { ok: true };
    },
    // A joiner left: their agents disconnect and their files go.
    stop(key) {
      for (const [id, d] of conns) if (id.startsWith(`${key}|`)) d.destroy();
      files.delete(key);
      rmSync(folder(key), { recursive: true, force: true });
    },
    folder,
  };
}
