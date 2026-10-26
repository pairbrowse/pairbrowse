// Zoom on this device only, for the phone viewers on the public address (a hand-off's,
// liveview-turn.js, and a watch link's, liveview-watch.js): the picture (box: it and what is drawn
// over it) scaled 1x to max inside stage, and moved; the page itself never changes size. state:
// { z, tx, ty } as it stands now. at(z, cx, cy, from?, to?): zoom to z keeping the picture point
// under (cx, cy) on screen in place (a pinch passes where it started, from, and where its middle is
// now, to). apply(): the picture kept inside the stage (after a resize). middle(): the stage's
// middle, for the + and - buttons. onLevel(z): the zoom changed (a level button's words).
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function createZoom({ stage, box, min = 1, max = 4, onLevel = () => {} }) {
  const state = { z: 1, tx: 0, ty: 0 };
  function apply() {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const axis = (t, size, off, room) => (size * state.z <= room ? (room - size * state.z) / 2 - off : clamp(t, room - size * state.z - off, -off));
    state.tx = axis(state.tx, box.offsetWidth, box.offsetLeft, sw);
    state.ty = axis(state.ty, box.offsetHeight, box.offsetTop, sh);
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
  addEventListener("resize", apply);
  return { state, at, apply, middle };
}
