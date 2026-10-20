// daemon.log (scripts/daemon/logfile.mjs): saved secrets, reserved ones too, are masked in every
// line and in what the helper writes to its stdout and stderr (the same file); errors no handler
// caught are logged.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogFile } from "../scripts/daemon/logfile.mjs";

const fakeStream = () => { const got = []; return { got, write: (chunk, ...rest) => { got.push([chunk, ...rest]); return true; } }; };

test("daemon.log lines carry a saved secret only as its name, once the store is there", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pb-logfile-")), "daemon.log");
  const values = { SHOP_PW: "hunter2-shop", PAIRBROWSE_PROXY_HOME_PASSWORD: "proxy-pass-9" };
  const { log, maskWith } = createLogFile({ file, now: () => new Date(0), streams: [] });
  log("before", "nothing to mask yet");
  maskWith(() => values);
  log("proxy auth failed for", "user:proxy-pass-9@proxy.test", "and hunter2-shop");
  values.NEW_PW = "added-later-1";
  log("typed added-later-1");
  const text = readFileSync(file, "utf8");
  assert.match(text, /^1970-01-01T00:00:00\.000Z before nothing to mask yet$/m);
  for (const v of ["proxy-pass-9", "hunter2-shop", "added-later-1"]) assert.ok(!text.includes(v), v);
  assert.match(text, /user:PAIRBROWSE_PROXY_HOME_PASSWORD@proxy\.test and SHOP_PW/);
  assert.match(text, /typed NEW_PW/, "a password added later is masked from its next line");
});

test("what the helper writes to stdout and stderr is masked too; values under 4 characters are not secrets", () => {
  const out = fakeStream();
  const err = fakeStream();
  const lf = createLogFile({ file: join(mkdtempSync(join(tmpdir(), "pb-logfile-")), "daemon.log"), streams: [out, err] });
  lf.maskWith(() => ({ PAIRBROWSE_NTFY_TOKEN: "tk-secret-77", SHORT_PW: "abc" }));
  err.write("Error: auth tk-secret-77 abc\n");
  out.write(Buffer.from("buffer tk-secret-77\n"), () => {});
  out.write("68656c6c6f", "hex");
  assert.equal(err.got[0][0], "Error: auth PAIRBROWSE_NTFY_TOKEN abc\n");
  assert.equal(Buffer.from(out.got[0][0]).toString(), "buffer PAIRBROWSE_NTFY_TOKEN\n");
  assert.equal(typeof out.got[0][1], "function", "the callback goes through");
  assert.deepEqual(out.got[1], ["68656c6c6f", "hex"], "a non-text encoding passes as it was");
  const same = Buffer.from("nothing here\n");
  out.write(same);
  assert.equal(out.got[2][0], same, "a chunk with nothing to mask is passed on as it is");
  lf.maskWith(() => { throw new Error("store not ready"); });
  err.write("still writes\n");
  assert.equal(err.got[1][0], "still writes\n");
});

test("a stray rejection is logged and the helper goes on; an uncaught exception is logged, then onFatal", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pb-logfile-")), "daemon.log");
  const lf = createLogFile({ file, streams: [] });
  lf.maskWith(() => ({ SHOP_PW: "hunter2-shop" }));
  const proc = new EventEmitter();
  const fatal = [];
  lf.catchStrays((e) => fatal.push(e), proc);
  proc.emit("unhandledRejection", new Error("page closed with hunter2-shop"));
  assert.equal(fatal.length, 0);
  proc.emit("uncaughtException", new Error("bug"));
  assert.equal(fatal.length, 1);
  const text = readFileSync(file, "utf8");
  assert.match(text, /unhandled rejection: Error: page closed with SHOP_PW/);
  assert.match(text, /uncaught exception: Error: bug/);
  assert.ok(!text.includes("hunter2-shop"));
});
