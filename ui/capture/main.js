// The capture page's one script (index.html): the capture core (capture.js, record.js) with the
// transport its host gives it. In the PairBrowse browser (window.pairbrowse, inserted before this
// module by the native build) the helper asks over its own channel (transport-native.js); in the
// extension's offscreen document the worker asks with chrome.runtime messages
// (transport-extension.js, as always). Anywhere else nothing listens.
import { startNative } from "./transport-native.js";
import { listen } from "./transport-extension.js";

const pb = globalThis.pairbrowse || null;
const say = (s) => { if (document.body) document.body.dataset.s = s; };
if (pb) startNative(pb, { onState: say }).catch(() => say("closed"));
else if (globalThis.chrome?.runtime?.onMessage) listen(globalThis.chrome.runtime);
