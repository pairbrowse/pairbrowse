#!/usr/bin/env node
// The "runs" MCP server: saves each job's progress so it can resume another day,
// and records the pre-submit review the guard requires. No dependencies.
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { paths, ensureDirs } from "./paths.mjs";
import { readJson } from "./util.mjs";

export const REVIEW_MAX_AGE_MIN = 30;

// A file name from a run's or playbook's name.
export const slug = (s, fallback = "run") => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || fallback;
const runFile = (name) => join(paths.runs, `${slug(name)}.json`);
const uniq = (a) => [...new Set(a.filter(Boolean))];

export function listRuns() {
  mkdirSync(paths.runs, { recursive: true });
  return readdirSync(paths.runs).filter((f) => f.endsWith(".json")).map((f) => readJson(join(paths.runs, f))).filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function summarize(run) {
  return [
    `Run "${run.name}" (${run.status}, updated ${run.updatedAt})`,
    run.goal && `Goal: ${run.goal}`,
    run.done?.length && `Done: ${run.done.join("; ")}`,
    run.drafted?.length && `Drafted by Claude: ${run.drafted.join("; ")}`,
    run.yourTurn?.length && `Waiting on the user: ${run.yourTurn.join("; ")}`,
    run.left?.length && `Left: ${run.left.join("; ")}`,
    run.notes && `Notes: ${run.notes}`,
    run.tabs?.length && `Tabs when saved: ${run.tabs.map((t) => `${t.title} <${t.url}>`).join(", ")}`,
  ].filter(Boolean).join("\n");
}

export function saveRun(a) {
  mkdirSync(paths.runs, { recursive: true });
  const prev = readJson(runFile(a.name)) || { name: a.name, status: "open", createdAt: new Date().toISOString(), done: [], left: [], yourTurn: [], drafted: [] };
  const run = { ...prev };
  if (a.goal) run.goal = a.goal;
  if (a.notes) run.notes = a.notes;
  run.done = uniq([...prev.done, ...(a.done || [])]);
  // Anything now done drops off the other lists.
  run.left = uniq(a.left ?? prev.left).filter((x) => !run.done.includes(x));
  run.yourTurn = uniq(a.yourTurn ?? prev.yourTurn).filter((x) => !run.done.includes(x));
  run.drafted = uniq([...prev.drafted, ...(a.drafted || [])]);
  if (a.status) run.status = a.status;
  if (a.tabs) run.tabs = a.tabs.map((t) => ({ title: String(t.title || "").slice(0, 120), url: String(t.url || "") }));
  run.updatedAt = new Date().toISOString();
  writeFileSync(runFile(a.name), JSON.stringify(run, null, 2));
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
    description: "Save progress of a PairBrowse run so it can be resumed later. Call at the start of a job and after each page, passing the open tabs from browser_tabs. Lists replace the previous ones, except done and drafted, which accumulate.",
    inputSchema: { type: "object", required: ["name"], properties: {
      name: { ...str, description: "Short stable name, e.g. 'shopify-app-listing'" },
      goal: str, done: strs, left: strs, yourTurn: { ...strs, description: "Things only the user can do" },
      drafted: { ...strs, description: "Fields whose text Claude wrote and the user should check" },
      notes: str, status: { type: "string", enum: ["open", "finished"] },
      tabs: { type: "array", items: { type: "object", properties: { title: str, url: str } }, description: "Open tabs, from browser_tabs list" },
    } },
  },
  { name: "run_list", description: "List saved runs, newest first, with what's done and left.", inputSchema: { type: "object", properties: {} } },
  { name: "run_get", description: "Get one saved run, including the tabs that were open.", inputSchema: { type: "object", required: ["name"], properties: { name: str } } },
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
    case "run_get": { const r = readJson(runFile(a.name)); return r ? summarize(r) : `No run named "${a.name}".`; }
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
