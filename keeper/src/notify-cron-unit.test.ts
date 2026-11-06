import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Vercel's cron cannot run every 5 minutes on the plan in use; the VPS timer calls the route instead. The route keeps the open-Match table (the safety sweep reads it) and mails no one; the unit keeps its old name.
describe("the open-Match cron (tesoro-notify-cron)", () => {
  const service = read("../deploy/tesoro-notify-cron.service");
  const timer = read("../deploy/tesoro-notify-cron.timer");

  it("calls /api/cron/notify with the CRON_SECRET bearer and fails on a non-2xx answer", () => {
    assert.match(service, /EnvironmentFile=%h\/\.config\/tesoro-keeper\.env/);
    assert.match(service, /curl[^\n]* -f/);
    assert.match(service, /Authorization: Bearer \$CRON_SECRET/);
    assert.match(service, /NOTIFY_CRON_URL/);
  });

  it("runs every 5 minutes", () => {
    assert.match(timer, /OnCalendar=\*:0\/5/);
    assert.match(timer, /Unit=tesoro-notify-cron\.service/);
    assert.match(timer, /WantedBy=timers\.target/);
  });

  it("is not a Vercel cron, and no daily digest cron exists", () => {
    assert.equal(existsSync(new URL("../../app/vercel.json", import.meta.url)), false);
  });
});
