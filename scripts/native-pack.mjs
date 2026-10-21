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
    file: "pairbrowse-engine-150.0.7871.114-5.tgz",
    sha256: "c543bfd934048e1c9a0e1f94cf89a5464537edaff0ec6c24bca48d9441bede66",
    files: { "engine.mjs": "d637d66a549beaaa7780626b6d496b78399a93e431b1f482741c897aac20984e", "collector.js": "38d4afc53caccc1b92d640354166f53c2108f489c6c054ad0f81ca9d7a02b151" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-150.0.7871.114",
};
