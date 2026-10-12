import Link from "next/link";
import { TesoroLogo } from "@/components/brand";
import { INSET, LINES, clipAbove, clipBelowInset } from "@/components/waitlist/geometry";
import { Divider } from "@/components/waitlist/Divider";
import { LivingTexture } from "@/components/waitlist/LivingTexture";
import { VideoWall } from "@/components/waitlist/VideoWall";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { appHref } from "@/lib/landing/config";
import { waitingLabel } from "@/lib/waitlist-count";
import type { SpotGem } from "@/lib/waitlist-spot";
import { count } from "@/server/waitlist";

/** The waitlist page. `invite` is the spot whose shared link brought the visitor here. */
export async function WaitlistPage({ invite }: { invite?: SpotGem }) {
  const waiting = waitingLabel(await count());
  const frame = {
    "--above-wide": clipAbove(LINES.wide),
    "--above-tall": clipAbove(LINES.tall),
    "--in-wide": clipBelowInset(LINES.wide, INSET.wide, "x"),
    "--in-tall": clipBelowInset(LINES.tall, INSET.tall, "y"),
  } as React.CSSProperties;
  return (
    <div className="wl" style={frame}>
      <VideoWall />
      <div className="wl-floor" aria-hidden>
        <div className="wl-floor-in" />
      </div>
      <Divider />
      <LivingTexture />
      <header className="wl-top">
        <Link href="/" className="wl-logo" aria-label="Tesoro">
          <TesoroLogo height={30} tone="dark" />
        </Link>
        <nav className="wl-nav" aria-label="Elsewhere">
          <Link href="/welcome" className="wl-hide-phone">
            How it works
          </Link>
          <Link href="/docs" className="wl-hide-phone">
            Docs
          </Link>
          <a href={appHref()}>Try the app</a>
        </nav>
      </header>
      <main className="wl-main">
        <p className="wl-kicker">{invite ? `Invited by #${invite.spot} · ${invite.name}` : "Early access"}</p>
        <h1 className="wl-h1">
          Play now with <em className="lp-hl">yield</em> you haven&apos;t earned yet.
        </h1>
        <p className="wl-lede">
          Tesoro opens to a small group of players first. Join the waitlist for early access, and we&apos;ll email you the day it goes live.
        </p>
        <WaitlistForm source={invite && `spot-${invite.spot}`} />
        {waiting && <p className="wl-count mono">{waiting}</p>}
        <p className="wl-more">
          <Link href="/welcome">How it works</Link>
          <Link href="/docs">Docs</Link>
        </p>
      </main>
    </div>
  );
}
