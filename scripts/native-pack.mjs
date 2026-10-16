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
export const NATIVE = {
  version: "150.0.7871.114",
  arm64: { file: "pairbrowse-150.0.7871.114-macos-arm64.zip", sha256: "9b874b9cc28e50822df9e34a799e81401344814616d62f3d827184c691368eec" },
  x64: { file: "pairbrowse-150.0.7871.114-macos-x86_64.zip", sha256: "4084043a79d283cb7e06d3c53d42cdd4dcf1ba9ebf0fd13b362d20b1a618566c" },
  linux: { file: "pairbrowse-150.0.7871.114-linux-x64.tar.xz", sha256: "5398af78e2a8163a8f08bb1620ae822d774ff821c695f78c73e1d447c534adac" },
  windows: { file: "pairbrowse-150.0.7871.114-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-150.0.7871.114-3.tgz",
    sha256: "826ad4c6d9373b5d0a5d1b750fe761ae8d0d11adb2fda71ca21961308e568214",
    files: { "engine.mjs": "d09e18dd467f2dd192e54d96c4709923c80e52c718ded79e17531d105b3d645c", "collector.js": "38d4afc53caccc1b92d640354166f53c2108f489c6c054ad0f81ca9d7a02b151" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-150.0.7871.114",
};
