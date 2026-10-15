// One line out, one line back, on the helper's private socket: how a hook (guard.mjs, the
// PermissionRequest ask) and the opener (open.mjs) talk to the helper. A hook's line starts with
// HOOK_MARK, which an MCP client's never does (daemon/approvals.mjs tells them apart by it).
import { within } from "./util.mjs";

// The first bytes of a hook's line on the private socket (an MCP client's never start so).
export const HOOK_MARK = '{"pairbrowse":"hook"';
// The most a reply line may be: anything longer is no answer.
export const LINE_MAX = 4096;

// Writes line (ended with a newline if it isn't) on sock and resolves the first line that comes back, without
// its newline; null on an error, a reply over LINE_MAX, or no reply within ms. A socket that
// closes before a newline: null, or with partialOnClose what it sent by then. sock is destroyed
// once it resolved.
export function requestLine(sock, line, ms, { partialOnClose = false } = {}) {
  return within(ms, new Promise((resolve) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) resolve(buf.slice(0, i));
      else if (buf.length > LINE_MAX) resolve(null);
    });
    sock.on("error", () => resolve(null));
    sock.on("close", () => resolve(partialOnClose ? buf : null));
    sock.write(line.endsWith("\n") ? line : `${line}\n`);
  })).finally(() => sock.destroy());
}
