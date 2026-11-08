// Start Storybook, then run: node scripts/check-win-hint.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const base = process.env.BASE ?? "http://localhost:6006";
const session = "tesoro-win-hint-check";
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const run = (...args) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 180_000 });
const check = (code) => run("eval", `(async () => { ${code} })()`);
const replay = `document.querySelector('.sbm-btn').click(); await new Promise(r => setTimeout(r, 150));`;

try {
  for (const story of ["win", "backed-win"]) {
    run("open", `${base}/iframe.html?id=motion-moment-overlay--${story}&viewMode=story`);
    run("wait", ".sbm-btn");
    for (const width of [320, 390, 1023, 1024, 1440]) {
      run("set", "viewport", String(width), "844");
      check(`${replay}
        const button = document.querySelector('.mo-close');
        if (!button) throw new Error('Win overlay did not render');
        const hidden = getComputedStyle(button).display === 'none';
        if (hidden !== (${width} < 1024)) throw new Error('Incorrect Continue / Esc visibility at ${width}px');
        const focus = document.querySelector(${width} < 1024 ? '.mo' : '.mo-close');
        if (document.activeElement !== focus) throw new Error('Focus did not enter the overlay');
        return 'PASS ${story} ${width}px';
      `);
      if (shots && [390, 1440].includes(width)) {
        check(replay);
        run("screenshot", `${shots}/${story}-${width}.png`);
      }
      check(`document.querySelector('.mo').click();
        await new Promise(r => setTimeout(r, 50));
        if (document.querySelector('.mo')) throw new Error('Tap did not dismiss overlay');
      `);
      console.log(`PASS ${story} ${width}px: hint visibility, focus, tap dismissal`);
    }
    run("set", "viewport", "390", "844");
    check(`${replay}
      await new Promise(r => setTimeout(r, 3100));
      if (document.querySelector('.mo')) throw new Error('Automatic dismissal failed');
    `);
    for (const key of ["Escape", "Enter"]) {
      check(`${replay}
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        if (document.querySelector('.mo')) throw new Error('${key} did not dismiss overlay');
      `);
    }
    console.log(`PASS ${story}: automatic dismissal and Escape / Enter`);
  }
} finally {
  run("close");
}
