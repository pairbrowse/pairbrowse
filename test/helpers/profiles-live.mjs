// Shared by the browser profiles' live tests (test/integration/profiles-*.test.mjs, spec server-mode
// Phase D): a site that keeps a login (a persistent cookie), localStorage and IndexedDB and shows
// what came back, a cached script it counts fetches of, the profiles' command line run on a
// helper's home, and a session's browser folder there. No project code is loaded here.
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { root, nativeExe, nativeVersion } from "./daemon.mjs";
import { text } from "./util.mjs";

// The browser a test's profiles are for: the one its helpers run (daemon.mjs nativeExe).
export const BROWSER_KIND = nativeExe ? "pairbrowse" : "pairbrowse-open";
// A session's profile check as pairbrowse_status names it, for a RegExp: on the native build its
// version and the check's verdict (measured at the start; "failed" while the engine's WebGPU limits
// are the persona's, spec server-mode 961), on PairBrowse as an extension "unverified".
export const CHECKED_ON = nativeExe ? `(?:validated|failed|unverified) on ${nativeVersion.replaceAll(".", "\\.")}` : "unverified on PairBrowse as an extension";

// The page: with ?set=1 it sets the cookie, localStorage and IndexedDB; then it shows all three
// ("storage: ls=<value|null> idb=<value|none> done") and loads /cached.js.
const PAGE = (cookie, set) => `<!doctype html><title>Profile probe</title><h1>Profile probe</h1>
<p>cookies: ${cookie || "(none)"}</p><p id=s>storage: waiting</p><script src="/cached.js"></script>
<script>
const set = ${set ? "true" : "false"};
if (set) localStorage.setItem("k", "kept");
const out = (idb) => { document.getElementById("s").textContent = "storage: ls=" + localStorage.getItem("k") + " idb=" + idb + " done"; };
const req = indexedDB.open("pbprobe", 1);
req.onupgradeneeded = () => req.result.createObjectStore("s");
req.onerror = () => out("error");
req.onsuccess = () => {
  const tx = req.result.transaction("s", set ? "readwrite" : "readonly");
  if (set) { tx.objectStore("s").put("kept", "k"); tx.oncomplete = () => out("kept"); }
  else { const g = tx.objectStore("s").get("k"); g.onsuccess = () => out(g.result ?? "none"); }
};
</script>`;

// The site: { base, fetches (of /cached.js), close() }.
export function startProbeSite() {
  const site = { fetches: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/cached.js") {
      site.fetches++;
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=86400" });
      return res.end("window.cachedLoaded = true;");
    }
    const set = url.searchParams.get("set") === "1";
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", ...(set ? { "set-cookie": ["login=kept; Path=/; Max-Age=86400"] } : {}) });
    res.end(PAGE(req.headers.cookie, set));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(Object.assign(site, { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }))));
}

// What the probe page shows in an agent's browser: { cookies, ls, idb } (it waits for "done").
export async function probe(agent, url) {
  await agent.tool("browser_navigate", { url });
  await agent.tool("browser_wait_for", { text: "done" });
  const t = text(await agent.tool("browser_snapshot", {}));
  const m = /storage: ls=(\S+) idb=(\S+) done/.exec(t);
  return { cookies: /cookies: ([^\n"]*)/.exec(t)?.[1]?.trim() || "(no cookie line)", ls: m?.[1] || "(none)", idb: m?.[2] || "(none)" };
}

// The profiles' command line (scripts/profiles/cli.mjs) on a helper's home: { code, out, err }.
// env: more of the environment (an instance's HOME and PAIRBROWSE_INSTANCE in place of home).
export function profilesCli(home, args, env = null) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "profiles", "cli.mjs"), ...args], {
    encoding: "utf8", timeout: 60_000, env: env || { ...process.env, PAIRBROWSE_HOME: home },
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// A session's browser folder in a helper's home (paths.mjs sessionProfile).
export const sessionFolder = (home, name) => (name === "default" ? join(home, "profile") : join(home, "sessions", name));
// The browser's own folder for a session (its user data: Default/, Local State, SingletonLock):
// the session's folder, or on the native build its pairbrowse-native folder (engine.mjs nativeProfile).
export const browserFolder = (home, name) => (nativeExe ? join(sessionFolder(home, name), "pairbrowse-native") : sessionFolder(home, name));
// A session's assignment (sessions.mjs assignmentFile) and binding (bindingFile) in that home.
export const assignmentPath = (home, name) => (name === "default" ? join(home, "assignment.json") : join(home, "sessions", `${name}.assignment.json`));
export const bindingPath = (home, name) => join(sessionFolder(home, name), "pairbrowse-binding.json");

// Every file under dir by its path (links not followed), for "where does this live" checks.
export function filesUnder(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    out.push({ path: p, dir: st.isDirectory() });
    if (st.isDirectory()) filesUnder(p, out);
  }
  return out;
}

// A file's SHA-256, or null when it isn't there.
export const fileHash = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
// Whether a file holds a string (a History database naming an address).
export const fileHolds = (file, s) => existsSync(file) && readFileSync(file).includes(Buffer.from(s));
