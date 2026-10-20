// The private virtual screen (scripts/display.mjs): its geometry from config.json's virtualScreen,
// filled and bounded by the schema, the Xvfb arguments it gives, a display taken only when our own
// Xvfb holds its lock, its ownership record and reaping by it, stopping it, and server mode (own
// Xvfb or server.keepAlive, never a desktop).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, paths } from "../scripts/paths.mjs";
import { hasCommand, isOwnXvfb, lockPid, ownsDisplay, reapOwn, recordPath, screenGeometry, serverMode, startVirtualDisplay, xvfbArgs } from "../scripts/display.mjs";

const cfg = DEFAULT_CONFIG;

test("screenGeometry fills defaults", () => {
  assert.deepEqual(screenGeometry(cfg), { width: 1366, height: 900, depth: 24 }, "today's screen by default");
  assert.deepEqual(screenGeometry({}), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry(undefined), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: null }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 1280, height: 800 } }), { width: 1280, height: 800, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { depth: 16 } }), { width: 1366, height: 900, depth: 16 });
  // Each field out of bounds or of the wrong type takes its own default; the others stay.
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 799, height: 4321, depth: 30 } }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 7680, height: 600, depth: "24" } }), { width: 7680, height: 600, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 1280.5, height: "800", depth: 24 } }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 1e9, height: -1, depth: null } }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: [1280, 800] }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(Object.keys(screenGeometry({ virtualScreen: { width: 1280, extra: 1 } })), ["width", "height", "depth"], "nothing else passes");
});

test("the virtual screen gets the configured geometry", () => {
  const args = xvfbArgs(99, screenGeometry({ virtualScreen: { width: 1280, height: 800, depth: 16 } }), "/x/run/Xauthority");
  assert.deepEqual(args, [":99", "-screen", "0", "1280x800x16", "-auth", "/x/run/Xauthority", "-nolisten", "tcp"]);
  assert.deepEqual(xvfbArgs(100, screenGeometry(cfg), "a"), [":100", "-screen", "0", "1366x900x24", "-auth", "a", "-nolisten", "tcp"], "today's arguments by default");
});

test("the virtual screen started reports its display, pid and geometry", { skip: process.platform !== "linux" || !hasCommand("Xvfb") || !hasCommand("xauth") }, async () => {
  const screen = await startVirtualDisplay(() => {}, { name: "Xauthority-geometry", geometry: { width: 1280, height: 800, depth: 24 } });
  try {
    assert.deepEqual(screen.geometry, { width: 1280, height: 800, depth: 24 });
    assert.equal(screen.env.DISPLAY, screen.display);
    assert.ok(Number.isInteger(screen.pid) && screen.pid > 0);
  } finally {
    await screen.stop();
  }
});

// A fake machine for startVirtualDisplay: files by path, Xvfb children that do what each test
// says when waited on, and every kill recorded.
function fakeMachine({ files = {}, onWait = () => {} } = {}) {
  const fs = new Map(Object.entries(files));
  const children = [];
  let nextPid = 1000;
  const spawn = (bin, args) => {
    const child = { bin, args, display: Number(args[0].slice(1)), pid: nextPid++, exitCode: null, signalCode: null, killed: false };
    child.kill = () => { child.killed = true; child.signalCode = "SIGTERM"; };
    child.on = () => child;
    children.push(child);
    return child;
  };
  const deps = {
    has: () => true,
    spawn,
    exists: (p) => fs.has(p),
    read: (p) => (fs.has(p) ? fs.get(p) : null),
    xauth: () => true,
    wait: async () => onWait(children.at(-1), fs),
    tries: 3,
    reap: async () => {},
    save: () => {},
  };
  return { deps, children, fs };
}

// Our child gets display n: its socket and a lock holding its pid, as Xvfb writes it.
const ready = (child, fs) => {
  fs.set(`/tmp/.X11-unix/X${child.display}`, "");
  fs.set(`/tmp/.X${child.display}-lock`, `${String(child.pid).padStart(10)}\n`);
};

test("lockPid reads the pid an X lock file holds, nothing else", () => {
  assert.equal(lockPid("      4242\n"), 4242);
  assert.equal(lockPid("4242"), 4242);
  for (const other of [null, undefined, "", "\n", "abc", "42 43", "-42", "4.2", "12345678901", "\u0002\u0000\u0000\u0000"]) assert.equal(lockPid(other), null, JSON.stringify(other));
});

test("ownsDisplay: our running child, the socket, and a lock holding our pid", () => {
  const files = new Map([["/tmp/.X11-unix/X99", ""], ["/tmp/.X99-lock", "      1000\n"]]);
  const io = { exists: (p) => files.has(p), read: (p) => files.get(p) ?? null };
  const child = { pid: 1000, exitCode: null, signalCode: null };
  assert.equal(ownsDisplay(99, child, io), true);
  assert.equal(ownsDisplay(99, { ...child, pid: 1001 }, io), false, "the lock names another server");
  assert.equal(ownsDisplay(99, { ...child, exitCode: 1 }, io), false, "ours exited");
  assert.equal(ownsDisplay(99, { ...child, signalCode: "SIGKILL" }, io), false, "ours was killed");
  assert.equal(ownsDisplay(99, { ...child, pid: undefined }, io), false, "ours never started");
  assert.equal(ownsDisplay(100, child, io), false, "nothing on :100");
  files.delete("/tmp/.X11-unix/X99");
  assert.equal(ownsDisplay(99, child, io), false, "no socket yet");
  files.set("/tmp/.X11-unix/X99", "");
  files.delete("/tmp/.X99-lock");
  assert.equal(ownsDisplay(99, child, io), false, "no lock");
});

test("a display won by another server is not taken", async () => {
  // :99 is free when checked; while ours starts, another X server takes it (socket and lock with
  // its pid). Ours keeps running or exits: either way :99 isn't used, ours is ended, :100 is.
  for (const oursExits of [false, true]) {
    const logs = [];
    const { deps, children } = fakeMachine({
      onWait: (child, fs) => {
        if (child.display === 99) {
          fs.set("/tmp/.X11-unix/X99", "");
          fs.set("/tmp/.X99-lock", "      4242\n");
          if (oursExits) child.exitCode = 1;
        } else ready(child, fs);
      },
    });
    const screen = await startVirtualDisplay((line) => logs.push(line), { name: "Xauthority-race" }, deps);
    assert.equal(screen.display, ":100", `oursExits=${oursExits}`);
    assert.equal(screen.pid, children[1].pid);
    assert.deepEqual(screen.env, { DISPLAY: ":100", XAUTHORITY: screen.env.XAUTHORITY });
    assert.equal(children[0].killed, !oursExits, "a still-running loser is ended; an exited one isn't signalled");
    assert.equal(children[1].killed, false);
    assert.ok(logs.some((l) => l.includes(":99 not used (taken by another X server)")), logs.join("\n"));
  }
});

test("our Xvfb that never holds the lock is ended and the next number tried", async () => {
  const logs = [];
  const { deps, children } = fakeMachine({
    // :99: a socket appears but no lock (or a lock still empty); :100 comes up properly.
    onWait: (child, fs) => {
      if (child.display === 99) { fs.set("/tmp/.X11-unix/X99", ""); fs.set("/tmp/.X99-lock", ""); } else ready(child, fs);
    },
  });
  const screen = await startVirtualDisplay((line) => logs.push(line), { name: "Xauthority-race" }, deps);
  assert.equal(screen.display, ":100");
  assert.equal(children[0].killed, true);
  assert.ok(logs.some((l) => l.includes(":99 not used (Xvfb didn't start)")), logs.join("\n"));
  // Displays already locked or with a socket are skipped without starting anything.
  const busy = fakeMachine({ files: { "/tmp/.X99-lock": "      77\n", "/tmp/.X11-unix/X100": "" }, onWait: ready });
  const next = await startVirtualDisplay(() => {}, { name: "Xauthority-race" }, busy.deps);
  assert.equal(next.display, ":101");
  assert.deepEqual(busy.children.map((c) => c.display), [101]);
});

test("every display taken: the error names the range and how many other servers hold", async () => {
  const files = {};
  for (let n = 99; n <= 139; n++) files[`/tmp/.X${n}-lock`] = "      77\n";
  const { deps, children } = fakeMachine({ files });
  await assert.rejects(startVirtualDisplay(() => {}, {}, deps), /displays :99 to :139 are taken \(41 held by other X servers\)/);
  assert.equal(children.length, 0);
  // Ours exits on every number: the plain error, and nothing left running.
  const dead = fakeMachine({ onWait: (child) => { child.exitCode = 1; } });
  await assert.rejects(startVirtualDisplay(() => {}, {}, dead.deps), /^Error: couldn't start a virtual screen \(Xvfb\)$/);
  assert.equal(dead.children.length, 41);
  assert.ok(dead.children.every((c) => c.exitCode === 1));
});

test("serverMode: own Xvfb or keepAlive, never with display none or a desktop DISPLAY", () => {
  const keep = { ...cfg, server: { keepAlive: true } };
  assert.equal(serverMode(cfg, {}, "linux"), true, "no screen: its own Xvfb");
  assert.equal(serverMode({ ...cfg, display: "xvfb" }, { DISPLAY: ":0" }, "linux"), true, "xvfb always");
  assert.equal(serverMode(cfg, { DISPLAY: ":0" }, "linux"), false, "desktop Linux");
  assert.equal(serverMode(cfg, { WAYLAND_DISPLAY: "wayland-0" }, "linux"), false);
  assert.equal(serverMode({ ...cfg, display: "none" }, {}, "linux"), false, "display none");
  assert.equal(serverMode(cfg, {}, "darwin"), false, "macOS");
  assert.equal(serverMode(cfg, {}, "win32"), false, "Windows");
  // keepAlive says this is a server, screen or not.
  assert.equal(serverMode(keep, { DISPLAY: ":0" }, "linux"), true);
  assert.equal(serverMode({ ...keep, display: "none" }, {}, "linux"), true);
  assert.equal(serverMode(keep, {}, "darwin"), true);
  // Only a true keepAlive counts.
  for (const server of [{ keepAlive: false }, { keepAlive: "true" }, { keepAlive: 1 }, {}, null, undefined]) {
    assert.equal(serverMode({ ...cfg, server }, { DISPLAY: ":0" }, "linux"), false, JSON.stringify(server));
  }
});

test("isOwnXvfb: Xvfb's command line behind our cookie, nothing else", () => {
  const auth = "/home/u/.pairbrowse/run/Xauthority";
  const line = (...argv) => argv.join("\0") + "\0";
  assert.equal(isOwnXvfb(line("Xvfb", ...xvfbArgs(99, screenGeometry(cfg), auth)), auth), true);
  assert.equal(isOwnXvfb(line("/usr/bin/Xvfb", ":99", "-auth", auth), auth), true);
  assert.equal(isOwnXvfb(line("Xvfb", ":99", "-auth", `${auth}-check`), auth), false, "another cookie");
  assert.equal(isOwnXvfb(line("Xvfb", ":99", auth), auth), false, "the path not as -auth");
  assert.equal(isOwnXvfb(line("node", "Xvfb", "-auth", auth), auth), false, "another program");
  assert.equal(isOwnXvfb(line("Xorg", ":99", "-auth", auth), auth), false);
  for (const other of [null, "", undefined, 42]) assert.equal(isOwnXvfb(other, auth), false, String(other));
  assert.equal(isOwnXvfb(line("Xvfb", "-auth", ""), ""), false, "no cookie named");
});

// A fake machine for reapOwn: files with owners, live pids, every signal and removal recorded.
// A pid signalled with one in dies dies at that signal.
function fakeReap({ files = {}, owners = {}, alive = [], dies = ["SIGTERM", "SIGKILL"], uid = 501 } = {}) {
  const fs = new Map(Object.entries(files));
  const live = new Set(alive);
  const kills = [], removed = [], logs = [];
  const deps = {
    log: (l) => logs.push(l),
    read: (p) => (fs.has(p) ? fs.get(p) : null),
    alive: (pid) => live.has(pid),
    kill: (pid, sig) => { kills.push([pid, sig]); if (dies.includes(sig)) live.delete(pid); return true; },
    owner: (p) => (p in owners ? owners[p] : fs.has(p) ? uid : null),
    remove: (p) => { removed.push(p); fs.delete(p); },
    wait: async () => {},
    uid,
  };
  return { deps, fs, kills, removed, logs };
}

const NAME = "Xauthority-reap";
const AUTH = join(paths.run, NAME);
const rec = (over = {}) => JSON.stringify({ display: ":99", pid: 4242, auth: AUTH, geometry: { width: 1366, height: 900, depth: 24 }, startedAt: 1, ...over });
const ourCmdline = (auth = AUTH) => ["Xvfb", ...xvfbArgs(99, screenGeometry(cfg), auth)].join("\0") + "\0";

test("our orphaned Xvfb is ended, a pid with another cmdline is not", async () => {
  // Ours, still running behind our cookie: SIGTERM, and it goes; its lock went with it.
  const m = fakeReap({ files: { [recordPath(NAME)]: rec(), "/proc/4242/cmdline": ourCmdline() }, alive: [4242] });
  m.fs.set("/proc/4242", "");
  assert.deepEqual(await reapOwn(NAME, m.deps), { ended: true, cleared: false });
  assert.deepEqual(m.kills, [[4242, "SIGTERM"]]);
  assert.ok(m.removed.includes(recordPath(NAME)) && m.removed.includes(AUTH), "record and cookie go");
  // One that ignores SIGTERM gets SIGKILL after the wait; its stale lock is then cleared too.
  const stubborn = fakeReap({ files: { [recordPath(NAME)]: rec(), "/proc/4242": "", "/proc/4242/cmdline": ourCmdline(), "/tmp/.X99-lock": "      4242\n", "/tmp/.X11-unix/X99": "" }, alive: [4242], dies: ["SIGKILL"] });
  assert.deepEqual(await reapOwn(NAME, stubborn.deps), { ended: true, cleared: true });
  assert.deepEqual(stubborn.kills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  assert.ok(stubborn.removed.includes("/tmp/.X99-lock") && stubborn.removed.includes("/tmp/.X11-unix/X99"));
  // One that outlives SIGKILL too (stuck in the kernel): not counted as ended, its lock and record stay.
  const stuck = fakeReap({ files: { [recordPath(NAME)]: rec(), "/proc/4242": "", "/proc/4242/cmdline": ourCmdline(), "/tmp/.X99-lock": "      4242\n" }, alive: [4242], dies: [] });
  assert.deepEqual(await reapOwn(NAME, stuck.deps), { ended: false, cleared: false });
  assert.deepEqual(stuck.kills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  assert.ok(!stuck.removed.includes(recordPath(NAME)), "the record stays for the next start");
  assert.ok(!stuck.removed.includes("/tmp/.X99-lock"), "the lock of a live pid stays");
  assert.ok(stuck.removed.includes(AUTH), "the cookie goes");
  assert.ok(stuck.logs.some((l) => l.includes("didn't end")), stuck.logs.join("\n"));
  // The pid now belongs to another program, another cookie's Xvfb, or another user: never signalled.
  for (const [cmd, owner] of [["bash\0", 501], [ourCmdline(`${AUTH}-check`), 501], [ourCmdline(), 0], [null, 501]]) {
    const other = fakeReap({ files: { [recordPath(NAME)]: rec(), "/proc/4242": "", "/tmp/.X99-lock": "      4242\n", ...(cmd ? { "/proc/4242/cmdline": cmd } : {}) }, owners: { "/proc/4242": owner }, alive: [4242] });
    assert.deepEqual(await reapOwn(NAME, other.deps), { ended: false, cleared: false }, JSON.stringify(cmd));
    assert.deepEqual(other.kills, []);
    assert.ok(!other.removed.includes("/tmp/.X99-lock"), "the lock of a live pid stays");
    assert.ok(other.removed.includes(recordPath(NAME)), "the record is done with");
  }
});

test("a stale lock of our own dead Xvfb is removed", async () => {
  const m = fakeReap({ files: { [recordPath(NAME)]: rec(), "/tmp/.X99-lock": "      4242\n", "/tmp/.X11-unix/X99": "" } });
  assert.deepEqual(await reapOwn(NAME, m.deps), { ended: false, cleared: true });
  assert.deepEqual(m.kills, [], "nothing to signal");
  assert.deepEqual(m.removed.sort(), [AUTH, "/tmp/.X11-unix/X99", "/tmp/.X99-lock", recordPath(NAME)].sort());
  assert.ok(m.logs.some((l) => l.includes(":99: removed the lock")), m.logs.join("\n"));
  // Our lock beside another user's socket: the socket stays.
  const s = fakeReap({ files: { [recordPath(NAME)]: rec(), "/tmp/.X99-lock": "      4242\n", "/tmp/.X11-unix/X99": "" }, owners: { "/tmp/.X11-unix/X99": 0 } });
  assert.deepEqual(await reapOwn(NAME, s.deps), { ended: false, cleared: true });
  assert.ok(!s.removed.includes("/tmp/.X11-unix/X99"));
});

test("foreign locks are never touched", async () => {
  const lockFiles = { "/tmp/.X99-lock": "      4242\n", "/tmp/.X11-unix/X99": "" };
  const cases = [
    ["another pid in the lock", { files: { [recordPath(NAME)]: rec(), ...lockFiles, "/tmp/.X99-lock": "      7777\n" } }],
    ["the lock is another user's", { files: { [recordPath(NAME)]: rec(), ...lockFiles }, owners: { "/tmp/.X99-lock": 1000 } }],
    ["the lock's pid runs (another program now)", { files: { [recordPath(NAME)]: rec(), ...lockFiles }, alive: [4242] }],
    ["the record names another cookie", { files: { [recordPath(NAME)]: rec({ auth: "/tmp/other" }), ...lockFiles } }],
    ["the record names a display outside ours", { files: { [recordPath(NAME)]: rec({ display: ":0" }), "/tmp/.X0-lock": "      4242\n" } }],
    ["the record's pid isn't a pid", { files: { [recordPath(NAME)]: rec({ pid: "4242" }), ...lockFiles } }],
    ["the record isn't JSON", { files: { [recordPath(NAME)]: "{", ...lockFiles } }],
    ["no uid (not a POSIX system)", { files: { [recordPath(NAME)]: rec(), ...lockFiles }, uid: undefined }],
  ];
  for (const [why, setup] of cases) {
    const m = fakeReap(setup);
    if ("uid" in setup) m.deps.uid = setup.uid;
    assert.deepEqual(await reapOwn(NAME, m.deps), { ended: false, cleared: false }, why);
    assert.deepEqual(m.kills, [], why);
    assert.deepEqual(m.removed.filter((p) => p.startsWith("/tmp/")), [], why);
  }
  // No record: nothing at all is touched.
  const none = fakeReap({ files: lockFiles });
  assert.deepEqual(await reapOwn(NAME, none.deps), { ended: false, cleared: false });
  assert.deepEqual([none.kills, none.removed], [[], []]);
});

test("the started screen reaps first and writes its ownership record", async () => {
  const calls = [];
  const { deps, children } = fakeMachine({ onWait: ready });
  deps.reap = async (name) => { calls.push(["reap", name]); };
  deps.save = (file, r) => calls.push(["save", file, r]);
  const screen = await startVirtualDisplay(() => {}, { name: NAME, geometry: { width: 1280, height: 800, depth: 24 } }, deps);
  assert.deepEqual(calls[0], ["reap", NAME], "reaped before any display is tried");
  const [, file, r] = calls[1];
  assert.equal(file, recordPath(NAME));
  assert.equal(file, join(paths.run, `${NAME}.json`));
  assert.deepEqual({ ...r, startedAt: 0 }, { display: ":99", pid: children[0].pid, auth: AUTH, geometry: { width: 1280, height: 800, depth: 24 }, startedAt: 0 });
  assert.ok(Number.isInteger(r.startedAt));
  assert.equal(screen.env.XAUTHORITY, AUTH);
  // A record that can't be written leaves the screen working, and says so.
  const logs = [];
  const broken = fakeMachine({ onWait: ready });
  broken.deps.save = () => { throw new Error("disk full"); };
  const still = await startVirtualDisplay((l) => logs.push(l), { name: NAME }, broken.deps);
  assert.equal(still.display, ":99");
  assert.ok(logs.some((l) => l.includes("record wasn't written (disk full)")), logs.join("\n"));
});

test("the default record is owner-only and reapOwn reads it back", { skip: process.platform === "win32" }, async () => {
  const { deps } = fakeMachine({ onWait: ready });
  delete deps.save;
  const screen = await startVirtualDisplay(() => {}, { name: NAME }, deps);
  const file = recordPath(NAME);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, screen.pid);
  // Its pid is a fake one: reapOwn with a dead pid and no lock only drops the record and cookie.
  const out = await reapOwn(NAME, { alive: () => false, uid: process.getuid?.() ?? 0 });
  assert.deepEqual(out, { ended: false, cleared: false });
  assert.equal(existsSync(file), false);
});

// A started screen on a fake machine whose Xvfb exits at the signals in dies.
async function startedFake(dies) {
  const signals = [], removed = [];
  const { deps, children } = fakeMachine({ onWait: ready });
  deps.remove = (p) => removed.push(p);
  const screen = await startVirtualDisplay(() => {}, { name: NAME }, deps);
  const child = children[0];
  child.kill = (sig) => { signals.push(sig); if (dies.includes(sig)) child.signalCode = sig; return true; };
  return { screen, child, signals, removed };
}

test("stop waits, escalates and removes cookie and record; stopNow is synchronous", async () => {
  // Xvfb that exits at SIGTERM: no SIGKILL.
  const polite = await startedFake(["SIGTERM"]);
  await polite.screen.stop();
  assert.deepEqual(polite.signals, ["SIGTERM"]);
  assert.deepEqual(polite.removed, [AUTH, recordPath(NAME)]);
  await polite.screen.stop();
  assert.deepEqual(polite.signals, ["SIGTERM"], "a second stop does nothing more");
  assert.deepEqual(polite.removed, [AUTH, recordPath(NAME)]);
  // Xvfb that ignores SIGTERM: about 1 s of waiting (in 50 ms steps), then SIGKILL, and the record
  // goes only once it has exited (here two steps later, as a real exit event comes after the signal).
  const ignoring = async (killed) => {
    const waits = [], signals = [], removed = [];
    let started = false, dying = killed;
    const { deps, children } = fakeMachine({ onWait: (child, fs) => (started ? null : ready(child, fs)) });
    const startWait = deps.wait;
    deps.wait = async (ms) => {
      if (!started) return startWait(ms);
      waits.push(ms);
      if (signals.includes("SIGKILL") && dying !== null && --dying === 0) children[0].signalCode = "SIGKILL";
    };
    deps.remove = (p) => removed.push(p);
    const screen = await startVirtualDisplay(() => {}, { name: NAME }, deps);
    started = true;
    children[0].kill = (sig) => { signals.push(sig); return true; };
    return { screen, waits, signals, removed };
  };
  const stubborn = await ignoring(2);
  const stopping = stubborn.screen.stop();
  assert.equal(stubborn.screen.stop(), stopping, "one stop at a time");
  await stopping;
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stubborn.waits.length, 22);
  assert.ok(stubborn.waits.every((ms) => ms === 50));
  assert.deepEqual(stubborn.removed, [AUTH, recordPath(NAME)]);
  // Still running 1 s after SIGKILL: the cookie goes, the record stays so the next start's reapOwn
  // ends it or clears the lock and socket it left.
  const unkillable = await ignoring(null);
  await unkillable.screen.stop();
  assert.deepEqual(unkillable.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(unkillable.waits.length, 40);
  assert.deepEqual(unkillable.removed, [AUTH]);
  // stopNow: synchronous, no waiting. Xvfb still exiting keeps the record for the next reapOwn.
  const now = await startedFake(["SIGKILL"]);
  assert.equal(now.screen.stopNow(), undefined, "returns nothing to wait on");
  assert.deepEqual(now.signals, ["SIGTERM"]);
  assert.deepEqual(now.removed, [AUTH]);
  // Already exited (after a stop, or Xvfb died): cookie and record go, nothing is signalled.
  const done = await startedFake(["SIGTERM"]);
  done.child.exitCode = 0;
  done.screen.stopNow();
  assert.deepEqual(done.signals, []);
  assert.deepEqual(done.removed, [AUTH, recordPath(NAME)]);
});
