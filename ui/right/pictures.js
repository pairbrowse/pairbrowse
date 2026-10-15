// The right dock's Pictures tab: the picture last sent to the agent, fetched only while the tab is
// in front and the page is visible, held as a blob: URL until the next replaces it. Split from
// right.js; definitions only, nothing runs on import. base(): the helper's address (null: none).
import { $ } from "../dom.js";
import { clock } from "../words.js";

const PICTURE_ID = /^[0-9a-f]{12}$/;

export function createPictures({ base }) {
  const known = new Map(); // id -> card, from timeline.json and the timeline events (newest 50)
  let newest = null, shownId = null, pictureUrl = null, timelineKnown = false, timelineBusy = false, pictureSeq = 0;
  const picturesShown = () => !document.hidden && document.body.dataset.tab === "pictures" && !["rail", "hidden"].includes(document.documentElement.dataset.dock);
  const remember = (card) => {
    if (!card || !PICTURE_ID.test(card.id || "")) return;
    known.delete(card.id);
    known.set(card.id, card);
    if (known.size > 50) known.delete(known.keys().next().value);
  };
  async function showPictures() {
    if (!base() || !picturesShown()) return;
    if (!timelineKnown) {
      if (timelineBusy) return;
      timelineBusy = true;
      const from = base();
      // null: no timeline (404, timeline off); undefined: not reached, asked again next time.
      const r = await fetch(base() + "timeline.json", { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.json() : x.status === 404 ? null : undefined)).catch(() => undefined);
      timelineBusy = false;
      if (from !== base() || r === undefined) return;
      timelineKnown = true;
      const cards = Array.isArray(r?.cards) ? r.cards.filter((c) => c && c.note !== true && PICTURE_ID.test(c.id || "")) : [];
      for (const c of cards) remember(c);
      if (!newest && cards.length) newest = cards.reduce((a, b) => ((Number(b.t) || 0) >= (Number(a.t) || 0) ? b : a));
    }
    if (newest && newest.id !== shownId) drawPicture(newest);
  }
  function showCard(card) {
    if (!card || !PICTURE_ID.test(card.id || "")) return;
    newest = card;
    if (base() && picturesShown()) drawPicture(card);
  }
  async function drawPicture(card) {
    if (!picturesShown()) return;
    const seq = ++pictureSeq;
    const blob = await fetch(`${base()}timeline/${card.id}.jpg`, { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.blob() : null)).catch(() => null);
    if (seq !== pictureSeq || !blob) return;
    const url = URL.createObjectURL(blob);
    const img = $("picture-img");
    img.src = url;
    img.alt = card.caption || "Picture sent to the agent";
    const t = Number(card.t);
    const time = $("picture-time");
    time.textContent = Number.isFinite(t) && t > 0 ? clock(t) : "";
    if (Number.isFinite(t) && t > 0) time.dateTime = new Date(t).toISOString(); else time.removeAttribute("datetime");
    $("picture-caption").textContent = card.caption || "";
    if (pictureUrl) URL.revokeObjectURL(pictureUrl);
    pictureUrl = url;
    shownId = card.id;
    $("picture").hidden = false;
    $("pictures-empty").hidden = true;
  }

  // Another helper: nothing of the last one's pictures stays on screen as if current.
  function forgetPictures() {
    known.clear();
    newest = null;
    shownId = null;
    timelineKnown = false;
    pictureSeq++;
    if (pictureUrl) URL.revokeObjectURL(pictureUrl);
    pictureUrl = null;
    $("picture-img").removeAttribute("src");
    $("picture").hidden = true;
    $("pictures-empty").hidden = false;
  }

  // The helper's timeline event: a new card replaces the one shown; "show" brings one to the front
  // (front(): the Pictures tab to the front, which draws the newest itself; fetched once, and not
  // again for the card on screen). Notes carry no picture. "remove": the picture shown stays until
  // the next replaces it.
  function timeline(e, front) {
    if (e?.op === "add" && e.card && e.card.note !== true) { remember(e.card); showCard(e.card); }
    else if (e?.op === "show" && PICTURE_ID.test(e.id || "")) {
      const card = e.card || known.get(e.id) || { id: e.id, caption: "" };
      newest = card;
      if (document.body.dataset.tab !== "pictures") front();
      else if (shownId !== card.id) showCard(card);
    }
  }
  return { show: showPictures, forget: forgetPictures, timeline };
}
