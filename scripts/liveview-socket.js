// The event stream over a WebSocket, for the viewers on the public address (liveview/public-turn.mjs):
// a hand-off's (liveview-turn.js) and a watch link's (liveview-watch.js). A Cloudflare Quick Tunnel
// doesn't carry server-sent events; the page says it is on that address with data-stream="ws".
// Shaped as the EventSource liveview.js uses (addEventListener, onopen, onerror, readyState,
// close). Each message holds one or more events as the stream writes them. A dropped or refused
// socket is CLOSED at once and onerror runs, so liveview.js hands it to the viewer's lost() (which
// asks whether the link still works and reopens, or ends): EventSource's own retry has no
// counterpart here.
export function socketEvents(url) {
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const listeners = new Map();
  const es = {
    readyState: 0, onopen: null, onerror: null,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    close() { es.readyState = 2; try { ws.close(); } catch {} },
  };
  ws.onopen = () => { es.readyState = 1; es.onopen?.(); };
  ws.onmessage = (m) => {
    for (const block of String(m.data).split("\n\n")) {
      const name = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name && data !== undefined) for (const fn of listeners.get(name) || []) fn({ data });
    }
  };
  ws.onclose = () => { if (es.readyState === 2) return; es.readyState = 2; es.onerror?.(); };
  return es;
}
