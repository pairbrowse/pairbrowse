// The pages' DOM basics: $ by id, el to build a node, the spark icon. Shared by the pages and the
// live view (common.js re-exports it; the live view serves it). A flat file at the ui/ root (the
// native build refuses a ui/<dir> without index.html); definitions only, nothing runs on import.
export const $ = (id) => document.getElementById(id);
export function el(tag, props = {}, ...kids) { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; }

// Claude's orange spark, as an icon.
const SPARK = "M8 0.8c.5 0 .8.4.9.9l.5 4 3.3-2.3c.4-.3 1-.2 1.3.2.3.4.2 1-.2 1.3L10.6 7.3l4 .6c.5.1.9.5.8 1-.1.5-.5.8-1 .7l-4-.5 2.3 3.3c.3.4.2 1-.2 1.3-.4.3-1 .2-1.3-.2L8.9 10.2l-.5 4c-.1.5-.5.9-1 .8-.5 0-.8-.5-.8-1l.6-4-3.3 2.3c-.4.3-1 .2-1.3-.2-.3-.4-.2-1 .2-1.3l3.2-2.4-4-.5c-.5-.1-.9-.5-.8-1 .1-.5.5-.8 1-.8l4 .6L3.9 3.5c-.3-.4-.2-1 .2-1.3.4-.3 1-.2 1.3.2l2.4 3.3.5-4c0-.5.4-.9.9-.9Z";
export function sparkIcon(className, label = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", className);
  if (label) svg.setAttribute("aria-label", label);
  else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", SPARK);
  svg.append(path);
  return svg;
}
