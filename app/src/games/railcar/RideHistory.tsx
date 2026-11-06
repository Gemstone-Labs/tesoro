"use client";

import Link from "next/link";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { CheckIcon, XIcon } from "@/components/ui";
import { rideRecordOf } from "@/lib/chain/ride-history";
import type { StoredRide } from "@/lib/chain/ride-record";
import { RailcarScreen, TELLS, type RailcarActions } from "./RailcarScreen";
import { replayRide, replayView } from "./replay";
import { clock } from "./words";

/** What the ride page reads from the Match history (`/api/match/<id>`). */
export interface RidePage {
  id: string;
  entry: number;
  ride?: StoredRide | null;
  /** Core refunded the car before anyone revealed its ride: there is nothing to replay. */
  refunded?: true;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * A finished ride from the round history: the Result as `me` saw it (anyone else sees the ride's), then everything the ride
 * revealed when it ended (the crash point, each Tell's lead, every Brake, the draw) and the replay of the published rules
 * against what the chain paid. `actions` are the Result's Play and Share buttons.
 */
export function RideHistory({ page, me, actions = {} }: { page: RidePage; me: string | null; actions?: RailcarActions }) {
  const rec = rideRecordOf(page);
  if (!rec && page.refunded)
    return (
      <section className="rc rc-check" aria-label="Refunded car">
        <h2 className="rc-check-h">Car refunded</h2>
        <p className="cut cut-card rc-check-note">This car was refunded before its ride was revealed, so there is no ride to check. Every entry went back to whoever paid it.</p>
        <p className="rc-check-note">
          <Link href="/play/railcar">Play Railcar</Link>
        </p>
      </section>
    );
  if (!rec) return <p className="status">This Match is not a Railcar ride.</p>;
  const r = replayRide(rec);
  const view = replayView(rec, r, me);
  const braked = rec.seats.filter((s) => rec.brakes.some((b) => b.seat === s.seat)).map((s) => ({ player: s.player, ms: rec.brakes.find((b) => b.seat === s.seat)!.ms }));
  return (
    <div className="rc-history">
      <RailcarScreen view={view} actions={actions} />
      <section className="rc rc-check" aria-label="Check this ride">
        <h2 className="rc-check-h">Check this ride</h2>
        {r.crashMs === null ? (
          <p className="cut cut-card rc-check-note">No draw came, so the ride was void and every entry went back.</p>
        ) : (
          <>
            <dl className="cut cut-card rc-check-facts">
              <div>
                <dt>Crash point</dt>
                <dd className="mono">{clock(r.crashMs)}</dd>
              </div>
              {r.impactMs !== null && r.impactMs !== r.crashMs && (
                <div>
                  <dt>Impact on the clock</dt>
                  <dd className="mono">{clock(r.impactMs)}</dd>
                </div>
              )}
            </dl>
            <ol className="rc-check-tells" aria-label="Tells">
              {r.tells.map((t, i) => {
                const { name, Icon } = TELLS[i];
                return (
                  <li key={t.stage} className="cut cut-card rc-check-tell">
                    <Icon aria-hidden="true" />
                    <b>{name}</b>
                    <span>{secs(t.leadMs)} before the wall</span>
                    <span className="mono rc-check-at">{clock(t.atMs)}</span>
                  </li>
                );
              })}
            </ol>
            {r.falseScrewsMs.length > 0 && <p className="rc-check-note">False screws at {r.falseScrewsMs.map(clock).join(", ")}</p>}
          </>
        )}
        <h3 className="rc-check-sub">Brakes</h3>
        {braked.length === 0 ? (
          <p className="rc-check-note">Nobody braked</p>
        ) : (
          <ul className="rc-check-brakes">
            {braked.map((b) => (
              <li key={b.player} className="cut cut-card rc-row">
                <span className="cut rc-av sm">
                  <PlayerAvatar account={b.player} size={32} />
                </span>
                <span className="rc-row-who">{b.player === me ? "You" : <PlayerName account={b.player} />}</span>
                <span className="mono">Braked at {clock(b.ms)}</span>
              </li>
            ))}
          </ul>
        )}
        {page.ride?.draw && (
          <>
            <h3 className="rc-check-sub">The draw</h3>
            <p className="cut cut-card rc-check-draw mono">{page.ride.draw}</p>
          </>
        )}
        {r.agrees ? (
          <p className="rc-check-verdict ok">
            <CheckIcon aria-hidden="true" />
            <span>Replayed with the published rules: every refund and place matches what was paid.</span>
          </p>
        ) : (
          <div className="rc-check-verdict bad" role="alert">
            <XIcon aria-hidden="true" />
            <div>
              <span>The replay differs from what was paid:</span>
              <ul>
                {r.differences.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <p className="rc-check-note">
          <Link href="/docs/railcar">How a ride is drawn</Link>
        </p>
      </section>
    </div>
  );
}
