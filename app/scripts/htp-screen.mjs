/**
 * A hidden screen for recording the How to play clips at 60 fps with a real, GPU-composited Chromium.
 *
 * `screenUp("phone" | "desktop")` starts a PRIVATE headless Hyprland (its own Wayland socket and its own instance, nothing to do
 * with the person's session, lock screen, windows or workspaces), makes one output of the right size in it (phone 1170x2532, desktop
 * 2880x1800), and starts a kiosk Chromium on that output with a device scale factor of 3 (phone) or 2 (desktop). Playwright connects
 * over CDP. `screenEnv()` is the environment that points a tool (wf-recorder, grim) at that screen. `screenDown()` closes it all.
 *
 * A headless Chromium or a CDP screencast cannot do this: it delivers an animation as one or two changed frames, so moves teleport.
 * (A second output on the person's own Hyprland does not work either: the screen lock covers it and the recording is black.)
 *
 * Needs `Hyprland` and `LIBSEAT_BACKEND=noop` to start without a seat.
 */
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const require = createRequire(import.meta.url);

export const OUTPUT = "HTPREC";
export const CDP_PORT = Number(process.env.HTP_CDP_PORT ?? 9444);
export const SCREENS = {
  phone: { css: [390, 844], dsf: Number(process.env.HTP_PHONE_DSF ?? 2), chromiumFlags: ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] },
  desktop: { css: [1440, 900], dsf: Number(process.env.HTP_DESKTOP_DSF ?? 1), chromiumFlags: [] },
};

const state = { browser: null, hypr: null, chromium: null, env: null, sig: null };
const RUNTIME = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;

/** The environment that points tools at the hidden screen. */
export const screenEnv = () => state.env;

const hyprctl = (...args) => run("hyprctl", args, { env: state.env });
const hypr = (lua) => hyprctl("eval", lua);

export async function screenUp(setName, opts = {}) {
  try {
    return await start(setName, opts);
  } catch (e) {
    await screenDown();
    throw e;
  }
}

async function start(setName, { playwright = process.env.PW ?? "playwright-core", chrome = process.env.CHROME ?? "/usr/bin/chromium" } = {}) {
  const sc = SCREENS[setName];
  const [W, H] = [sc.css[0] * sc.dsf, sc.css[1] * sc.dsf];
  const dir = join(homedir(), ".cache/tesoro-tmp/rec2");
  mkdirSync(dir, { recursive: true });
  const conf = join(dir, "hyprland.lua");
  writeFileSync(conf, `hl.config({ general = { gaps_in = 0, gaps_out = 0, border_size = 0 }, misc = { disable_watchdog_warning = true, disable_hyprland_logo = true, disable_splash_rendering = true, force_default_wallpaper = 0 }, animations = { enabled = false }, cursor = { invisible = true } })\nhl.window_rule({ match = { class = ".*" }, fullscreen = true })\n`);

  // the private compositor: a new instance directory and a new wayland-N socket appear
  const before = new Set(readdirSync(join(RUNTIME, "hypr")));
  const socketsBefore = new Set(readdirSync(RUNTIME).filter((f) => /^wayland-\d+$/.test(f)));
  const clean = { ...process.env, LIBSEAT_BACKEND: "noop", AQ_BACKENDS: "headless" };
  for (const k of ["WAYLAND_DISPLAY", "DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "HYPRLAND_CMD"]) delete clean[k];
  state.hypr = spawn("Hyprland", ["--config", conf], { env: clean, stdio: "ignore" });
  let sig = null;
  let socket = null;
  for (let i = 0; i < 40 && !(sig && socket); i++) {
    await sleep(500);
    sig = readdirSync(join(RUNTIME, "hypr")).find((d) => !before.has(d)) ?? null;
    socket = readdirSync(RUNTIME).find((f) => /^wayland-\d+$/.test(f) && !socketsBefore.has(f)) ?? null;
  }
  if (!sig || !socket) throw new Error("the private Hyprland did not start (needs LIBSEAT_BACKEND=noop and AQ_BACKENDS=headless)");
  state.sig = sig;
  state.env = { ...process.env, WAYLAND_DISPLAY: socket, HYPRLAND_INSTANCE_SIGNATURE: sig, XDG_SESSION_TYPE: "wayland" };
  delete state.env.DISPLAY;
  await sleep(500);

  // the compositor's own banner ("started without start-hyprland") would be recorded: dismiss it
  await hyprctl("dismissnotify").catch(() => {});
  await hyprctl("output", "create", "headless", OUTPUT);
  await sleep(800);
  await hypr(`hl.monitor({ output = "${OUTPUT}", mode = "${W}x${H}@60", position = "0x0", scale = 1 })`);
  await sleep(500);

  const profile = join(dir, `profile-${setName}`);
  mkdirSync(profile, { recursive: true });
  const args = [`--force-device-scale-factor=${sc.dsf}`, `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, "--kiosk", "--no-first-run", "--no-default-browser-check", "--ozone-platform=wayland", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", ...sc.chromiumFlags, "about:blank"];
  state.chromium = spawn(chrome, args, { env: state.env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break; } catch {}
    await sleep(500);
  }
  await sleep(1500);
  const { chromium } = require(playwright);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // Chromium keeps its window at least ~500 CSS px wide, wider than a phone: fix the page's viewport to the phone's size
  // (the window itself is the screen, so the page fills it exactly)
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: sc.css[0], height: sc.css[1], deviceScaleFactor: sc.dsf, mobile: false });
  state.browser = browser;
  return { browser, ctx, page, W, H };
}

export async function screenDown() {
  try {
    const s = await state.browser?.newBrowserCDPSession();
    await s?.send("Browser.close");
  } catch {}
  await sleep(500);
  state.chromium?.kill("SIGTERM");
  state.hypr?.kill("SIGTERM");
  await sleep(800);
  state.hypr?.kill("SIGKILL");
  state.browser = state.hypr = state.chromium = state.env = null;
}
