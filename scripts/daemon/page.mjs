// Code that runs inside web pages, shared by the helper's checks and fast mode. Playwright sends a
// function's source to the page, so the helpers it calls have to travel inside that source.

// fn, as a function whose source also declares the given helper functions (by their names).
export function withHelpers(fn, ...helpers) {
  return new Function("...args", `${helpers.map(String).join("\n")}\nreturn (${fn})(...args);`);
}

// A button's or link's label as the page shows it (the click guards only see what Claude calls
// it): its text, aria label (also through aria-labelledby), value, title and alt, and the labels
// of icons inside it.
export function buttonLabel(n) {
  const by = (n.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
  const icons = [...n.querySelectorAll("img[alt], svg [aria-label], svg title, [aria-label]")].slice(0, 10).map((i) => i.getAttribute("alt") || i.getAttribute("aria-label") || i.textContent || "");
  return [n.getAttribute("aria-label"), by, n.value, n.innerText || n.textContent, n.getAttribute("title"), n.getAttribute("alt"), ...icons]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
}

export function isVisible(el) {
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
}

// Short text just before a field in its row (a "Date of Birth" div next to the input), not a
// section heading: how fast mode finds a field with no label, and how its outline names it.
export function nearbyText(el) {
  for (let node = el, up = 0; node && up < 4; node = node.parentElement, up++) {
    for (let prev = node.previousSibling; prev; prev = prev.previousSibling) {
      if (prev.nodeType === 3) {
        const t = prev.nodeValue.replace(/\s+/g, " ").trim();
        if (t) return t.length <= 40 ? t : "";
        continue;
      }
      if (prev.nodeType !== 1) continue;
      if (prev.matches("input, select, textarea") || prev.querySelector("input, select, textarea")) return "";
      if (prev.matches("h1, h2, h3, h4, h5, h6, legend, nav, header")) return "";
      const t = (prev.innerText || "").replace(/\s+/g, " ").trim();
      if (t) return t.length <= 40 ? t : "";
    }
  }
  return "";
}
