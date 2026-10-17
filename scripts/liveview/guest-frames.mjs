// What live view guests (invite links, "drive" or "watch") see of the host's tab: its pictures with
// card fields covered (daemon/covers.mjs). The owner's own frames go at once, as they are; each
// frame for guests is covered first, one at a time, the newest waiting (those in between are
// dropped). A frame that can't be covered never goes to a guest.
import { within } from "../util.mjs";
import { sse } from "./http.mjs";
import { FRAME_SKIP_BYTES, STALLED_BYTES } from "../../ui/limits.js";

// covers: { want(fn), picture(page, jpeg) } (createCoverLoop), or null: guests get the pictures as
// they are (a live view without a browser's helper, in tests). viewers, linkGuests: the live
// view's streams. shownPage(): the tab on screen. personTab(page): a person's own tab (never to guests).
export function createGuestFrames({ covers = null, viewers, linkGuests, shownPage, personTab }) {
  if (covers) covers.want(() => (linkGuests.size && shownPage() ? [shownPage()] : []));
  // A frame ({ img, w, h }) of page with its covers drawn on; null when they can't be.
  async function coverFrame(frame, page) {
    if (!covers || !frame) return frame;
    if (!page) return null;
    const img = await within(3000, Promise.resolve(covers.picture(page, frame.img)).catch(() => null));
    return img ? (img === frame.img ? frame : { ...frame, img }) : null;
  }
  const coverImage = async (page, data) => (await coverFrame({ img: data }, page))?.img || null;
  let busy = false, next = null;
  async function send(frame, page) {
    if (busy) { next = { frame, page }; return; }
    busy = true;
    try {
      for (let job = { frame, page }; job; job = next, next = null) {
        if (personTab(job.page)) continue;
        const covered = await coverFrame(job.frame, job.page);
        if (!covered) continue;
        const msg = sse("frame", covered);
        for (const res of viewers) {
          if (!linkGuests.has(res) || res.destroyed) continue;
          // A reader that stopped reading is cut, one far behind skips frames (as broadcast does).
          if (res.writableLength > STALLED_BYTES) { res.destroy(); continue; }
          if (res.writableLength > FRAME_SKIP_BYTES) continue;
          res.write(msg);
        }
      }
    } finally { busy = false; }
  }
  // Called for each frame broadcast: guests get it covered, if any guest watches.
  const frame = (data, page) => { if ([...viewers].some((res) => linkGuests.has(res))) send(data, page).catch(() => {}); };
  return { frame, coverFrame, coverImage };
}
