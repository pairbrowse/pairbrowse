// daemon.log, the helper's own log (spec server-mode C3): one line per call, the time first, and
// every saved secret's value (4 or more characters, reserved PAIRBROWSE_ ones included) replaced by
// its name before the line is written, as the hook log does (log.mjs). The helper's stdout and
// stderr go to the same file (daemon-connect.mjs opens it for them), so what the helper or a
// library writes there is masked the same way. The values come from maskWith(values), called once
// the password store exists (it logs its own problems through this log, so it comes second).
// Not masked: a value split across two writes to stdout or stderr, and what the runtime itself
// prints when it dies outside any handler (catchStrays logs those through log first).
import { appendFileSync } from "node:fs";
import { redact } from "../rules/secrets.mjs";

// file: daemon.log (paths.daemonLog). now(): the clock (tests). streams: the ones that land in the
// file (the helper's stdout and stderr), their write masked from here on.
export function createLogFile({ file, now = () => new Date(), streams = [process.stdout, process.stderr] } = {}) {
  let values = () => ({});
  const mask = (text) => {
    let current = {};
    try { current = values() || {}; } catch {}
    return redact(text, current, { as: (name) => name });
  };
  const log = (...a) => appendFileSync(file, `${now().toISOString()} ${mask(a.join(" "))}\n`);

  for (const stream of streams) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      if (typeof rest[0] === "string" && !/^utf-?8$/i.test(rest[0])) return write(chunk, ...rest); // hex, base64: not text
      if (typeof chunk === "string") return write(mask(chunk), ...rest);
      if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
        const masked = mask(text);
        return write(masked === text ? chunk : Buffer.from(masked, "utf8"), ...rest);
      }
      return write(chunk, ...rest);
    };
  }

  // values(): the saved secrets' { NAME: value }, read at each line (a password added in the
  // Profile panel is masked from its next line on).
  const maskWith = (fn) => { values = typeof fn === "function" ? fn : () => ({}); };

  // A promise nobody caught (a page that closed under a background read, a joiner's channel
  // dropping mid-send) is logged and the helper goes on: Node would otherwise end the process,
  // killing the browser before it wrote its cookies. A thrown error outside any handler is a bug
  // the helper can't reason about: logged, then onFatal (a clean shutdown: the browser closes
  // properly and the bridges reopen it on the next action).
  function catchStrays(onFatal, proc = process) {
    proc.on("unhandledRejection", (e) => log(`unhandled rejection: ${e?.stack || e}`));
    proc.on("uncaughtException", (e) => { log(`uncaught exception: ${e?.stack || e}`); onFatal(e); });
  }

  return { log, maskWith, catchStrays, mask };
}
