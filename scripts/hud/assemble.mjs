// The page script's sources (scripts/hud/*.js): one script, kept in parts by what each draws or
// records. Each part is a run of lines of the one function the page runs; they mean nothing
// alone and are never loaded one by one. hudScript() (browser.mjs) joins them in this order,
// then puts in the random names; the ESLint config lints them joined the same way.
import { readFileSync } from "node:fs";

export const HUD_PARTS = [
  "head.js", // the opening, the random names and the key
  "recorder.js", // what you do in the page yourself (every frame)
  "fields.js", // changed and edited fields, claims; a frame's own entry
  "badge.js", // the status badge
  "spark.js", // the spark on the agent's tab icon
  "tabname.js", // the agent's name in front of the tab's title
  "bar.js", // the bottom bar
  "join.js", // a join request's card
  "approval.js", // an agent's named final click, the same card
  "cursor.js", // the agent's cursor and the outline of its field
  "pointers.js", // other people's and agents' pointers from a shared tab
  "status.js", // the entry the helper calls, the badge's text, and the closing
];

export const hudPart = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

// The parts joined, placeholders still in (the text before hudScript's names go in).
export const hudSource = () => HUD_PARTS.map(hudPart).join("");
