// The session's timeline: the pictures the helper already sent to agents (the same 820 px JPEG a
// result carried), kept per browser session in its timeline folder (sessions.mjs timelineDir)
// with an index of cards. Nothing is captured or encoded for it: serve.mjs hands over a picture
// after the result went out. At most `cap` unpinned cards, the oldest dropped first, plus at
// most `pinMax` pinned ones. Notes are cards without a picture. Deleted with the session; `timeline: false`
// in config keeps none. Read only by the owner's live view routes (liveview.mjs). `enabled` and `cap`
// may be functions, read at each call: a change in Settings takes effect at once.
import { mkdir, writeFile, rename, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ID = /^[0-9a-f]{12}$/;
const CAPTION_MAX = 120;
const NOTE_MAX = 200;
const OFF = { error: "The timeline is off (timeline: false in ~/.pairbrowse/config.json)." };

// Runs tasks one at a time, in order; a failed task doesn't stop the next.
function serially() {
  let last = Promise.resolve();
  return (task) => {
    const run = last.then(task);
    last = run.catch(() => {});
    return run;
  };
}

const text = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// A card as read from the index: only the known fields, each checked.
function cardFrom(c) {
  if (!c || typeof c !== "object" || !ID.test(c.id)) return null;
  const step = c.step && typeof c.step === "object" ? { url: text(c.step.url, 200), title: text(c.step.title, CAPTION_MAX) } : null;
  return { id: c.id, t: Number(c.t) || 0, caption: text(c.caption, NOTE_MAX), step, who: text(c.who, 60), pinned: c.pinned === true, note: c.note === true };
}

// dir(): the current session's timeline folder. mask(text): as results are masked. step(): the
// goal log's current page ({ url, title }) or null. onNote(text): a note was added (the bar); text is the masked, trimmed note, never the raw one.
export function createTimeline({ dir, enabled = true, mask = (t) => t, step = () => null, onNote = () => {}, log = () => {}, now = () => Date.now(), cap = 200, pinMax = 50 } = {}) {
  const dirOf = typeof dir === "function" ? dir : () => dir;
  const isOn = () => (typeof enabled === "function" ? !!enabled() : enabled !== false);
  const capNow = () => Math.min(200, Math.max(1, Number(typeof cap === "function" ? cap() : cap) || 200)); // 1 to 200, whatever config.json says
  const queue = serially(); // every write, in order
  const listeners = new Set();
  let loadedFor = null;
  let cards = []; // newest last

  // The folder's index, read once per folder (a session switch reads the other one).
  function load() {
    const d = dirOf();
    if (d === loadedFor) return d;
    loadedFor = d;
    cards = [];
    let raw;
    try { raw = readFileSync(join(d, "index.json"), "utf8"); } catch { return d; } // none yet
    try {
      const list = JSON.parse(raw)?.cards;
      cards = (Array.isArray(list) ? list : []).map(cardFrom).filter(Boolean);
    } catch (e) {
      log("timeline", `index unreadable, starting empty: ${e?.message || e}`);
    }
    return d;
  }
  const changed = (op, card) => { for (const fn of listeners) { try { fn({ op, card: { ...card } }); } catch {} } };
  async function save(d) {
    await mkdir(d, { recursive: true });
    const file = join(d, "index.json");
    await writeFile(`${file}.tmp`, JSON.stringify({ cards }));
    await rename(`${file}.tmp`, file);
  }
  const newId = () => { let id; do id = randomBytes(6).toString("hex"); while (cards.some((c) => c.id === id)); return id; };
  const stepNow = () => {
    let s = null;
    try { s = step(); } catch {}
    return s && typeof s === "object" ? { url: text(mask(String(s.url || "")), 200), title: text(mask(String(s.title || "")), CAPTION_MAX) } : null;
  };
  // Oldest unpinned first, until `cap` unpinned cards are left (pinned ones come on top of that,
  // at most pinMax of them).
  async function trim(d) {
    while (cards.filter((c) => !c.pinned).length > capNow()) {
      const [gone] = cards.splice(cards.findIndex((c) => !c.pinned), 1);
      if (!gone.note) await rm(join(d, `${gone.id}.jpg`), { force: true });
    }
  }

  return {
    get enabled() { return isOn(); },
    // A picture already sent (base64 JPEG): its file and card. Never throws.
    record({ data, caption = "", who = "" } = {}) {
      if (!isOn() || !data) return Promise.resolve();
      return queue(async () => {
        const d = load();
        const card = { id: newId(), t: now(), caption: text(mask(String(caption)), CAPTION_MAX), step: stepNow(), who: text(who, 60), pinned: false, note: false };
        await mkdir(d, { recursive: true });
        await writeFile(join(d, `${card.id}.jpg`), Buffer.from(data, "base64"));
        cards.push(card);
        await trim(d);
        await save(d);
        changed("add", card);
      }).catch((e) => log("timeline", e?.message || e));
    },
    cards() {
      if (!isOn()) return null;
      load();
      return cards.map((c) => ({ ...c, step: c.step ? { ...c.step } : null }));
    },
    // The picture's bytes, or null (unknown id, a note, timeline off).
    async picture(id) {
      if (!isOn() || !ID.test(String(id))) return null;
      const d = load();
      const card = cards.find((c) => c.id === id);
      if (!card || card.note) return null;
      try { return await readFile(join(d, `${id}.jpg`)); } catch { return null; }
    },
    remove(id) {
      if (!isOn()) return Promise.resolve({ ...OFF });
      if (!ID.test(String(id))) return Promise.resolve(false);
      return queue(async () => {
        const d = load();
        const i = cards.findIndex((c) => c.id === id);
        if (i < 0) return false;
        const [gone] = cards.splice(i, 1);
        if (!gone.note) await rm(join(d, `${id}.jpg`), { force: true });
        await save(d);
        changed("remove", gone);
        return true;
      });
    },
    pin(id, on = true) {
      if (!isOn()) return Promise.resolve({ ...OFF });
      if (!ID.test(String(id))) return Promise.resolve({ error: "No such picture." });
      return queue(async () => {
        const d = load();
        const card = cards.find((c) => c.id === id);
        if (!card) return { error: "No such picture." };
        if (on && !card.pinned && cards.filter((c) => c.pinned).length >= pinMax) return { error: `At most ${pinMax} pinned pictures; unpin one first.` };
        card.pinned = !!on;
        await save(d);
        changed("pin", card);
        return { ...card };
      });
    },
    note(given) {
      if (!isOn()) return Promise.resolve({ ...OFF });
      const said = String(given ?? "").trim();
      if (!said || said.length > NOTE_MAX) return Promise.resolve({ error: `A note is 1 to ${NOTE_MAX} characters.` });
      return queue(async () => {
        const d = load();
        const card = { id: newId(), t: now(), caption: text(mask(said), NOTE_MAX), step: stepNow(), who: "", pinned: false, note: true };
        cards.push(card);
        await trim(d);
        await save(d);
        try { onNote(card.caption); } catch {}
        changed("add", card);
        return { ...card };
      });
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
