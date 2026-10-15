// People and agents as the pages show them: "Name · App", initials, the ink on a color, the
// avatar. Shared by the pages and the live view (common.js re-exports it; the live view serves it).
// A flat file at the ui/ root; definitions only, nothing runs on import.
import { isColor } from "./vocab.js";
import { el } from "./dom.js";

// Participants as the side panel shows them: a color only when it is a plain #rrggbb (board
// colors cross from other computers), "Name · App" split in two, and a round avatar with the
// name's initial and the name as its accessible name.
export const splitLabel = (who) => { const [name, app] = String(who || "").split(" · "); return { name: name || "", app: app || "" }; };
export const initialOf = (name) => (String(name || "").trim()[0] || "?").toUpperCase();
// The ink for text on a #rrggbb fill: white or the sheet's dark ink (--bg), whichever has the higher
// WCAG contrast on it (DESIGN.md B11). Every participant color takes the dark ink; a dark fill white.
export const INK_LIGHT = "#FFFFFF", INK_DARK = "#0B1421";
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function inkOn(color) {
  if (!isColor(color)) return INK_DARK;
  const l = luminance(color);
  const light = 1.05 / (l + 0.05), dark = (l + 0.05) / (luminance(INK_DARK) + 0.05);
  return light > dark ? INK_LIGHT : INK_DARK;
}
// decorative: beside the name in words (a row, a card): hidden from assistive tech, no role, label
// or tooltip of its own.
export function avatar(name, color, { tag = "span", decorative = false } = {}) {
  const a = el(tag, { className: "avatar", textContent: initialOf(name) });
  if (decorative) a.setAttribute("aria-hidden", "true");
  else {
    a.title = String(name || "");
    a.setAttribute("role", "img");
    a.setAttribute("aria-label", String(name || ""));
  }
  if (isColor(color)) { a.style.background = color; a.style.color = inkOn(color); }
  else a.classList.add("plain");
  return a;
}
