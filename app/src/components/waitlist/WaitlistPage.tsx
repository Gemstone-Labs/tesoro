import Link from "next/link";
import { TesoroLogo, XFollow } from "@/components/brand";
import { INSET, LINES, clipAbove, clipBelowInset } from "@/components/waitlist/geometry";
import { Divider } from "@/components/waitlist/Divider";
import { LivingTexture } from "@/components/waitlist/LivingTexture";
import { VideoWall } from "@/components/waitlist/VideoWall";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { appHref } from "@/lib/landing/config";
import { WAITLIST_KICKER } from "@/lib/waitlist-copy";
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
          <XFollow variant="b" place="head" />
        </nav>
      </header>
      <div className="wl-strip">
      </div>
      <main className="wl-main">
        <p className={invite ? "wl-kicker wl-kicker-invite" : "wl-kicker"}>{invite ? `Invited by #${invite.spot} · ${invite.name}` : WAITLIST_KICKER}</p>
        <h1 className="wl-h1">
          Save your <em className="lp-hl">spot</em> for launch day.
        </h1>
        <WaitlistForm source={invite && `spot-${invite.spot}`} />
        <p className="wl-try">
          <a className="btn neutral cut cut-btn" href={appHref()}>
            Try it now
          </a>
          <XFollow variant="b" place="cta" />
        </p>
        {waiting && <p className="wl-count mono">{waiting}</p>}
        <p className="wl-more">
          <Link href="/welcome">How it works</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </p>
      </main>
    </div>
  );
}
