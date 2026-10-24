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
  arm64: { file: "pairbrowse-155.0.8059.84-macos-arm64.zip", sha256: "f0b6510a3778e4120acfaee1a6a17e51cc699c381663dc70d46d4abc7a1509e3" },
  x64: { file: "pairbrowse-155.0.8059.84-macos-x86_64.zip", sha256: "090cedf0ddaa4d6d805a77d8431552d9f688aff65878b731e0df5c20205a8793" },
  linux: { file: "pairbrowse-155.0.8059.84-linux-x64.tar.xz", sha256: "68f8b97a1ce339f45451c78ea5baa7dbfff7bfccd716688b749a6104869cf4d9" },
  windows: { file: "pairbrowse-155.0.8059.84-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-155.0.8059.84.tgz",
    sha256: "62e114ab894d17e57e0bb0ffe90146fd5b3b83df026fa85615981a0a5d455107",
    files: { "engine.mjs": "25b28028a123e124d20e84dcb71a6789586a8c4e231cda00e6b0cf10d2d13ece", "collector.js": "74119914770bc592c92f3b7b25da65a1cb464f78f381ab5b27c981756f11d4e6" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-155.0.8059.84",
};
