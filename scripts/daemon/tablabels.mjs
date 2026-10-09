// Who works in which tab, on the browser's own tab strip: the agent's name goes in front of the
// title of each tab it works in ("Claude (Mac) · Inbox", the page script: hud.js tab-name), next
// to its spark on the tab's icon. A tab the agent leaves gets its own title back.

const SETTLE_MS = 150;
const shownOn = new WeakMap(); // page -> the name in front of its title now

// A tab's own title, without the agent's name in front: what the session saves, the live view and
// joiners show (they name the agent themselves).
export async function ownTitle(page) {
  const title = await page.title().catch(() => "");
  const n = shownOn.get(page);
  return n && title.startsWith(`${n} · `) ? title.slice(n.length + 3) : title;
} // spark moves and actions in a burst become one update

// The name on the tab, short: an agent's own name ("Claude (Mac) · Claude Code" -> "Claude (Mac)"),
// else whose agent it is ("Ann · Claude Code" -> "Ann · Claude", "Ann · Codex" -> "Ann · Codex").
export function shortLabel(label) {
  const [who, app = ""] = String(label || "").split(" · ").map((x) => x.trim());
  if (!who) return "Agent";
  if (!app || /^(claude|codex|agent)\b/i.test(who)) return who.slice(0, 24);
  return `${who.slice(0, 14)} · ${app.split(" ")[0].slice(0, 8)}`;
}

// sparks(): [{ id, page }]. labelOf(id): the participant's label. lastIn(page): { who } of the last
// thing done in that tab. name(page, text): shows text in front of that tab's title ("" for none).
export function createTabLabels({ sparks, labelOf, lastIn = () => null, name, log = () => {} }) {
  let named = new Map(); // page -> the name it shows
  const everNamed = new Set(); // every name shown so far: a title read while a name went off still carries it
  let timer = null;
  let running = Promise.resolve();

  async function apply() {
    const next = new Map();
    const all = sparks().filter((s) => s.page && !s.page.isClosed());
    for (const { page } of all) {
      if (next.has(page)) continue;
      // One name per tab: the agent that acted there last (else the first there).
      const here = all.filter((s) => s.page === page);
      const last = lastIn(page)?.who;
      next.set(page, shortLabel(labelOf((here.find((s) => labelOf(s.id) === last) || here[0]).id)));
    }
    // Sent every time: a page that loaded anew has lost it.
    for (const [page, text] of next) { shownOn.set(page, text); everNamed.add(text); await name(page, text); }
    if (everNamed.size > 50) everNamed.delete(everNamed.values().next().value);
    for (const page of named.keys()) if (!next.has(page) && !page.isClosed()) { await name(page, ""); shownOn.delete(page); }
    const now = [...next.values()].join(", "), before = [...named.values()].join(", ");
    if (now !== before) log(`tab names: ${now || "none"}`);
    named = next;
  }

  // A spark moved or an agent acted: the names follow, one update at a time.
  function changed() {
    clearTimeout(timer);
    timer = setTimeout(() => { running = running.then(apply).catch((e) => log("tab names", e?.message || e)); }, SETTLE_MS);
    timer.unref?.();
  }

  // The page title with the agent's name taken off again: what agents read is the page's own.
  function strip(text) {
    let out = String(text);
    for (const n of new Set([...named.values(), ...everNamed])) {
      const esc = `${n} · `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(Page Title: |Page: |\\[)${esc}`, "g"), "$1");
    }
    return out;
  }

  return { changed, strip, apply: () => (running = running.then(apply)) };
}
