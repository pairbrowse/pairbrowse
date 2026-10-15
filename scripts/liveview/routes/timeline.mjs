// The timeline's routes on the owner's port (the owner only): the session's pictures already sent
// to agents (daemon/timeline.mjs), their cards, notes and pins. startLiveView mounts them.
import { json, plain, readJsonBody, BODY_MAX, SECURITY_HEADERS } from "../http.mjs";

const TIMELINE_ID = /^[0-9a-f]{12}$/;
const TIMELINE_OFF = "The timeline is off (timeline: false in ~/.pairbrowse/config.json).";

// timeline: the session's pictures, or null. mask(text): as results are masked. broadcast(event,
// data): to the live view's streams. Returns the routes and maskedCard (the timeline's events use it).
export function createTimelineRoutes({ timeline, mask, broadcast }) {
  // The timeline's routes: 404 without a store, 404 with a plain sentence when it's switched off.
  function timelineOn() { return !timeline ? false : timeline.enabled ? true : TIMELINE_OFF; }
  const maskedCard = (c) => ({ ...c, caption: mask(String(c.caption || "")) });

  const routes = [
    { method: "GET", path: "timeline.json", right: "timeline", needs: timelineOn, handler: ({ res }) => {
      json(res, 200, { cards: (timeline.cards() || []).map(maskedCard) });
    } },
    { method: "GET", path: "timeline", right: "timeline", needs: timelineOn, handler: async ({ res, rest }) => {
      const m = rest.length === 1 ? /^([0-9a-f]{12})\.jpg$/.exec(rest[0]) : null;
      const bytes = m ? await timeline.picture(m[1]) : null;
      if (!bytes) return plain(res, 404);
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/jpeg" });
      res.end(bytes);
    } },
    { method: "DELETE", path: "timeline", right: "timeline", needs: timelineOn, handler: async ({ res, rest }) => {
      if (rest.length !== 1 || !TIMELINE_ID.test(rest[0])) return plain(res, 404);
      return (await timeline.remove(rest[0])) === true ? json(res, 200, { ok: true }) : plain(res, 404);
    } },
    // note, <id>/pin, and <id>/show: the Pictures tab shows that card (an event to the owner's
    // streams with the card; nothing new kept).
    { method: "POST", path: "timeline", right: "timeline", needs: timelineOn, handler: async ({ req, res, rest }) => {
      const isNote = rest.length === 1 && rest[0] === "note";
      const isPin = rest.length === 2 && TIMELINE_ID.test(rest[0]) && rest[1] === "pin";
      const isShow = rest.length === 2 && TIMELINE_ID.test(rest[0]) && rest[1] === "show";
      if (!isNote && !isPin && !isShow) return plain(res, 404);
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (isShow) {
        const card = (timeline.cards() || []).find((c) => c.id === rest[0]);
        if (!card) return plain(res, 404);
        if (card.note === true) return json(res, 409, { error: "That card is a note; it has no picture to show. Read its text instead." });
        broadcast("timeline", { op: "show", id: card.id, card: maskedCard(card) });
        return json(res, 200, { ok: true });
      }
      const r = isNote ? await timeline.note(typeof op?.text === "string" ? op.text : "") : await timeline.pin(rest[0], op?.on !== false);
      if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work. Try again." });
      json(res, 200, maskedCard(r));
    } },
  ];
  return { routes, maskedCard };
}
