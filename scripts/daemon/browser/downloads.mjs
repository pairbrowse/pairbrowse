// Files a site hands over: kept in the Downloads folder under a plain name (never over another
// file), with the mark Open and Office's Protected View read, and the Tools tab told (onDownload);
// and the browser's history forgetting Playwright's temporary ones before a launch.
// profile(): the profile folder of the browser about to launch.
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, constants as fsConstants } from "node:fs";
import { basename, join } from "node:path";
import { keepDownloadMark } from "../tools.mjs";

export function createDownloads({ personTabs, config, hostNote, log, onDownload, profile }) {
  // Files a site hands over (invoices, exported keys) go to the Downloads folder, as in any
  // browser; Playwright would otherwise keep them under a random name and delete them on close.
  function keepDownloads(page) {
    page.on("download", async (download) => {
      // A download started in the person's own tab is theirs: no note for the agents.
      const personal = personTabs.has(page);
      const dir = config.downloadsDir || join(homedir(), "Downloads");
      // The site picks the name: keep it to a plain file name.
      const name = basename(download.suggestedFilename() || "download").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download";
      const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
      let id = null;
      try { id = onDownload({ op: "start", name, page }); } catch {}
      try {
        mkdirSync(dir, { recursive: true });
        const from = await download.path(); // finished, in Playwright's temporary folder
        let dest;
        for (let i = 0; ; i++) {
          dest = join(dir, i ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : name);
          try { copyFileSync(from, dest, fsConstants.COPYFILE_EXCL); break; } // never over an existing file
          catch (e) { if (e.code !== "EEXIST" || i > 500) throw e; }
        }
        await keepDownloadMark(from, dest); // Open and Office's Protected View read it
        try { onDownload({ op: "done", id, path: dest }); } catch {}
        if (!personal) hostNote(`Downloaded ${name} to ${dest}`);
        log(`downloaded ${dest}`);
      } catch (e) {
        try { onDownload({ op: "failed", id }); } catch {}
        const why = await download.failure().catch(() => null);
        if (!personal) hostNote(`Download of ${name} failed: ${why || e?.message || e}`);
        log(`download of ${name} failed: ${why || e?.message || e}`);
      }
    });
  }

  // Playwright saves downloads to a temporary folder it deletes when the browser closes. Chrome
  // still lists them in its download history, and on the next launch the macOS PairBrowse browser
  // (ungoogled-chromium) quits on the first new download. Forget those entries before launching.
  function forgetTemporaryDownloads() {
    const history = join(profile(), "Default", "History");
    if (process.platform !== "darwin" || !existsSync(history)) return;
    const temporary = "target_path LIKE '%/playwright-artifacts-%'";
    const sql = `DELETE FROM downloads_url_chains WHERE id IN (SELECT id FROM downloads WHERE ${temporary}); ` +
      `DELETE FROM downloads_slices WHERE download_id IN (SELECT id FROM downloads WHERE ${temporary}); DELETE FROM downloads WHERE ${temporary};`;
    const r = spawnSync("/usr/bin/sqlite3", [history, sql], { timeout: 5000, encoding: "utf8" });
    if (r.status !== 0) log(`couldn't clear temporary downloads: ${(r.stderr || r.error?.message || "").trim()}`);
  }

  return { keepDownloads, forgetTemporaryDownloads };
}
