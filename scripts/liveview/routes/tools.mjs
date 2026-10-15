// The Tools tab's routes on the owner's port (the owner only): this session's downloads, the
// recordings this helper saved, the hand-offs waiting for the person, and diagnostics. Files go by
// id (daemon/toolstab.mjs), never a path. startLiveView (liveview.mjs) mounts them.
import { pathToFileURL } from "node:url";
import { ownTitle } from "../../daemon/tablabels.mjs";
import { fileStill, openable, downloadMarked, openWay, confirmFor, isDocument } from "../../daemon/toolstab.mjs";
import { within } from "../../util.mjs";
import { readCapped, parseJson, json, plain, BODY_MAX } from "../http.mjs";
import { hostOf } from "../tabs.mjs";

const TOOL_ID = /^[0-9a-f]{12}$/; // a download, recording or hand-off (daemon/toolstab.mjs): never a path

// tools: the helper's Tools tab (startLiveView's tools), or null. mask(text): as results are
// masked. recordState(): the recorder's state. idOf(page): a tab's id. bringTabForward(page).
// previewOf: person's tab -> its document preview's download id (filled here, read by the tab lists).
// viewers, clients: the live view's open streams; joinersNow(), guests(): who is here.
// Returns the routes and what the Tools tab's events use (maskedDownload, handoffItem).
export function createToolsRoutes({ tools, mask, recordState, idOf, bringTabForward, previewOf, viewers, clients, joinersNow, guests }) {
  // The Tools tab's routes: 404 without the helper's tools.
  function toolsOn() { return !!tools; }
  const FILE_CHANGED = "That file was moved, replaced or deleted since it was saved.";
  const maskedDownload = (d) => ({ ...d, from: { host: d.from?.host || "", title: mask(String(d.from?.title || "")) } });
  const tabTitle = async (page) => mask(String((await within(1000, Promise.resolve(ownTitle(page)).catch(() => ""))) ?? ""));
  const handoffItem = async (h) => {
    const page = h.page && !h.page.isClosed() ? h.page : null;
    return { id: h.id, kind: h.kind, text: mask(h.text), tab: page ? { id: idOf(page), host: hostOf(page.url()), title: await tabTitle(page) } : null, by: h.by, at: h.at };
  };
  // POST downloads|recordings/<id>/open|reveal (and downloads/<id>/open-app): the stored file,
  // checked. A download opens in a person's own tab where the browser renders it (daemon/toolstab.mjs
  // openWay), as a read-only preview there (daemon/preview.mjs), or with the OS opener; open-app
  // opens a document with its app. Recordings: the OS opener only.
  async function fileAction({ req, res, rest }, store, isDownload) {
    const verbs = isDownload ? ["open", "reveal", "open-app"] : ["open", "reveal"];
    if (rest.length !== 2 || !TOOL_ID.test(rest[0]) || !verbs.includes(rest[1])) return plain(res, 404);
    const body = await readCapped(req, res, BODY_MAX.approve);
    if (body === null) return;
    const e = store.entry(rest[0]);
    if (!e) return plain(res, 404);
    if (isDownload && e.state !== "done") return json(res, 409, { error: e.state === "failed" ? "That download failed; there is no file to show." : "That download hasn't finished yet." });
    if (!fileStill(e)) return json(res, 410, { error: FILE_CHANGED });
    if (rest[1] === "open" && !isDownload && !openable(e.path)) return json(res, 409, { error: "This kind of file isn't opened from here: it could run as a program. Use Reveal to show it in its folder." });
    if (isDownload && rest[1] !== "reveal") {
      // A download opens only while macOS's download mark is still on it.
      if (!(await (tools.marked || downloadMarked)(e.path))) return json(res, 409, { error: "This file lost the download mark macOS uses to protect you; show it in Finder instead." });
      if (rest[1] === "open-app") {
        if (!isDocument(e.path)) return json(res, 409, { error: "Open in Word is for documents (.doc, .docx, .rtf, .odt). Use Open." });
        const r = await tools.open(e.path, "open");
        return r?.ok ? json(res, 200, { ok: true, opened: "app" }) : json(res, 409, { error: "The file couldn't be shown: the system's opener didn't start." });
      }
      const way = openWay(e.path, { platform: tools.platform ?? process.platform, engine: tools.engine?.() ?? null, size: e.size,
        tab: typeof tools.openTab === "function", preview: typeof tools.preview === "function" });
      if (way === "tab") {
        const r = await tools.openTab(pathToFileURL(e.path).href);
        return r?.ok ? json(res, 200, { opened: "tab" }) : json(res, 409, { error: r?.error || "The file couldn't be shown in a tab." });
      }
      if (way === "text" || way === "document") {
        const p = await tools.preview(e, way);
        if (!p || p.error) return json(res, 409, { error: p?.error || "PairBrowse couldn't make a preview of this file." });
        const r = await tools.openTab(pathToFileURL(p.path).href, p.drop);
        if (!r?.ok) { try { p.drop(); } catch {} return json(res, 409, { error: r?.error || "The file couldn't be shown in a tab." }); }
        if (way === "document" && r.page && typeof r.page === "object") previewOf.set(r.page, e.id);
        return json(res, 200, { opened: "preview" });
      }
      // With its app: a program, script or web page only after the person confirms ({ confirm: true },
      // the only field read).
      const confirm = confirmFor(e.path);
      if (confirm && parseJson(body)?.confirm !== true) return json(res, 428, { confirm });
    }
    // A download opened with its app says so ({ ok: true, opened: "app" }); Reveal and recordings: { ok: true }.
    const r = await tools.open(e.path, rest[1]);
    return r?.ok ? json(res, 200, isDownload && rest[1] === "open" ? { ok: true, opened: "app" } : { ok: true }) : json(res, 409, { error: "The file couldn't be shown: the system's opener didn't start." });
  }
  // What diagnostics.json answers: the helper's parts plus who is connected here.
  async function diagnosticsNow() {
    const { agents, ...d } = await tools.diagnostics.read();
    return { helper: d.helper, browser: d.browser, connections: { agents: agents || 0, viewers: viewers.size, joiners: joinersNow().length, streams: clients.size },
      joined: guests().map(({ label, role }) => ({ label, role })), errors: d.errors };
  }

  const routes = [
    // The Tools tab (the owner only): this session's downloads, the recordings this helper saved,
    // the hand-offs waiting for the person, and diagnostics. Files go by id (daemon/toolstab.mjs);
    // request bodies are capped and otherwise ignored (but a download's Open reads { confirm: true }),
    // so nothing in them names a file.
    { method: "GET", path: "downloads.json", right: "tools", needs: toolsOn, handler: ({ res }) => json(res, 200, { items: tools.downloads.list().map(maskedDownload) }) },
    { method: "POST", path: "downloads", right: "tools", needs: toolsOn, handler: (ctx) => fileAction(ctx, tools?.downloads, true) },
    { method: "GET", path: "recordings.json", right: "tools", needs: toolsOn, handler: ({ res }) => {
      const st = recordState() || {};
      json(res, 200, { recording: { on: !!st.recording, since: st.since || 0 }, items: tools.recordings.list() });
    } },
    { method: "POST", path: "recordings", right: "tools", needs: toolsOn, handler: (ctx) => fileAction(ctx, tools?.recordings, false) },
    { method: "DELETE", path: "recordings", right: "tools", needs: toolsOn, handler: async ({ req, res, rest }) => {
      if (rest.length !== 1 || !TOOL_ID.test(rest[0])) return plain(res, 404);
      if ((await readCapped(req, res, BODY_MAX.approve)) === null) return;
      const r = tools.recordings.remove(rest[0]);
      if (r?.ok) return json(res, 200, { ok: true });
      return r?.status === 410 ? json(res, 410, { error: FILE_CHANGED }) : plain(res, 404);
    } },
    { method: "GET", path: "handoffs.json", right: "tools", needs: toolsOn, handler: async ({ res }) => {
      json(res, 200, { items: await Promise.all(tools.handoffs.list().map(handoffItem)) });
    } },
    { method: "POST", path: "handoffs", right: "tools", needs: toolsOn, handler: async ({ req, res, rest }) => {
      if (rest.length !== 2 || !TOOL_ID.test(rest[0]) || rest[1] !== "show") return plain(res, 404);
      if ((await readCapped(req, res, BODY_MAX.approve)) === null) return;
      const h = tools.handoffs.entry(rest[0]);
      if (!h) return plain(res, 404);
      if (!h.page) return json(res, 409, { error: "This hand-off isn't about a tab, so there is nothing to show." });
      if (h.page.isClosed()) return json(res, 409, { error: "That tab is closed." });
      await within(3000, bringTabForward(h.page));
      json(res, 200, { ok: true });
    } },
    { method: "GET", path: "diagnostics.json", right: "tools", needs: toolsOn, handler: async ({ res }) => json(res, 200, await diagnosticsNow()) },
    { method: "POST", path: "diagnostics", right: "tools", needs: toolsOn, handler: async ({ req, res, rest }) => {
      if (rest.length !== 1 || rest[0] !== "report") return plain(res, 404);
      if ((await readCapped(req, res, BODY_MAX.approve)) === null) return;
      json(res, 200, { text: tools.diagnostics.reportText(await diagnosticsNow()) });
    } },
  ];
  return { routes, maskedDownload, handoffItem, toolsOn };
}
