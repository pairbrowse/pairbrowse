// A tab stand-in for the card checks (scripts/runner/cards.mjs, daemon/serve/refuse.mjs, fast mode's
// steps): fields by target ("e3", a selector), each { autocomplete, frame, tag, type, name, id,
// placeholder, label, value }, where frame is null (the page itself) or { origin, cardFields, allow }
// (a frame from that origin, holding a card number field of its own after the fields given or not,
// with that allow attribute on its frame element; fields sharing a frame object share its
// document); focused: the target with the focus. Each document lists its fields in the order given.
// What the page reads runs in Node on these stand-ins, exactly as it would in the page.
export function cardPage({ url = "https://shop.example/checkout", fields = {}, focused = null } = {}) {
  const topWin = {};
  topWin.top = topWin;
  const inDoc = (frame) => Object.values(fields).filter((f) => (f.frame || null) === frame).map((f) => elementOf(f));
  const topDoc = { defaultView: topWin, location: { origin: new URL(url).origin }, querySelectorAll: () => inDoc(null) };
  const docs = new Map();
  const docOf = (frame) => {
    if (!frame) return topDoc;
    if (!docs.has(frame)) {
      const number = frame.cardFields ? [{ tagName: "INPUT", value: "", getAttribute: (n) => (n === "autocomplete" ? "cc-number" : null) }] : [];
      docs.set(frame, { defaultView: { top: topWin }, location: { origin: frame.origin }, querySelectorAll: () => [...inDoc(frame), ...number] });
    }
    return docs.get(frame);
  };
  const ATTRS = { autocomplete: "autocomplete", type: "type", name: "name", id: "id", placeholder: "placeholder", "aria-label": "ariaLabel" };
  const elements = new Map();
  const elementOf = (f) => {
    if (!elements.has(f)) {
      elements.set(f, { tagName: f.tag || "INPUT", value: f.value ?? "", labels: f.label ? [{ textContent: f.label }] : [],
        getAttribute: (n) => (ATTRS[n] ? f[ATTRS[n]] ?? null : null), ownerDocument: docOf(f.frame) });
    }
    return elements.get(f);
  };
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
