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
  arm64: { file: "pairbrowse-150.0.7871.114-6-macos-arm64.zip", sha256: "2c6a6d78555e03da0d354f7678a58e14bde7223d012a5583763b2e51acf4d74f" },
  x64: { file: "pairbrowse-150.0.7871.114-6-macos-x86_64.zip", sha256: "38f17188aab8bf96fea6463cbb8f4f9477a513f21d41be4e288993c2c06bdbcd" },
  linux: { file: "pairbrowse-150.0.7871.114-4-linux-x64.tar.xz", sha256: "007deba3d9dfaa02b7b1d2902598e834b7b5ed49b09c7b531919d62dd06dd036" },
  windows: { file: "pairbrowse-150.0.7871.114-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-150.0.7871.114-4.tgz",
    sha256: "4451781446317d6ebf675afa0d75258d826fb1f5ddf06f292a20bfc24e65f793",
    files: { "engine.mjs": "54b979a2b383da0dff5d458f95c25e778c047de6adeda45ad1786cba40a0963c", "collector.js": "38d4afc53caccc1b92d640354166f53c2108f489c6c054ad0f81ca9d7a02b151" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-150.0.7871.114",
};
