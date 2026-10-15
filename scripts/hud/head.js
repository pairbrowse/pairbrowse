// Injected into every page by the PairBrowse daemon. Shows a small status badge so you can
// see, in the browser itself, what Claude is doing and when it's your turn.
// The NAME, TOKEN and TAG placeholders below are replaced with random values each time the daemon
// starts, so a web page can't drive the badge or spot PairBrowse by a fixed name. The page
// elements carry no attributes (their styles live inside closed shadow roots); aria-hidden inside
// keeps them out of Claude's snapshot.
(() => {
  const NAME = "__PB_NAME__";
  // Element names, random per helper start (see hudScript in browser.mjs).
  const TAG_HUD = "__PB_TAG_HUD__", TAG_BAR = "__PB_TAG_BAR__", TAG_CURSOR = "__PB_TAG_CURSOR__";
  const TOKEN = "__PB_TOKEN__";

