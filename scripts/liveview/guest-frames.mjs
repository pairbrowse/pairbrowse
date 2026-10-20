// What live view guests (invite links, "drive" or "watch") see of the host's tab: its pictures with
// card fields covered (daemon/covers.mjs). The owner's own frames go at once, as they are; each
// frame for guests waits for covers read after it came, several at once (IN_FLIGHT, past that a
// frame is dropped), and goes out in the order the frames came. A frame that can't be covered
// never goes to a guest.
import { within } from "../util.mjs";
import { sse } from "./http.mjs";
import { FRAME_SKIP_BYTES, STALLED_BYTES } from "../../ui/limits.js";

const IN_FLIGHT = 8;

// covers: { want(fn), picture(page, jpeg, at) } (createCoverLoop), or null: guests get the
// pictures as they are (a live view without a browser's helper, in tests). viewers, linkGuests:
// the live view's streams. shownPage(): the tab on screen. personTab(page): a person's own tab
// (never to guests).
export function createGuestFrames({ covers = null, viewers, linkGuests, shownPage, personTab }) {
  if (covers) covers.want(() => (linkGuests.size && shownPage() ? [shownPage()] : []));
  // A frame ({ img, w, h }) of page that came at `at` with its covers drawn on; null when they can't be.
  async function coverFrame(frame, page, at = Date.now()) {
    if (!covers || !frame) return frame;
    if (!page) return null;
    const img = await within(3000, Promise.resolve(covers.picture(page, frame.img, at)).catch(() => null));
    return img ? (img === frame.img ? frame : { ...frame, img }) : null;
  }
  const coverImage = async (page, data) => (await coverFrame({ img: data }, page))?.img || null;
  let chain = Promise.resolve(), inFlight = 0;
  function send(frame, page) {
    if (personTab(page) || inFlight >= IN_FLIGHT) return;
    inFlight++;
    const covering = coverFrame(frame, page).catch(() => null);
    chain = chain.then(async () => {
      const covered = await covering;
      if (!covered) return;
      const msg = sse("frame", covered);
      for (const res of viewers) {
        // A hand-off's own stream (role turn) gets its tabs' frames as they are (liveview/grants.mjs).
        if (!linkGuests.has(res) || linkGuests.get(res).role === "turn" || res.destroyed) continue;
        // A reader that stopped reading is cut, one far behind skips frames (as broadcast does).
        if (res.writableLength > STALLED_BYTES) { res.destroy(); continue; }
        if (res.writableLength > FRAME_SKIP_BYTES) continue;
        res.write(msg);
      }
    }).catch(() => {}).finally(() => { inFlight--; });
  }
  // Called for each frame broadcast: guests get it covered, if any guest watches.
  const frame = (data, page) => { if ([...viewers].some((res) => linkGuests.has(res))) send(data, page); };
  return { frame, coverFrame, coverImage };
}
