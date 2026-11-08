import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [join(dir, f)] : []));
const all = files(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));

// Founder decision 2026-11-06: Tesoro sends Players no email. The mail sender stays for founder alerts and waitlist Invites only.
describe("no Player emails", () => {
  it("only the keeper-alert route, the sponsor alerts and the Invite sender use the mail sender", () => {
    const users = all.filter((f) => /notify\/sender"/.test(f.text)).map((f) => f.path).sort();
    expect(users).toEqual(["app/api/notify/alert/route.ts", "server/invite/send.ts", "server/sponsor/env.ts"].sort());
  });

  it("has no Player notify route, digest cron or notification settings screen", () => {
    expect(readdirSync(join(SRC, "app/api/notify"))).toEqual(["alert"]);
    expect(readdirSync(join(SRC, "app/api/cron"))).not.toContain("digest");
    expect(all.filter((f) => /notify_settings|NotifySettings|"tesoro-notify"/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});
