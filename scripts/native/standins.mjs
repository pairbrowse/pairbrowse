// The open stand-ins' files (server-mode spec step 52, decision 11's metric-compatible route): every
// font the server setup (native/fontsetup.mjs installStandIns) takes for a Windows name besides
// Selawik (fontsetup.mjs SELAWIK), from its publisher's own source only, each file and its licence
// pinned by SHA-256, kept under its published name beside that licence in its own folder of the
// setup's font folder (paths.fonts/<dir>), never renamed or modified. Which Windows name each
// family stands in for is winfonts.mjs STAND_INS; the alias file (native/fontconf.mjs) lists
// these folders while pairbrowse.fontStandIns is on. Pure data; Node's standard library only.
//
// Sources:
//   Google Fonts' own repository (github.com/google/fonts) at one commit: Arimo, Tinos, Cousine
//     (the Croscore families: Apache-2.0 in the Croscore release, SIL OFL 1.1 as Google Fonts
//     publishes them now, which is what is taken), Gelasio, Carlito, Caladea, Fira Sans, Comic Relief, Anton and
//     Inconsolata, all SIL OFL 1.1 with the licence file published beside them. Tinos's folder
//     there carries no licence file at that commit, so its OFL.txt comes from the family's own
//     repository (github.com/googlefonts/tinos), pinned to a commit.
//   DejaVu's own release (dejavu-fonts.github.io links its GitHub releases): the 2.37 TTF archive,
//     DejaVu Sans and DejaVu Sans Condensed taken from it with its LICENSE (the DejaVu licence:
//     Bitstream Vera's terms, Arev's, DejaVu's changes public domain).

// google/fonts at the commit every Google Fonts file below was pinned from (2026-10-24).
export const GOOGLE_FONTS_COMMIT = "e7db6ca603fd4862010383ff17ffd6cc4ffac1c0";
const GF = `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl`;
// A published file name as a URL path segment (Google Fonts names variable fonts "Name[axes].ttf").
export const urlName = (name) => encodeURIComponent(name);

const gf = (dir, family, licence, fonts, license = { file: "OFL.txt" }) => Object.freeze({
  dir, family, licence, source: "Google Fonts",
  base: `${GF}/${dir}/`,
  fonts: Object.freeze(fonts),
  license: Object.freeze({ url: `${GF}/${dir}/${license.file}`, ...license }),
});

// Each: dir (its folder under the setup's font folder), family (fontconfig's name for it),
// licence, source, and either base (each font's URL is base + its name) or archive (a release
// archive pinned whole; each font is read from it under prefix + its name); fonts: name -> SHA-256;
// license: the licence file, from url or from the archive (inArchive), pinned the same way.
export const STAND_IN_FONTS = Object.freeze([
  gf("arimo", "Arimo", "SIL OFL 1.1", {
    "Arimo[wght].ttf": "e43898b143ec826ac8cb4034816458a7047fbe0836558de2a1f8c6223ae3e0ca",
    "Arimo-Italic[wght].ttf": "a80fc54fd0233c1dfe298577c4d00f5ae81d5bb83510975e473c47e699b7f4ed",
  }, { file: "OFL.txt", sha256: "11cce536cd2f3864d767003af5dcd739e2e15818cf2279b6175edeadd3960992" }),
  gf("tinos", "Tinos", "SIL OFL 1.1", {
    "Tinos-Regular.ttf": "60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61",
    "Tinos-Bold.ttf": "393269dbab8899f938db19783eca5eac92eb431f7ae0ab45b8349ca895f1a06b",
    "Tinos-Italic.ttf": "5942266ed398b155d7dc23e36833e7ec6be988f2439bdbeb8ef1bede808eaa91",
    "Tinos-BoldItalic.ttf": "a5de79f0fe863ea0954757acb3d47b3ccd0a930ce3dd5b97230cd3866790a06e",
  }, { file: "OFL.txt", url: "https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/OFL.txt", sha256: "cb3382d4643e8b02c12e322c220a3c76a5020d667e4fd4e7c75e744cca6caa6b" }),
  gf("cousine", "Cousine", "SIL OFL 1.1", {
    "Cousine-Regular.ttf": "1da22250675fc4c42fcf3a9736c44bc0570516105331443b663fd5cfbd1412fe",
    "Cousine-Bold.ttf": "17c8a7245156d2253531c9e529474937b09d9f641c5ae7695c5e33f22822eef4",
    "Cousine-Italic.ttf": "ea2a76ae3d0ece9cd59f0d30fdc08dd70e8f5f457beee5b0852a7b50c2286c7c",
    "Cousine-BoldItalic.ttf": "848e858726fee0ae27b754e4cd6a2755209bf1428a8c91f747696d58c33906c3",
  }, { file: "OFL.txt", sha256: "b81c4d4dc0a9f72c9155e78187316e016e2012a8102468804173dc61468b906d" }),
  gf("gelasio", "Gelasio", "SIL OFL 1.1", {
    "Gelasio[wght].ttf": "4daecea457258c9ebeb8bc99ed3fd24353618bfad3ea4b93fa0b5d0468fc04e4",
    "Gelasio-Italic[wght].ttf": "52559e845a4d33514e5f93bb9ae7dbeae1894a53f2c565a15f18af40cd337c09",
  }, { file: "OFL.txt", sha256: "b393cb01867c919b44381512120dc3e4c954c7b47e2035c405f3a324799a4d29" }),
  gf("carlito", "Carlito", "SIL OFL 1.1", {
    "Carlito-Regular.ttf": "f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595",
    "Carlito-Bold.ttf": "bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db",
    "Carlito-Italic.ttf": "0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c",
    "Carlito-BoldItalic.ttf": "b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517",
  }, { file: "OFL.txt", sha256: "58402f82a7c332a700294988fe7554fbb0a63a8d27ccc1ee3bbc640311990a00" }),
  gf("caladea", "Caladea", "SIL OFL 1.1", {
    "Caladea-Regular.ttf": "f1e899278b7b4491aba5b6a8253c4b04c050cc59b21865be5c37559a775153cd",
    "Caladea-Bold.ttf": "ae3cb2dcbc925809dd29d2a44e9802211cab66be541bacbfc9c08c74b27c3742",
    "Caladea-Italic.ttf": "4359a8e24f748b6447b1ff6d7a174febe70961d29f8bb8634b56dacd740a3deb",
    "Caladea-BoldItalic.ttf": "ccabaa7b7e2fdf253d2b1a5fa699dd8a3df8d835a9eb285ad82631a677eb76c0",
  }, { file: "OFL.txt", sha256: "ccdab61d371d8c8683a128a92cd7d498dbdb1d37689f7cb21f1bf6b16658d213" }),
  gf("firasans", "Fira Sans", "SIL OFL 1.1", {
    "FiraSans-Regular.ttf": "c29556a2719bf613ef3d5e070e40d903a8965d9c081beca1375dc1e6e0f93c23",
    "FiraSans-Bold.ttf": "a4d8e149ecdd4874a0726eb0af894488b3b31c423d6b0017c8f415ed1b795b45",
    "FiraSans-Italic.ttf": "a4204f9a8029c1c55daa5385ac95936f74abea3e232770f1fb2862a19d1dfa13",
    "FiraSans-BoldItalic.ttf": "1b96c16db9819bcaa9d588068bb397bb6e977c4874965d3d50d789a1943757eb",
  }, { file: "OFL.txt", sha256: "8f24842e9174beda18a556c2ae7d54f5dc444340c19a3a9ef77e23bca366adbd" }),
  gf("comicrelief", "Comic Relief", "SIL OFL 1.1", {
    "ComicRelief-Regular.ttf": "9ef4958ab06385d91f635f83a15569786b243f9d010cfb3f9a5cdda593c7bc22",
    "ComicRelief-Bold.ttf": "33aee007212b696afd57d50c901135cd723cd188f7ad98f3a1c572ea64e8f0d5",
  }, { file: "OFL.txt", sha256: "009b3056cef5c9bcaff872bfb0e27fa4a0f8cc6f6984cc490caf5618748d766b" }),
  gf("anton", "Anton", "SIL OFL 1.1", {
    "Anton-Regular.ttf": "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab",
  }, { file: "OFL.txt", sha256: "ee67e6ee22790b7929f1a3769ca2801d565c64b5a9096942c1adf5596de9c9e4" }),
  gf("inconsolata", "Inconsolata", "SIL OFL 1.1", {
    "Inconsolata[wdth,wght].ttf": "23ded25b447074d00659392bf9b1123d89df55cb07b0ad9bfef3366d199b5fcb",
  }, { file: "OFL.txt", sha256: "29bd0cfd0fb2a45f9b057c834a057724bae1f63b525a8ac83d3e7525706d9f80" }),
  Object.freeze({
    dir: "dejavu", family: "DejaVu Sans", licence: "DejaVu Fonts License", source: "DejaVu's release 2.37",
    archive: Object.freeze({
      url: "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip",
      file: "dejavu-fonts-ttf-2.37.zip",
      sha256: "7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a",
      prefix: "dejavu-fonts-ttf-2.37/ttf/",
    }),
    fonts: Object.freeze({
      "DejaVuSans.ttf": "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
      "DejaVuSans-Bold.ttf": "e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724",
      "DejaVuSans-Oblique.ttf": "4af75fa16ee6d3ad43e1ecec41862c24954af26a55c6bb1ebb27bd486a50f5f4",
      "DejaVuSans-BoldOblique.ttf": "eb436dca0c2594b73d8b603b892e374fdfd8d885d25ffb4f18df4c4c0b49e50f",
      "DejaVuSansCondensed.ttf": "8550cd5ca1acb65a8fc7877c46939cd0b4d909f8e7bc1e24716873d918c5e549",
      "DejaVuSansCondensed-Bold.ttf": "38098d0b8edd8430a0f53fb2831b5d36037563a998a620d3c87a4d7591766d20",
      "DejaVuSansCondensed-Oblique.ttf": "dc3526fa25fae4278c4e34b47d4c049b6923421c70921032a0db11bfe9c1b0cf",
      "DejaVuSansCondensed-BoldOblique.ttf": "43f9fd6b77edf174553cf94857c77c63de7ddb0c6751fd1390e73223518e128f",
    }),
    license: Object.freeze({ file: "LICENSE", inArchive: "dejavu-fonts-ttf-2.37/LICENSE", sha256: "7a083b136e64d064794c3419751e5c7dd10d2f64c108fe5ba161eae5e5958a93" }),
  }),
]);

// The folders the alias file lists for them, in STAND_IN_FONTS' order.
export const STAND_IN_DIRS = Object.freeze(STAND_IN_FONTS.map((f) => f.dir));
