// The user's own chromeArgs (config.json) are screened before they reach the browser: a switch that
// would open a debugging surface or weaken the browser's security is dropped, whatever its value.
// The driver's own pipe (--remote-debugging-pipe) and profile (--user-data-dir) are added by the
// driver from its launch options, never from these args, so they are not affected. Chromium reads a
// switch written with "--" or "-" (and "/" on Windows), its name case-insensitively on Windows: all
// of those spellings are caught.
//
// --no-sandbox is not dropped as a choice: it is the user's documented way to turn the sandbox off
// (engine.mjs sandboxDecision, ADR 0005), which reaches the driver as chromiumSandbox: false, and
// the driver then adds --no-sandbox itself. The raw switch is left out of the launch args.
const BLOCKED = [
  /^remote-debugging-/, // a CDP port, address or pipe of the user's: another program could drive the browser
  /^remote-allow-origins$/, // lets web origins connect to a debugging endpoint
  /^disable-web-security$/, // turns off the same-origin policy for every page
  /^disable-site-isolation-trials$/, // puts sites in shared renderer processes
  /^user-data-dir$/, // another profile than the helper's own
  /^load-extension$/, // an unpacked extension next to (or instead of) PairBrowse's side panel
  /^disable-extensions-except$/,
  /^allowlisted-extension-id$/, // another extension allowed to capture tabs without a click
];

// The switch name of an arg ("--Remote-Debugging-Port=9222" -> "remote-debugging-port"), or null
// for an arg that is not a switch.
export function switchName(arg, platform = process.platform) {
  const s = String(arg);
  const m = s.match(platform === "win32" ? /^(?:--|-|\/)([^=]+)/ : /^(?:--|-)([^=]+)/);
  if (!m) return null;
  return m[1].trim().toLowerCase();
}

// { kept, dropped }: dropped names each switch removed, as the user wrote it (value cut off).
export function screenChromeArgs(args, platform = process.platform) {
  const kept = [], dropped = [];
  for (const a of Array.isArray(args) ? args : []) {
    const name = switchName(a, platform);
    if (name && BLOCKED.some((re) => re.test(name))) dropped.push(String(a).split("=")[0]);
    else kept.push(a);
  }
  return { kept, dropped };
}

// The config warning (and helper log line) for dropped switches, or null.
export function droppedWarning(dropped) {
  if (!dropped.length) return null;
  return `config.json: chromeArgs ${dropped.join(", ")} dropped (PairBrowse never opens a debugging surface, loads another extension or profile, or turns off web security; see docs/security.md)`;
}

// The args launchArgs passes on: the screened ones, without --no-sandbox (the driver adds that
// itself when the sandbox is off).
export function launchableChromeArgs(args, platform = process.platform) {
  return screenChromeArgs(args, platform).kept.filter((a) => switchName(a, platform) !== "no-sandbox");
}
