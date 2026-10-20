// The pages' DOM basics: $ by id, el to build a node, the spark icon. Shared by the pages and the
// live view (common.js re-exports it; the live view serves it). A flat file at the ui/ root (the
// native build refuses a ui/<dir> without index.html); definitions only, nothing runs on import.
import { AGENT_MARKS } from "./vocab.js";

export const $ = (id) => document.getElementById(id);
export function el(tag, props = {}, ...kids) { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; }

// An agent's spark, as an icon: its app's mark (vocab.js AGENT_MARKS; Claude's spark by default)
// in currentColor.
export function sparkIcon(className, label = "", mark = "claude") {
  const m = AGENT_MARKS[mark] || AGENT_MARKS.claude;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", className);
  if (label) svg.setAttribute("aria-label", label);
  else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  if (m.f) path.setAttribute("fill", "currentColor");
  else for (const [k, v] of [["fill", "none"], ["stroke", "currentColor"], ["stroke-width", String(m.w)], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) path.setAttribute(k, v);
  path.setAttribute("d", m.f || m.s);
  svg.append(path);
  return svg;
}
