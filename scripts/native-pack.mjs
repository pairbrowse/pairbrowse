// The pinned native PairBrowse downloads, and the engine pack the native browser launches with.
//
// The native browser (scripts/native-install.mjs installs it) is launched with switches and
// humanized input built by the engine pack: a small archive published next to the browser builds
// (built by the private PairBrowse Pro repo: engine/build.mjs). It's downloaded on first use,
// checked against the SHA-256s pinned here (the archive, then each file again before it's loaded),
// and kept in ~/.pairbrowse/engine (native/pack.mjs fetches, checks and loads what's pinned here).

// The native build PairBrowse uses: a new version is a deliberate change here, with the SHA-256s
// the Pro repo's builds print (macOS: scripts/package.py, Linux/Windows: scripts/linuxwin.py, the
// engine pack: engine/build.mjs). baseUrl: the public GitHub release they're published in (file
// name appended). A platform whose sha256 is null has no build yet.
// 155.0.8059.84: the engine on the newest base, its fingerprint series carried by PairBrowse with
// the same behaviour, and the engine tail 960 to 975 (the canvas bridge removed, WebGPU following
// the identity in use, proxy credentials from an owner-only file with SOCKS5, the graphics and
// voice identity, system colours, WebGL timing, IndexedDB on SQLite, the WebRTC mDNS responder on
// macOS, the select anchor in child frames); the engine pack restarts its revisions. No Windows
// build yet.
export const NATIVE = {
  version: "155.0.8059.84",
  arm64: { file: "pairbrowse-155.0.8059.84-3-macos-arm64.zip", sha256: "eaba6a33b18b0a7fcc33e0d3aaad451fb61f2059068b797ab412fc3c5cfa6e26" },
  x64: { file: "pairbrowse-155.0.8059.84-3-macos-x86_64.zip", sha256: "e1036dbf333e105315d7dc8f2fb3ab3d3d1b64700952b18b9db2d8ecff1f1f7c" },
  linux: { file: "pairbrowse-155.0.8059.84-3-linux-x64.tar.xz", sha256: "9ea8438c356b660cf4a9fdcc365049e231248955900ad713a3c3071a149e47f6" },
  windows: { file: "pairbrowse-155.0.8059.84-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-155.0.8059.84-2.tgz",
    sha256: "e58d1f67fb59cc547dc0b82313839c7b7fc85fbb8d68ba5b496af3645577b571",
    files: { "engine.mjs": "645e87504073c98082f57b0453dd9e81a8e010847a951c61800af9e0ac431d38", "collector.js": "74119914770bc592c92f3b7b25da65a1cb464f78f381ab5b27c981756f11d4e6" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-155.0.8059.84",
};
