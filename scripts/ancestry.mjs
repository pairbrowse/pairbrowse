// The processes a process runs under (its parent, the parent's parent...). The PairBrowse hook
// and the browser bridge of the same Claude Code session share an ancestor (that session), so the
// helper can tell which agent a hook's question is about. Standard library only.
import { execFileSync } from "node:child_process";

const DEPTH = 6;

// [parent, grandparent, ...] of pid, at most DEPTH, without pid 1. Only the parent where ps
// isn't there (Windows).
export function ancestors(pid = process.pid) {
  const out = [];
  let table = null;
  if (process.platform !== "win32") {
    try {
      table = new Map(execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 1500 })
        .trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter(([a, b]) => a > 0 && b >= 0));
    } catch {}
  }
  let at = pid === process.pid ? process.ppid : table?.get(pid);
  while (at > 1 && out.length < DEPTH && !out.includes(at)) {
    out.push(at);
    at = table?.get(at);
  }
  return out;
}

// How closely two chains are related: the index in mine of the first process also in theirs
// (lower is closer), or -1 when they share none.
export function kinship(mine, theirs) {
  const set = new Set((Array.isArray(theirs) ? theirs : []).map(Number));
  return (Array.isArray(mine) ? mine : []).findIndex((p) => set.has(Number(p)));
}
