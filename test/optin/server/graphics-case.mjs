// One case of test/optin/server/graphics-run.mjs in a container of its own (linux-graphics and
// graphics-recovery share it): the pinned Linux build and engine pack cached (native-cache.mjs),
// the container started with the runtime and the cache mounted, the run's RESULT line parsed.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerReady, startContainer } from "./container.mjs";
import { prepareNativeCache } from "./native-cache.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function runGraphicsCase(which, runtime) {
  assert.ok(dockerReady(), "Docker answers");
  const cache = await prepareNativeCache({ log: console.log });
  const c = startContainer({ name: `pb-graphics-${which}`, repo, log: console.log, mounts: [{ from: runtime, to: "/runtime" }, { from: cache, to: "/cache" }] });
  try {
    const r = await c.node("/repo/test/optin/server/graphics-run.mjs", [which], { ms: 2_700_000 });
    const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the case ran:\n${r.out.slice(-6000)}`);
    const result = JSON.parse(line.slice("RESULT ".length));
    assert.equal(result.error, undefined, `${result.error}\n--- daemon.log ---\n${result.log || ""}`);
    return result;
  } finally { c.stop(); }
}
