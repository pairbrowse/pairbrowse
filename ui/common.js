// The pages' shared code, as one module: the side panel, the browser's own pages (the strip, the
// docks, the timeline, the approval bubble, settings), the new tab page and the live view (which
// serves it and every module it names from here: an extension can load only its own files;
// scripts/liveview/http.mjs ASSETS). It holds nothing itself: each part is a flat file at the ui/
// root (the native build refuses a ui/<dir> without index.html; build.py requires common.js), and
// every one of them stays free of side effects (the live view's server and the tests import this
// in Node): definitions only, nothing runs on import.
//   dom.js        $, el, sparkIcon
//   motion.js     calm, enter, leave, syncList, revealed, busy
//   words.js      rich, clocks, ago, an agent's state words, the resting state's lines
//   people.js     splitLabel, initialOf, inkOn, avatar
//   checklist.js  the goal log's done lines and checklist
//   report.js     report a problem
//   panels.js     join requests, join addresses, dev servers, the profile
//   popover.js    Share, the session switcher, the switch question, askDock
//   stream.js     helperStream, the one owner event stream per origin
// The words and colors the helper shares with the pages are in vocab.js, the browser's own
// addresses in urls.js, finding and asking the helper in helper.js; the few a page used to take
// from here are re-exported.
export { STATE_WORDS, isColor } from "./vocab.js";
export { addressToUrl, servedByBrowser, REPORT_URL } from "./urls.js";
export * from "./dom.js";
export * from "./motion.js";
export * from "./words.js";
export * from "./people.js";
export * from "./checklist.js";
export * from "./report.js";
export * from "./panels.js";
export * from "./popover.js";
export * from "./stream.js";
