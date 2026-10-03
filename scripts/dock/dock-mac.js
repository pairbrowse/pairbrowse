// PairBrowse pane for macOS (JavaScript for Automation: osascript -l JavaScript dock-mac.js <url> <width> <app> <top> <makeRoom>).
// A borderless panel that sits inside the right edge of the Claude app window, showing the live
// view, so the browser looks like part of the app. It follows the Claude window as it moves,
// resizes, hides or goes behind other apps.
// The Claude window's position comes from the window list (CGWindowListCopyWindowInfo), which
// needs no Accessibility permission; the panel only ever moves itself.
ObjC.import("Cocoa");
ObjC.import("WebKit");
ObjC.import("CoreGraphics");

// Where the pane goes, in screen points with a top-left origin (like the window list).
// claude and screen: {x, y, w, h}. Beside the window when the screen has room on the right
// (nothing covered, looks like an extension of the window); otherwise inside its right edge,
// below Claude's own header. Returns {mode, x, y, w, h}, or null when there's no sensible spot.
function paneFrame(claude, screen, opts) {
  const want = opts.width > 0 ? opts.width : Math.max(420, Math.min(720, Math.round(claude.w * 0.46)));
  const roomRight = screen.x + screen.w - (claude.x + claude.w);
  if (roomRight >= 420) {
    return { mode: "beside", x: claude.x + claude.w, y: claude.y, w: Math.min(want, roomRight), h: claude.h };
  }
  const w = Math.min(want, claude.w - 360);
  if (w < 420) return null;
  const top = opts.top || 0;
  return { mode: "inside", x: claude.x + claude.w - w, y: claude.y + top, w, h: claude.h - top };
}

// Visible screen areas, top-left origin.
function screens() {
  const all = $.NSScreen.screens;
  const mainH = all.objectAtIndex(0).frame.size.height;
  const out = [];
  for (let i = 0; i < all.count; i++) {
    const f = all.objectAtIndex(i).visibleFrame;
    out.push({ x: f.origin.x, y: mainH - (f.origin.y + f.size.height), w: f.size.width, h: f.size.height });
  }
  return out;
}
const screenAt = (x, y) => screens().find((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) || screens()[0];

// Optional, once: narrow the Claude window so the pane fits beside it. Needs Accessibility
// permission for the app running this; without it, the pane just sits inside instead.
function makeRoom(owner, claude, screen, want) {
  const width = screen.x + screen.w - want - claude.x;
  if (width < 640) return;
  try {
    Application("System Events").processes.byName(owner).windows[0].size = [width, claude.h];
  } catch (e) {
    console.log("NO_ROOM " + e.message);
  }
}

// The frontmost normal window of the Claude app: its bounds and window number.
function claudeWindow(owner) {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
  for (let i = 0; i < list.count; i++) {
    const info = list.objectAtIndex(i);
    if (ObjC.unwrap(info.objectForKey("kCGWindowOwnerName")) !== owner) continue;
    if (ObjC.unwrap(info.objectForKey("kCGWindowLayer")) !== 0) continue;
    const b = info.objectForKey("kCGWindowBounds");
    const r = { x: ObjC.unwrap(b.objectForKey("X")), y: ObjC.unwrap(b.objectForKey("Y")), w: ObjC.unwrap(b.objectForKey("Width")), h: ObjC.unwrap(b.objectForKey("Height")) };
    if (r.w < 400 || r.h < 300) continue;
    return { ...r, number: ObjC.unwrap(info.objectForKey("kCGWindowNumber")) };
  }
  return null;
}

function run(argv) {
  const url = argv[0];
  // top: leave the Claude window's own header (with its buttons) visible above the pane.
  const opts = { width: parseInt(argv[1] || "0", 10), top: parseInt(argv[3] || "52", 10) };
  const owner = argv[2] || "Claude";
  let roomAsked = argv[4] !== "1"; // "1": narrow Claude once to make room (needs Accessibility)
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url || "")) { console.log("BAD_URL"); return; }

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory); // no Dock icon or menu bar

  // Borderless windows can't take keyboard focus by default; the pane needs it for typing.
  ObjC.registerSubclass({
    name: "PBPaneWindow",
    superclass: "NSWindow",
    methods: {
      canBecomeKeyWindow: { types: ["bool", []], implementation: function () { return true; } },
      canBecomeMainWindow: { types: ["bool", []], implementation: function () { return true; } },
    },
  });

  const win = $.PBPaneWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, 600, 800), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.opaque = false;
  win.backgroundColor = $.NSColor.clearColor;
  win.hasShadow = false;
  win.releasedWhenClosed = false;
  win.collectionBehavior = $.NSWindowCollectionBehaviorMoveToActiveSpace | $.NSWindowCollectionBehaviorFullScreenAuxiliary;

  const web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, 600, 800), $.WKWebViewConfiguration.alloc.init);
  web.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  web.wantsLayer = true;
  web.layer.cornerRadius = 10; // Claude's window corners
  web.layer.masksToBounds = true;
  win.contentView = web;
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(url + (url.includes("?") ? "&" : "?") + "pane=1")));

  let shown = false;
  let last = "";
  ObjC.registerSubclass({
    name: "PBTicker",
    methods: {
      "tick:": {
        types: ["void", ["id"]],
        implementation: function () {
          const c = claudeWindow(owner);
          const screen = c && screenAt(c.x + 10, c.y + 10);
          if (c && !roomAsked) {
            roomAsked = true;
            if (screen.x + screen.w - (c.x + c.w) < 420) makeRoom(owner, c, screen, opts.width > 0 ? opts.width : 560);
            return; // measure again next tick
          }
          const frame = c && paneFrame(c, screen, opts);
          if (!frame) {
            if (shown) { win.orderOut($()); shown = false; }
            return;
          }
          const screenH = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
          const key = [frame.x, frame.y, frame.w, frame.h].join(",");
          if (key !== last) {
            // Beside: both right-hand corners, like the window's. Inside: only the bottom one.
            // (CACornerMask: 2 = bottom-right, 8 = top-right in AppKit's bottom-left coordinates.)
            web.layer.maskedCorners = frame.mode === "beside" ? 2 | 8 : 2;
            // Cocoa measures from the bottom-left of the main screen.
            win.setFrameDisplay($.NSMakeRect(frame.x, screenH - frame.y - frame.h, frame.w, frame.h), true);
            last = key;
          }
          // Directly above the Claude window, so other apps' windows still cover both.
          win.orderWindowRelativeTo($.NSWindowAbove, c.number);
          shown = true;
        },
      },
    },
  });
  const ticker = $.PBTicker.alloc.init;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.08, ticker, "tick:", $(), true);
  console.log("PANE_READY");
  app.run;
}
