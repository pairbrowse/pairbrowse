#!/usr/bin/env node
// PostToolUse hook: appends a plain-English line per browser action to ~/.pairbrowse/log/<date>-<session>.md.
// Values typed from secrets.env appear only as their names, never as the secret; card numbers,
// codes and similar fields are masked.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { shownValue, BROWSER_PREFIX } from "./policy.mjs";

export function describe(tool, ti = {}) {
  switch (tool) {
    case "browser_navigate": return `Opened ${ti.url}`;
    case "browser_fill_form": return "Filled " + (ti.fields || []).map((f) => `**${f.name}** = ${short(shownValue(f.name, f.value))}`).join(", ");
    case "browser_type": return `Typed ${short(shownValue(ti.element || ti.target, ti.text))} into **${ti.element || ti.target}**${ti.submit ? " and pressed Enter" : ""}`;
    case "browser_select_option": return `Chose ${[].concat(ti.values ?? []).map(String).join(", ")} in **${ti.element || ti.target}**`;
    case "browser_click": return `Clicked **${ti.element || ti.target}**`;
    case "browser_drag": return `Dragged **${ti.startElement || ti.startTarget}** to **${ti.endElement || ti.endTarget}**`;
    case "browser_file_upload": return `Uploaded ${(ti.paths || []).map((p) => p.split(/[\\/]/).pop()).join(", ") || "nothing (cancelled)"}`;
    case "browser_tabs": return ti.action === "list" ? null : `Tab ${ti.action}${ti.url ? ` ${ti.url}` : ""}${ti.index !== undefined ? ` #${ti.index}` : ""}`;
    case "browser_handle_dialog": return `${ti.accept ? "Accepted" : "Dismissed"} a browser dialog`;
    case "browser_press_key": return `Pressed ${ti.key}`;
    default: return null; // read-only tools (snapshot, find, wait) are not logged
  }
}

function short(v) {
  const s = String(v ?? "");
  return "`" + (s.length > 80 ? s.slice(0, 77) + "..." : s) + "`";
}

if (process.argv[1]?.endsWith("log.mjs")) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw);
      if (!BROWSER_PREFIX.test(String(input.tool_name || ""))) return;
      const tool = input.tool_name.replace(BROWSER_PREFIX, "");
      const line = describe(tool, input.tool_input);
      if (!line) return;
      mkdirSync(paths.log, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const file = join(paths.log, `${day}-${String(input.session_id || "session").slice(0, 8)}.md`);
      try { writeFileSync(file, `# PairBrowse run ${day}\n\n`, { flag: "wx" }); } catch {} // the heading, once: wx fails when the file exists
      appendFileSync(file, `- ${new Date().toTimeString().slice(0, 8)} ${line}\n`);
    } catch {
      // Logging must never block the session.
    }
  });
}
