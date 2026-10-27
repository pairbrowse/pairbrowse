// Copying text from a person's click in the browser's own pages, which may run framed (the native
// build shows Settings inside its own settings page): the clipboard API, and where it is refused
// (a frame without the clipboard permission) the page's own copy command on a selected,
// out-of-sight text box, which needs only the click (still fresh: the refusal comes at once). A flat file at the ui/ root (the native build refuses a ui/<dir> without
// index.html); definitions only, nothing runs on import.

// The copy shortcut for this computer, as a person would press it.
export function copyKeys(nav = globalThis.navigator) {
  const p = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "");
  return /mac|iphone|ipad/i.test(p) ? "Cmd+C" : "Ctrl+C";
}

// Resolves true when text reached the clipboard.
export async function copyText(text, { doc = globalThis.document, nav = globalThis.navigator } = {}) {
  if (typeof text !== "string" || !text) return false;
  try { await nav.clipboard.writeText(text); return true; } catch {}
  if (doc?.execCommand && doc.body) {
    const box = doc.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.setAttribute("aria-hidden", "true");
    Object.assign(box.style, { position: "fixed", top: "0", left: "-9999px", opacity: "0" });
    const had = doc.activeElement;
    doc.body.append(box);
    box.select();
    let ok = false;
    try { ok = doc.execCommand("copy"); } catch {}
    box.remove();
    try { had?.focus?.({ preventScroll: true }); } catch {}
    return ok;
  }
  return false;
}

// The words when nothing could copy: what to select and the one shortcut for this computer.
export const copyFailed = (what = "the text", nav = globalThis.navigator) => `Couldn't copy: select ${what} and press ${copyKeys(nav)}.`;
