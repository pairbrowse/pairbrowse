// Files a site hands over: kept in the Downloads folder under a plain name (never over another
// file), with the mark Open and Office's Protected View read, and the Tools tab told (onDownload);
// and the browser's history forgetting Playwright's temporary ones before a launch.
// profile(): the profile folder of the browser about to launch.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, lstatSync, unlinkSync, createReadStream, constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { keepDownloadMark } from "../toolstab.mjs";
import { downloadsFolderNow } from "../../rules/downloads.mjs";
import { paths } from "../../paths.mjs";

// The folder a save goes to, checked at the time of the save (rules/downloads.mjs): the chosen
// one's real path while it still qualifies, else your Downloads folder; { dir, problem? }.
// Under the test runner (NODE_TEST_CONTEXT, as paths.mjs) a save never reaches the account's own
// home: a test helper gives its own HOME.
export function saveFolder(config, home = paths.home, user = homedir()) {
  if (process.env.NODE_TEST_CONTEXT && resolve(user) === resolve(userInfo().homedir)) return { dir: null, problem: "a test never saves into your own home folder (give the helper a HOME of its own)" };
  return downloadsFolderNow(config.downloadsDir, { home, user });
}

export function createDownloads({ personTabs, config, hostNote, log, onDownload, profile, folderNow = () => saveFolder(config) }) {
  // Files a site hands over (invoices, exported keys) go to the Downloads folder, as in any
  // browser; Playwright would otherwise keep them under a random name and delete them on close.
  function keepDownloads(page) {
    page.on("download", async (download) => {
      // A download started in the person's own tab is theirs: no note for the agents.
      const personal = personTabs.has(page);
      // The site picks the name: keep it to a plain file name.
      const name = basename(download.suggestedFilename() || "download").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download";
      const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
      let id = null;
      try { id = onDownload({ op: "start", name, page }); } catch {}
      try {
        const from = await download.path(); // finished, in Playwright's temporary folder
        // Resolved and checked now, once the download has finished and right before the write, not
        // when it was chosen or when the download started: a folder since swapped for a link
        // elsewhere is never written to.
        const { dir, problem } = folderNow();
        if (problem) log(`downloads folder not used: ${problem}`);
        if (!dir) throw new Error(`no folder downloads may go to (${problem})`);
        const dest = await saveInto(dir, name, dot, from);
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

  // Playwright saves downloads to a temporary folder it deletes when the browser closes. The engine
  // still lists them in its download history, and on the next launch the macOS PairBrowse browser
  // (the open build on macOS) quits on the first new download. Forget those entries before launching.
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

// The folder is still itself: its real path is the one checked (no part of it swapped for a link).
const stillReal = (dir) => { try { return realpathSync(dir) === dir; } catch { return false; } };
const NOFOLLOW = fsConstants.O_NOFOLLOW || 0; // not on Windows, where the folder check alone stands

// Copies from into dir (a real path just checked) under name, or "name (1).ext" and so on: never over
// an existing file (O_EXCL), never through a link at the file's own name (O_NOFOLLOW), and only while
// the folder's real path is still dir, checked before the file is made and again once it is open,
// before a byte is written. The file's path.
export async function saveInto(dir, name, dot, from) {
  for (let i = 0; ; i++) {
    const dest = join(dir, i ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : name);
    if (!stillReal(dir)) throw new Error(`${dir} changed (now a link elsewhere); not written to`);
    let fh;
    try { fh = await open(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o666); }
    catch (e) { if (e.code !== "EEXIST" || i > 500) throw e; continue; }
    try {
      const st = await fh.stat();
      let same = false;
      try { const l = lstatSync(dest); same = l.isFile() && l.ino === st.ino && l.dev === st.dev; } catch {}
      if (!same || !stillReal(dir)) {
        // Swapped between the check and the open: the empty file made is left nowhere it was asked.
        try { const l = lstatSync(dest); if (l.ino === st.ino && l.dev === st.dev && l.size === 0) unlinkSync(dest); } catch {}
        throw new Error(`${dir} changed while saving (now a link elsewhere); not written to`);
      }
      const out = fh.createWriteStream(); // closes the file when done
      fh = null;
      await pipeline(createReadStream(from), out);
      return dest;
    } finally { if (fh) await fh.close().catch(() => {}); }
  }

}
