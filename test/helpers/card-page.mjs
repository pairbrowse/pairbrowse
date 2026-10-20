// A tab stand-in for the card checks (scripts/runner/cards.mjs, daemon/serve/refuse.mjs, fast mode's
// steps): fields by target ("e3", a selector), each { autocomplete, frame }, where frame is null
// (the page itself) or { origin, cardFields, allow } (a frame from that origin, holding card fields
// or not, with that allow attribute on its frame element); focused: the target with the focus.
// What the page reads runs in Node on these stand-ins, exactly as it would in the page.
export function cardPage({ url = "https://shop.example/checkout", fields = {}, focused = null } = {}) {
  const topWin = {};
  topWin.top = topWin;
  const topDoc = { defaultView: topWin, location: { origin: new URL(url).origin }, querySelectorAll: () => [] };
  const docs = new Map();
  const docOf = (frame) => {
    if (!frame) return topDoc;
    if (!docs.has(frame)) {
      const inner = frame.cardFields ? [{ getAttribute: (n) => (n === "autocomplete" ? "cc-number" : null) }] : [];
      docs.set(frame, { defaultView: { top: topWin }, location: { origin: frame.origin }, querySelectorAll: () => inner });
    }
    return docs.get(frame);
  };
  const elementOf = (f) => ({ tagName: f.tag || "INPUT", getAttribute: (n) => (n === "autocomplete" ? f.autocomplete ?? null : null), ownerDocument: docOf(f.frame) });
  const handleOf = (f) => {
    const el = elementOf(f);
    return {
      evaluate: async (fn, arg) => fn(el, arg),
      ownerFrame: async () => ({ frameElement: async () => ({ getAttribute: async (n) => (n === "allow" ? f.frame?.allow ?? null : null), dispose: async () => {} }) }),
      dispose: async () => {},
    };
  };
  const frame = {
    // focusedFrame asks for a focused frame element first (none here), then the focused field.
    evaluateHandle: async (fn) => (String(fn).includes("IFRAME") ? { asElement: () => null, dispose: async () => {} }
      : { asElement: () => (focused && fields[focused] ? handleOf(fields[focused]) : null), dispose: async () => {} }),
  };
  return {
    url: () => url,
    isClosed: () => false,
    mainFrame: () => frame,
    locator: (sel) => {
      const f = fields[String(sel).replace(/^aria-ref=/, "")];
      return { first: () => (f ? { evaluate: async (fn, arg) => fn(elementOf(f), arg), elementHandle: async () => handleOf(f) }
        : { evaluate: async () => { throw new Error("no such element"); }, elementHandle: async () => null }) };
    },
  };
}
