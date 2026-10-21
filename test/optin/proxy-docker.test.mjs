// Phase C on the native Linux build in the A13 container (spec server-mode C1, decision 9, step
// 49; definition of done, Phase C): a session in server mode on an http: and on a socks5: proxy
// that need a username and password starts on the native build (engine patch 962), its page loads
// through the proxy, which saw the credentials (Basic; RFC 1929 username/password on SOCKS5), the
// credentials appear in no process's command line, no log line and not the browser's NetLog, the
// auth file is gone once the browser is up, the browser looks up no name itself (strict), and the
// sandbox is on. The run inside is test/optin/server/proxy-run.mjs.
//
// Needs Docker (OrbStack on a Mac), PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME; the
// pinned Linux build and engine pack from PAIRBROWSE_TEST_LINUX_ARCHIVE and
// PAIRBROWSE_TEST_ENGINE_ARCHIVE (local files matching the pins), else from the release.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerReady, startContainer } from "./server/container.mjs";
import { prepareNativeCache } from "./server/native-cache.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = (!runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1") && "set PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("native Linux build: http and socks5 proxies with a username and password start, the proxy saw them, nothing else did, strict DNS, sandbox on", { skip: SKIP, timeout: 3_000_000 }, async (t) => {
  assert.ok(dockerReady(), "Docker answers");
  const cache = await prepareNativeCache({ log: console.log });
  const c = startContainer({ name: "pb-proxy-docker", repo, log: console.log, mounts: [{ from: runtime, to: "/runtime" }, { from: cache, to: "/cache" }] });
  let r;
  try {
    const out = await c.node("/repo/test/optin/server/proxy-run.mjs", [], { ms: 2_700_000 });
    const line = out.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the run printed its result:\n${out.out.slice(-6000)}`);
    r = JSON.parse(line.slice("RESULT ".length));
  } finally { c.stop(); }
  t.diagnostic(JSON.stringify(r, null, 1).slice(0, 16000));
  assert.equal(r.error, undefined, r.error);
  assert.notEqual(r.uid, 0, "a normal user");
  for (const scheme of ["http", "socks5"]) {
    const o = r.cases[scheme];
    assert.ok(o, `${scheme} ran`);
    assert.ok(!o.navigateError, `${scheme}: the page opens through the proxy with its credentials: ${o.navigate}\n${(o.log || []).join("\n")}`);
    assert.ok(o.asked.includes(`${o.names.page}/`), `${scheme}: the page came through the proxy: ${JSON.stringify(o.asked)}`);
    assert.ok(o.authorized > 0, `${scheme}: the proxy saw the credentials: ${JSON.stringify(o.proxyLog)}`);
    if (scheme === "socks5") {
      assert.ok(o.proxyLog.some((l) => l.authorized && l.atyp === 3 && l.host === o.names.page), `${scheme}: username/password authentication, then the name: ${JSON.stringify(o.proxyLog)}`);
      assert.ok(o.proxyLog.some((l) => l.methods.includes(0) && l.methods.includes(2)), "the browser's greeting offered both methods");
      assert.ok(o.proxyLog.filter((l) => !l.methods.includes(2)).every((l) => !l.authorized && l.host === null), "a greeting without username/password never signs in or reaches a host");
    } else {
      assert.ok(o.proxyLog.some((l) => l.authorized && l.target === `http://${o.names.page}/`), `${scheme}: Basic on the page's request: ${JSON.stringify(o.proxyLog)}`);
    }
    assert.deepEqual(o.commandLines, [], `${scheme}: no credential on any command line`);
    assert.deepEqual(o.authFiles, [], `${scheme}: the auth file is deleted once the browser is up`);
    assert.equal(o.launchLine, 'launch: network "stub" (default, strict, auth file)');
    assert.match(o.status, /network "stub" \(strict\): exit checked at launch, country US/, o.status);
    assert.deepEqual(o.logCredentials, [], `${scheme}: no credential in daemon.log`);
    assert.ok(o.netlog, `${scheme}: the browser wrote its NetLog`);
    assert.deepEqual(o.netlogCredentials, [], `${scheme}: no credential in the NetLog`);
    assert.ok(o.resolved.length > 0, `${scheme}: the NetLog is the browser's (resolver events)`);
    assert.deepEqual(o.leaks, [], `${scheme}: strict: the browser looked up no name itself`);
    assert.ok(o.sandbox && o.sandbox.noSandboxSwitch === false && o.sandbox.renderers > 0 && o.sandbox.namespaced === o.sandbox.renderers, `${scheme}: the sandbox: ${JSON.stringify(o.sandbox)}`);
    assert.ok(o.stopped, `${scheme}: the helper stopped`);
  }
});
