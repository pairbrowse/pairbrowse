// A real helper and browser for live tests (PAIRBROWSE_TEST_RUNTIME), headless, in a home of its
// own under the system's temp folder: { a (an agent's session), h (the home), stop() }.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { session } from "./live.mjs";
import { helperHome, spawnDaemon, stopDaemon } from "./daemon.mjs";
import { sleep } from "./util.mjs";

export { text } from "./util.mjs";

export async function liveHelper(runtime, { prefix = "lh-", config = {}, args = [], name = "w", env = {} } = {}) {
  const h = helperHome(runtime, { prefix, config: { ...config, browserArgs: args } });
  const daemon = spawnDaemon(h, { env });
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const a = await session(socketPath, name);
  const agents = [a];
  return {
    a, h, socketPath,
    async agent(n) { const s = await session(socketPath, n); agents.push(s); return s; },
    async stop() {
      for (const s of agents) s.sock.destroy();
      await stopDaemon(daemon);
      rmSync(h, { recursive: true, force: true });
    },
  };
}
