// The pinned native Linux build and engine pack for the container tests (spec server-mode step 49),
// kept between runs in the test downloads folder and mounted into the container at /cache. Each
// comes from a local file named by PAIRBROWSE_TEST_LINUX_ARCHIVE or PAIRBROWSE_TEST_ENGINE_ARCHIVE
// when it matches the pin (a build made here and not yet published, scripts/native-pack.mjs), else
// from the release the pin names; either way the copy in the cache is the pinned archive, checked
// by its SHA-256 here and again by the install inside.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE } from "../../../scripts/native-pack.mjs";
import { downloadPinned, sha256File } from "../../../scripts/util.mjs";

export const cacheDir = join(tmpdir(), "pairbrowse-test-downloads");

export async function prepareNativeCache({ log = () => {} } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const local = { [NATIVE.linux.file]: process.env.PAIRBROWSE_TEST_LINUX_ARCHIVE, [NATIVE.engine.file]: process.env.PAIRBROWSE_TEST_ENGINE_ARCHIVE };
  for (const asset of [NATIVE.linux, NATIVE.engine]) {
    const dest = join(cacheDir, asset.file);
    const from = local[asset.file];
    if (from && (!existsSync(dest) || await sha256File(dest) !== asset.sha256)) {
      const got = await sha256File(from);
      if (got !== asset.sha256) throw new Error(`${from} doesn't match the pin of ${asset.file} (expected ${asset.sha256}, got ${got})`);
      log(`${asset.file}: from ${from}`);
      copyFileSync(from, dest);
    }
    await downloadPinned(`${NATIVE.baseUrl}/${asset.file}`, dest, asset.sha256);
  }
  return cacheDir;
}
