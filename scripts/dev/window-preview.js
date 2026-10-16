// The window preview's frames (scripts/dev/window-preview.mjs): ?rail=1 shows both docks as rails;
// unless ?onehost=1, the frames in HOST_GROUPS.localhost reach the helper as localhost, since
// The engine opens at most 6 connections per host and the window's pages open 7 event streams.
const q = new URLSearchParams(location.search);
if (q.get("rail") === "1") document.documentElement.classList.add("rail");
const oneHost = q.get("onehost") === "1";
const LOCALHOST = new Set(["nav-left", "nav-right", "timeline"]);
for (const frame of document.querySelectorAll("iframe[data-src]")) {
  const [path, hash = ""] = frame.dataset.src.split("#");
  frame.src = path + (!oneHost && LOCALHOST.has(frame.id) ? "?via=localhost" : "") + (hash ? "#" + hash : "");
}
document.getElementById("approval").hidden = false;
