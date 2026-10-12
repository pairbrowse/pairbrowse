// window.pairbrowse in the PairBrowse browser (pairbrowse-adapter.js). The native build inserts
// this module before each page's own script and serves the compiled bindings beside it; the
// extension never loads it. Defined once, read-only: a page script cannot replace it.
import * as bindings from "./pairbrowse.mojom-webui.js";
import { adapt } from "./pairbrowse-adapter.js";

const api = adapt(bindings, globalThis);
if (api) Object.defineProperty(globalThis, "pairbrowse", { value: api, enumerable: true });
