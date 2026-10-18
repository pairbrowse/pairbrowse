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
  arm64: { file: "pairbrowse-150.0.7871.114-4-macos-arm64.zip", sha256: "45e1341bd87a0b8aef2e176e08d96c0db619b6ae0c2e2cf322ff55c8c78039fd" },
  x64: { file: "pairbrowse-150.0.7871.114-4-macos-x86_64.zip", sha256: "a7673e739bc6a6a4297a9710e9c852cead09832123e4edd90176b162d02d22e4" },
  linux: { file: "pairbrowse-150.0.7871.114-linux-x64.tar.xz", sha256: "5398af78e2a8163a8f08bb1620ae822d774ff821c695f78c73e1d447c534adac" },
  windows: { file: "pairbrowse-150.0.7871.114-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-150.0.7871.114-4.tgz",
    sha256: "4451781446317d6ebf675afa0d75258d826fb1f5ddf06f292a20bfc24e65f793",
    files: { "engine.mjs": "54b979a2b383da0dff5d458f95c25e778c047de6adeda45ad1786cba40a0963c", "collector.js": "38d4afc53caccc1b92d640354166f53c2108f489c6c054ad0f81ca9d7a02b151" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-150.0.7871.114",
};
