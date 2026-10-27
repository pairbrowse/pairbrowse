// Zoom on this device only, for the phone viewers on the public address (a hand-off's,
// liveview-turn.js, and a watch link's, liveview-watch.js): the picture (box: it and what is drawn
// over it) scaled 1x to max inside stage, and moved; the page itself never changes size. state:
// { z, tx, ty } as it stands now. at(z, cx, cy, from?, to?): zoom to z keeping the picture point
// under (cx, cy) on screen in place (a pinch passes where it started, from, and where its middle is
// now, to). apply(): the picture kept inside the stage (after a resize). middle(): the stage's
// middle, for the + and - buttons. show(z, ux, uy): zoom to z centered on a picture point (the hand-off
// viewer's first zoom to the part of the tab that matters). onLevel(z): the zoom changed (a level button's words). top: a
// picture shorter than the stage stays at its top (else centered), as the watch viewer lays it out.
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function createZoom({ stage, box, min = 1, max = 4, onLevel = () => {}, top = false }) {
  const state = { z: 1, tx: 0, ty: 0 };
  function apply() {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const axis = (t, size, off, room, start = false) => (size * state.z <= room ? (start ? 0 : (room - size * state.z) / 2) - off : clamp(t, room - size * state.z - off, -off));
    state.tx = axis(state.tx, box.offsetWidth, box.offsetLeft, sw);
    state.ty = axis(state.ty, box.offsetHeight, box.offsetTop, sh, top);
    box.style.transform = state.z === 1 ? "" : `translate(${state.tx}px, ${state.ty}px) scale(${state.z})`;
    onLevel(state.z);
  }
  function at(z, cx, cy, from = { z: state.z, tx: state.tx, ty: state.ty }, to = { x: cx, y: cy }) {
    const s = stage.getBoundingClientRect();
    const ux = (cx - s.left - box.offsetLeft - from.tx) / from.z, uy = (cy - s.top - box.offsetTop - from.ty) / from.z;
    state.z = clamp(z, min, max);
    state.tx = to.x - s.left - box.offsetLeft - ux * state.z;
    state.ty = to.y - s.top - box.offsetTop - uy * state.z;
    apply();
  }
  const middle = () => { const s = stage.getBoundingClientRect(); return [s.left + s.width / 2, s.top + s.height / 2]; };
  // Zoom to z with the picture point (ux, uy) (unscaled, in the picture's own box) in the stage's
  // middle, as far as the picture's edges allow (apply keeps it inside the stage).
  function show(z, ux, uy) {
    state.z = clamp(z, min, max);
    state.tx = stage.clientWidth / 2 - box.offsetLeft - ux * state.z;
    state.ty = stage.clientHeight / 2 - box.offsetTop - uy * state.z;
    apply();
  }
  addEventListener("resize", apply);
  return { state, at, apply, middle, show };
}
