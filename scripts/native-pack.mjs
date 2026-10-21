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
// The -7 macOS and -5 Linux builds carry the engine tail 960 (the canvas bridge removed), 961
// (WebGPU follows the identity in use) and 962 (proxy credentials from an owner-only file, SOCKS5
// username/password); the -5 engine pack goes with them.
export const NATIVE = {
  version: "150.0.7871.114",
  arm64: { file: "pairbrowse-150.0.7871.114-7-macos-arm64.zip", sha256: "7600a49ac05dbcf920ce0184e73e02bf3f4f171236d80b4f9214e1f494e98436" },
  x64: { file: "pairbrowse-150.0.7871.114-7-macos-x86_64.zip", sha256: "5c9f678ffc12756d68f703f83dd63e64a4990ff70d9c769c9057e70fad762b35" },
  linux: { file: "pairbrowse-150.0.7871.114-5-linux-x64.tar.xz", sha256: "a2b9c226982e86731baf2cdf0290f7a04a87710cdbddc703cc77f91e45e7a88b" },
  windows: { file: "pairbrowse-150.0.7871.114-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-150.0.7871.114-6.tgz",
    sha256: "4b845655abdbd4ced205535ecb3207a9141869af19fc1f87e0279609cc19c94b",
    files: { "engine.mjs": "9ed2b8c8566d0ed0800d66464fd179e6e046dcbc5074e7ee1aa1ccd6ce8b6282", "collector.js": "38d4afc53caccc1b92d640354166f53c2108f489c6c054ad0f81ca9d7a02b151" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-150.0.7871.114",
};
