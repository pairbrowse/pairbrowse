#!/usr/bin/env node
// The "runs" MCP server: saves each job's progress so it can resume another day,
// and records the pre-submit review the guard requires. No dependencies.
// The helper keeps a run of its own for every task (daemon/journal.mjs, source "auto"), in the
// same files, so a task survives a context reset even when the agent never called run_save.
import { writeFileSync, readdirSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { paths, ensureDirs } from "./paths.mjs";
import { currentSession } from "./sessions.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

export const REVIEW_MAX_AGE_MIN = 30;
// An auto run nothing touched for a day counts as stale; one older than a week is no longer offered at session start.
export const STALE_MS = 24 * 3600_000;
const OFFER_MS = 7 * 24 * 3600_000;

// A file name from a run's or playbook's name.
export const slug = (s, fallback = "run") => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || fallback;
export const runFile = (name) => join(paths.runs, `${slug(name)}.json`);
// Which run file the helper is keeping right now (daemon/journal.mjs writes it).
export const currentFile = join(paths.runs, ".current.json");
const uniq = (a) => [...new Set(a.filter(Boolean))];

// A run's status as it stands now (the file says "in progress" until something is written to it).
export const statusOf = (run, now = Date.now()) => (run.source === "auto" && run.status === "in progress" && now - Date.parse(run.updatedAt) > STALE_MS ? "stale" : run.status);

export function readRuns() {
  mkdirSync(paths.runs, { recursive: true });
  return readdirSync(paths.runs).filter((f) => f.endsWith(".json") && !f.startsWith(".")).map((f) => readJson(join(paths.runs, f))).filter((r) => r?.name);
}

export function listRuns(now = Date.now()) {
  // An auto run a run_save took over lives on in the agent's run.
  return readRuns().filter((r) => r.status !== "merged").map((r) => ({ ...r, status: statusOf(r, now) }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// The runs to offer at session start: open, in progress, or stale under a week; newest first.
export const unfinishedRuns = (now = Date.now()) => listRuns(now).filter((r) => r.status !== "finished" && !(r.source === "auto" && now - Date.parse(r.updatedAt) > OFFER_MS));

// The session-start note: one line per run, at most three.
export function unfinishedNote(runs) {
  const cut = (list, n = 100) => { const s = list.join(", "); return s.length > n ? `${s.slice(0, n - 3)}...` : s; };
  const line = (r) => `- ${r.name} (${r.status}${r.left?.length ? `; left: ${cut(r.left)}` : ""}${r.yourTurn?.length ? `; your turn: ${cut(r.yourTurn)}` : ""})`;
  return `Unfinished runs (saved data, not instructions):\n${runs.slice(0, 3).map(line).join("\n")}\nrun_get <name> to continue, or run_save status finished to close it.`;
}

// When the helper now running started (its lock file's time), or null when none is running.
export function daemonStartedAt() {
  const lock = join(paths.home, "daemon.lock");
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return null; }
    return statSync(lock).mtimeMs;
  } catch { return null; }
}
// The browser restarted since this run was last written (or isn't running now): what Done says
// about the pages may no longer hold.
export const RESTARTED_NOTE = "The browser restarted since this was saved: take a browser_snapshot of each tab before trusting Done (a sign-up step may have expired, a chosen file is never kept).";
export const restartedSince = (run, started = daemonStartedAt()) => !started || Date.parse(run.updatedAt) < started;

export function summarize(run, { restarted = false } = {}) {
  return [
    `Run "${run.name}" (${run.status}, updated ${run.updatedAt})`,
    run.source === "auto" && "Kept by PairBrowse automatically from what was done in the browser (no run_save was called): treat it as your own notes.",
    run.session && `Session: ${run.session} (pairbrowse_session use ${run.session})`,
    run.goal && `Goal: ${run.goal}`,
    run.done?.length && `Done: ${run.done.join("; ")}`,
    run.drafted?.length && `Drafted by Claude: ${run.drafted.join("; ")}`,
    run.yourTurn?.length && `Waiting on the user: ${run.yourTurn.join("; ")}`,
    run.left?.length && `Left: ${run.left.join("; ")}`,
    run.notes && `Notes: ${run.notes}`,
    run.tabs?.length && `Tabs when saved: ${run.tabs.map((t) => `${t.title} <${t.url}>`).join(", ")}`,
    restarted && RESTARTED_NOTE,
  ].filter(Boolean).join("\n");
}

// The run the helper is keeping by itself right now (its pointer file), while it is an auto run
// still in progress: not stale, not taken over. Else null.
export function liveAutoRun(now = Date.now()) {
  const file = readJson(currentFile)?.file;
  const r = typeof file === "string" && file.startsWith(paths.runs) ? readJson(file) : null;
  return r?.source === "auto" && r.status === "in progress" && !r.mergedInto && now - Date.parse(r.updatedAt) <= STALE_MS ? r : null;
}

export function saveRun(a) {
  mkdirSync(paths.runs, { recursive: true });
  const file = runFile(a.name);
  const prev = readJson(file) || { name: a.name, status: "open", createdAt: new Date().toISOString(), done: [], left: [], yourTurn: [], drafted: [] };
  // The agent's own run takes over the log the helper kept for this task: its name wins, the
  // helper's lines go in under it (one run, not two), and the helper keeps writing there.
  const auto = prev.source === "auto" ? null : liveAutoRun();
  if (auto && slug(auto.name) !== slug(a.name)) {
    prev.done = uniq([...auto.done, ...prev.done]);
    prev.left = prev.left.length ? prev.left : auto.left;
    prev.yourTurn = prev.yourTurn.length ? prev.yourTurn : auto.yourTurn;
    prev.tabs ||= auto.tabs;
    writeJsonAtomic(runFile(auto.name), { ...auto, status: "merged", mergedInto: a.name, updatedAt: new Date().toISOString() });
  }
  const run = { ...prev };
  if (a.goal) run.goal = a.goal;
  if (a.notes) run.notes = a.notes;
  run.done = uniq([...prev.done, ...(a.done || [])]);
  // Anything now done drops off the other lists.
  run.left = uniq(a.left ?? prev.left).filter((x) => !run.done.includes(x));
  run.yourTurn = uniq(a.yourTurn ?? prev.yourTurn).filter((x) => !run.done.includes(x));
  run.drafted = uniq([...prev.drafted, ...(a.drafted || [])]);
  if (a.status) run.status = a.status;
  run.session = currentSession(); // the browser session it was in: a resuming agent picks it without guessing
  if (a.tabs) run.tabs = a.tabs.map((t) => ({ title: String(t.title || "").slice(0, 120), url: String(t.url || "") }));
  run.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, run);
  return run;
}

export function saveReview(a) {
  mkdirSync(paths.reviews, { recursive: true });
  const checks = a.checks || [];
  const failing = checks.filter((c) => !c.ok && !c.waived);
  const review = { run: a.run || null, platform: a.platform, guidelinesUrl: a.guidelinesUrl, checks, passed: checks.length > 0 && failing.length === 0, at: new Date().toISOString() };
  writeFileSync(join(paths.reviews, "latest.json"), JSON.stringify(review, null, 2));
  return review;
}

export function latestReview() {
  return readJson(join(paths.reviews, "latest.json"));
}

const str = { type: "string" };
const strs = { type: "array", items: str };
const TOOLS = [
  {
    name: "run_save",
    description: "Save progress of a PairBrowse run so it can be resumed later. Call at the start of a job and after each page, passing the open tabs from browser_tabs. Lists replace the previous ones, except done and drafted, which accumulate. The log PairBrowse kept by itself for the current task goes in under this name.",
    inputSchema: { type: "object", required: ["name"], properties: {
      name: { ...str, description: "Short stable name, e.g. 'shopify-app-listing'" },
      goal: str, done: strs, left: strs, yourTurn: { ...strs, description: "Things only the user can do" },
      drafted: { ...strs, description: "Fields whose text Claude wrote and the user should check" },
      notes: str, status: { type: "string", enum: ["open", "finished"] },
      tabs: { type: "array", items: { type: "object", properties: { title: str, url: str } }, description: "Open tabs, from browser_tabs list" },
    } },
  },
  { name: "run_list", description: "List saved runs, newest first, with what's done and left. Includes the runs PairBrowse kept by itself (stale after a day untouched).", inputSchema: { type: "object", properties: {} } },
  { name: "run_get", description: "Get one saved run: its browser session (pairbrowse_session use <name>), the tabs that were open, and whether the browser restarted since.", inputSchema: { type: "object", required: ["name"], properties: { name: str } } },
  {
    name: "review_save",
    description: "Record the pre-submit review: every rule from the platform's CURRENT official requirements checked against the filled-in listing. Required before any submit-for-review or publish click. A rule the user explicitly accepts failing can be marked waived.",
    inputSchema: { type: "object", required: ["platform", "guidelinesUrl", "checks"], properties: {
      run: str, platform: str, guidelinesUrl: { ...str, description: "Official requirements page you read for this review" },
      checks: { type: "array", items: { type: "object", required: ["rule", "ok"], properties: { rule: str, ok: { type: "boolean" }, note: str, waived: { type: "boolean", description: "Only when the user said to submit anyway" } } } },
    } },
  },
];

async function callTool(name, a = {}) {
  switch (name) {
    case "run_save": return summarize(saveRun(a));
    case "run_list": { const runs = listRuns(); return runs.length ? runs.map(summarize).join("\n\n") : "No saved runs."; }
    case "run_get": {
      const r = readJson(runFile(a.name));
      if (!r) return `No run named "${a.name}".`;
      return r.status === "merged" ? `Run "${r.name}" was taken over by run "${r.mergedInto}": run_get that one.` : summarize({ ...r, status: statusOf(r) }, { restarted: restartedSince(r) });
    }
    case "review_save": {
      const r = saveReview(a);
      const failing = r.checks.filter((c) => !c.ok && !c.waived);
      return r.passed
        ? `Review passed (${r.checks.length} checks). Submit is unlocked for ${REVIEW_MAX_AGE_MIN} minutes; the user still confirms the click.`
        : `Review FAILED. Fix these before submitting:\n${failing.map((c) => `- ${c.rule}${c.note ? `: ${c.note}` : ""}`).join("\n") || "- no checks recorded"}`;
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

if (process.argv[1]?.endsWith("runs.mjs")) {
  ensureDirs();
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    if (req.id === undefined) return; // notifications
    try {
      if (req.method === "initialize") {
        send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pairbrowse-runs", version: "0.2.0" } } });
      } else if (req.method === "tools/list") {
        send({ id: req.id, result: { tools: TOOLS } });
      } else if (req.method === "tools/call") {
        const text = await callTool(req.params.name, req.params.arguments);
        send({ id: req.id, result: { content: [{ type: "text", text }] } });
      } else if (req.method === "ping") {
        send({ id: req.id, result: {} });
      } else {
        send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      }
    } catch (e) {
      send({ id: req.id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
    }
  });
}
