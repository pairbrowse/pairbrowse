  // The name of the agent at work in this tab, in front of the tab's title ("Claude (Mac) · Inbox"),
  // so the tab strip says who works where. The page's own title stays underneath: when the page
  // changes it, the name goes back in front; when the agent leaves, the title is the page's again.
  let tabName = "", titleWatch = null;
  const namePrefix = (n) => `${n} · `;
  // With no title of its own, the tab reads the name alone (never "Name ·").
  const withName = (n, own) => (own ? namePrefix(n) + own : n);
  const titleNamed = () => !!tabName && (document.title.startsWith(namePrefix(tabName)) || document.title === tabName || document.title === `${tabName} ·`);
  const titleOnly = () => (!titleNamed() ? document.title : document.title === tabName ? "" : document.title.slice(`${tabName} ·`.length).replace(/^ /, ""));
  function keepName() {
    if (tabName && !titleNamed()) document.title = withName(tabName, document.title);
  }
  function setTabName(name) {
    name = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 32);
    if (name === tabName) return keepName();
    const own = titleOnly();
    tabName = name;
    document.title = name ? withName(name, own) : own;
    if (name && !titleWatch) {
      titleWatch = new MutationObserver(keepName);
      titleWatch.observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
    } else if (!name && titleWatch) { titleWatch.disconnect(); titleWatch = null; }
  }

