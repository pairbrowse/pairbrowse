  // The Chrome Web Store names this browser on its own buttons: "Add to PairBrowse" and "Remove
  // from PairBrowse" where it says Chrome (English; the store's own pages only, buttons only).
  // Rewritten as the store draws them; nothing else on the page is touched.
  if (location.hostname === "chromewebstore.google.com") {
    const STORE_WORDS = /\b(Add to|Remove from) Chrome\b/g;
    const inButton = (n) => !!(n.nodeType === 1 ? n : n.parentElement)?.closest?.("button, [role=button]");
    const renamed = (s) => String(s).replace(STORE_WORDS, "$1 PairBrowse");
    const fixText = (n) => { if (n.nodeValue && n.nodeValue !== renamed(n.nodeValue) && inButton(n)) n.nodeValue = renamed(n.nodeValue); };
    const fixLabel = (el) => {
      for (const a of ["aria-label", "title"]) {
        const v = el.getAttribute?.(a);
        if (v && v !== renamed(v) && inButton(el)) el.setAttribute(a, renamed(v));
      }
    };
    const fixAll = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) fixText(n);
      if (root.nodeType === 1) fixLabel(root);
      for (const el of root.querySelectorAll?.("[aria-label], [title]") || []) fixLabel(el);
    };
    const storeWatch = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") fixText(m.target);
        else if (m.type === "attributes") fixLabel(m.target);
        else for (const n of m.addedNodes) { if (n.nodeType === 3) fixText(n); else if (n.nodeType === 1) fixAll(n); }
      }
    });
    storeWatch.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "title"] });
    if (document.documentElement) fixAll(document.documentElement);
  }

