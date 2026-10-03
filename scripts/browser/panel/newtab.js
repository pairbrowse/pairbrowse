// The search field: a web address opens, anything else searches Google (the live view's rule).
import { addressToUrl } from "./common.js";

document.getElementById("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = document.getElementById("q").value;
  const url = addressToUrl(text);
  if (!url) return;
  // Web pages only: anything else (file:, chrome:, javascript:) is searched for instead.
  location.href = /^https?:\/\//i.test(url) ? url : `https://www.google.com/search?q=${encodeURIComponent(text.trim())}`;
});
