import { createServer, type Server } from "node:http";

/**
 * Liveness of the main loop. The loop calls `beat` after every pass (clean or failed). The watchdog exits the
 * process once no pass has finished for `staleMs`, so the host's restart policy brings it back; `/healthz` reports
 * the same state for the host's checks.
 */
export class Health {
  private lastBeat: number;
  passes = 0;
  failedInARow = 0;

  constructor(
    readonly staleMs: number,
    now = Date.now(),
  ) {
    this.lastBeat = now;
  }

  beat(ok: boolean, now = Date.now()) {
    this.lastBeat = now;
    this.passes++;
    this.failedInARow = ok ? 0 : this.failedInARow + 1;
  }

  status(now = Date.now()) {
    const ageSecs = Math.round((now - this.lastBeat) / 1000);
    return { alive: now - this.lastBeat <= this.staleMs, passes: this.passes, failedInARow: this.failedInARow, lastPassSecsAgo: ageSecs };
  }
}

/** Checks every `everyMs`; on a stale loop logs once and calls `exit(1)`. */
export function startWatchdog(health: Health, log: (m: string) => void, exit: (code: number) => void = process.exit, everyMs = 30_000) {
  const timer = setInterval(() => {
    const s = health.status();
    if (s.alive) return;
    clearInterval(timer);
    log(`FATAL no pass finished in ${s.lastPassSecsAgo}s (limit ${health.staleMs / 1000}s); exiting so the host restarts the keeper`);
    exit(1);
  }, everyMs);
  timer.unref();
  return timer;
}

/** GET /healthz: 200 while the loop is alive, 503 once it is stale. Bound to `port` on `host` (all interfaces when unset). */
export function startHealthServer(health: Health, port: number, log: (m: string) => void, host?: string): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const s = health.status();
    res.writeHead(s.alive ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(s));
  });
  server.listen(port, host, () => log(`health on ${host ?? ""}:${port}/healthz`));
  server.unref();
  return server;
}
