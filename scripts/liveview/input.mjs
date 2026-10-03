// Replays a viewer's mouse, touch, keys and navigation on the shown tab through its CDP session,
// and keeps the page's screencast at the viewer's size ("Fit to pane").
import { navigationProblem } from "../policy.mjs";
import { isLocalNetwork } from "../guard.mjs";
// The one address bar rule, shared with the new tab page and the viewer.
import { addressToUrl } from "../browser/panel/common.js";

export { addressToUrl };

const KEYS = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};

// Editing shortcuts the viewer may send (Cmd/Ctrl + A, X, Z, Shift+Z, Y). Copy and paste stay with
// the viewer's own clipboard.
const COMMANDS = { selectAll: "a", cut: "x", undo: "z", redo: "z" };

const TEXT_MAX = 2000;
const NAV_TIMEOUT_MS = { back: 10_000, forward: 10_000, reload: 15_000, go: 20_000 };
const FIT_MIN = { width: 320, height: 240 };
const FIT_MAX = 3000;
const PIXEL_RATIO_MAX = 3;
// Screencast frames: JPEG, at most this many pixels a side.
const CAST_MAX_SIDE = 1920;
const CAST_DEFAULT_SIDE = 1600;
const CAST_QUALITY = 60;

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

export function createInputReplayer() {
  let drag = null; // data of an HTML5 drag in progress (intercepted so it can be finished by hand)
  let lastPointer = { x: 0, y: 0 };
  let fitSize = null; // { width, height } when "Fit to pane" is on
  let pixelRatio = 1; // the viewer screen's device pixel ratio, so frames stay sharp on Retina

  const metrics = () => ({ ...fitSize, deviceScaleFactor: pixelRatio, mobile: false });
  const startCast = (cdp) => {
    const max = (n) => Math.min(CAST_MAX_SIDE, Math.round(n || CAST_DEFAULT_SIDE));
    return cdp.send("Page.startScreencast", { format: "jpeg", quality: CAST_QUALITY, maxWidth: max(fitSize?.width), maxHeight: max(fitSize?.height) });
  };

  return {
    startCast,
    // A new CDP session for the shown tab: finish drags by hand, and take the viewer's size.
    async attach(cdp) {
      cdp.on("Input.dragIntercepted", async ({ data }) => {
        drag = data;
        await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: lastPointer.x, y: lastPointer.y, data }).catch(() => {});
      });
      if (fitSize) await cdp.send("Emulation.setDeviceMetricsOverride", metrics()).catch(() => {});
    },
    // Nobody is watching: the real window gets its normal size back.
    resetFit() { fitSize = null; },

    // One event from a viewer, on shown ({ page, cdp }, or null). role: "owner", or an invite's.
    async replay(shown, ev, role = "owner") {
      if (ev?.x !== undefined) lastPointer = { x: ev.x, y: ev.y };
      if (!shown) return;
      const { cdp, page } = shown;
      if (ev.type === "mouse") {
        const at = { x: ev.x, y: ev.y, modifiers: ev.modifiers || 0 };
        if (ev.action === "mousePressed") {
          // Lets a drag-and-drop that starts from this press be carried to its drop target.
          await cdp.send("Input.setInterceptDrags", { enabled: true }).catch(() => {});
        }
        if (drag && ev.action === "mouseMoved") {
          return cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...at, data: drag });
        }
        if (drag && ev.action === "mouseReleased") {
          await cdp.send("Input.dispatchDragEvent", { type: "drop", ...at, data: drag }).catch(() => {});
          drag = null;
        }
        await cdp.send("Input.dispatchMouseEvent", {
          type: ev.action, ...at, button: ev.button || "none", buttons: ev.buttons || 0, clickCount: ev.clickCount || 0,
        });
        if (ev.action === "mouseReleased") {
          await cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
        }
      } else if (ev.type === "touch") {
        await cdp.send("Input.dispatchTouchEvent", {
          type: ev.action, touchPoints: ev.action === "touchEnd" || ev.action === "touchCancel" ? [] : [{ x: ev.x, y: ev.y, id: 0 }], modifiers: ev.modifiers || 0,
        });
      } else if (ev.type === "wheel") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx || 0, deltaY: ev.dy || 0 });
      } else if (ev.type === "text") {
        await cdp.send("Input.insertText", { text: String(ev.text).slice(0, TEXT_MAX) });
      } else if (ev.type === "nav") {
        if (ev.action === "back") await page.goBack({ timeout: NAV_TIMEOUT_MS.back }).catch(() => {});
        else if (ev.action === "forward") await page.goForward({ timeout: NAV_TIMEOUT_MS.forward }).catch(() => {});
        else if (ev.action === "reload") await page.reload({ timeout: NAV_TIMEOUT_MS.reload }).catch(() => {});
        else if (ev.action === "go") {
          // Same rule as Claude's navigation: web pages only. Invited people can't open addresses on
          // this computer's network (your router, local servers) through your browser.
          const url = addressToUrl(ev.url);
          if (url && !navigationProblem(url) && (role === "owner" || !isLocalNetwork(url))) await page.goto(url, { timeout: NAV_TIMEOUT_MS.go }).catch(() => {});
        }
      } else if (ev.type === "viewport") {
        fitSize = ev.on ? { width: clamp(ev.w, FIT_MIN.width, FIT_MAX), height: clamp(ev.h, FIT_MIN.height, FIT_MAX) } : null;
        pixelRatio = Math.min(PIXEL_RATIO_MAX, Math.max(1, Number(ev.dpr) || 1));
        if (fitSize) await cdp.send("Emulation.setDeviceMetricsOverride", metrics());
        else await cdp.send("Emulation.clearDeviceMetricsOverride");
        await cdp.send("Page.stopScreencast").catch(() => {});
        await startCast(cdp);
      } else if (ev.type === "command" && Object.hasOwn(COMMANDS, ev.command)) {
        const key = COMMANDS[ev.command];
        const base = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: ev.modifiers || 0 };
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, commands: [ev.command] });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      } else if (ev.type === "key" && Object.hasOwn(KEYS, ev.key)) {
        const base = { key: ev.key, code: ev.key, windowsVirtualKeyCode: KEYS[ev.key], modifiers: ev.modifiers || 0 };
        const enter = ev.key === "Enter";
        await cdp.send("Input.dispatchKeyEvent", { type: enter ? "keyDown" : "rawKeyDown", ...base, ...(enter ? { text: "\r" } : {}) });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      }
    },
  };
}
