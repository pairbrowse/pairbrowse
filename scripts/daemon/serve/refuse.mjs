// Which tab a tool call may act in: never the browser's own pages, never a person's own tab.
import { isChromePage, CHROME_PAGE_RULE } from "../../policy.mjs";
import { isUntouchedStart } from "../../tabs.mjs";
import { PERSON_TAB_RULE } from "../output.mjs";
import { CHROME_GUARDED } from "./wire.mjs";

// Whether a tool call may go on in the tab it would act in. here: the tab the call acts in (or
// null); pages: the open tabs, for browser_tabs select or close by index; personTab(page): a
// person's own tab (a file they opened from Downloads; any file: tab counts). Returns the refusal's
// text, or null. Pure. The browser's own pages (chrome://pairbrowse) and the person's tabs are
// never a tab an agent acts in, selects or closes.
export const isFileTab = (page) => { try { return /^file:/i.test(String(page?.url?.() ?? "")); } catch { return false; } };
export function tabRefusal(name, args = {}, { here = null, pages = [], personTab = () => false } = {}) {
  const person = (page) => !!page && (!!personTab(page) || isFileTab(page));
  if ((name.startsWith("browser_") && name !== "browser_tabs" && name !== "browser_close") || CHROME_GUARDED.has(name)) {
    // The one exception: browser_navigate may take an untouched new tab page (the start tab, a fresh
    // Cmd+T) to a web page, as it took the about:blank start tab before the build had its own new
    // tab page (plans/555 Risk 1); nothing reads or acts in the page itself, and navigationProblem
    // still refuses every browser page as a target.
    const leavingNewTab = name === "browser_navigate" && here && isUntouchedStart(here.url());
    if (here && isChromePage(here.url()) && !leavingNewTab) return `${CHROME_PAGE_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`;
    if (person(here)) return `${PERSON_TAB_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`;
  }
  if (name === "browser_tabs" && (args.action === "select" || args.action === "close") && args.index !== undefined) {
    const page = pages[Number(args.index)];
    if (page && isChromePage(page.url())) return `Tab ${args.index} is the browser's own page. ${CHROME_PAGE_RULE} Use browser_tabs list.`;
    if (person(page)) return `Tab ${args.index} is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`;
  }
  return null;
}
