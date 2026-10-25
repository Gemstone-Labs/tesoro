import Link from "next/link";
import { TesoroLogo } from "@/components/brand";
import { VideoWall } from "@/components/waitlist/VideoWall";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { appHref } from "@/lib/landing/config";
import { WAITLIST_KICKER, WAITLIST_LEDE } from "@/lib/waitlist-copy";
import { waitingLabel } from "@/lib/waitlist-count";
import type { SpotGem } from "@/lib/waitlist-spot";
import { count } from "@/server/waitlist";

/** The waitlist page. `invite` is the spot whose shared link brought the visitor here. */
export async function WaitlistPage({ invite }: { invite?: SpotGem }) {
  const waiting = waitingLabel(await count());
  return (
    <div className="wl">
      <VideoWall />
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
        <p className="wl-kicker">{invite ? `Invited by #${invite.spot} · ${invite.name}` : WAITLIST_KICKER}</p>
        <h1 className="wl-h1">
          Play now with yield you haven&apos;t earned yet.
        </h1>
        <p className="wl-lede">
          {WAITLIST_LEDE}
        </p>
        <WaitlistForm source={invite && `spot-${invite.spot}`} />
        <div className="wl-links">
          <p className="wl-try">
            <a href={appHref()}>Try it now</a>
          </p>
          <p className="wl-more">
            <Link href="/welcome">How it works</Link>
            <Link href="/docs">Docs</Link>
          </p>
        </div>
        {waiting && <p className="wl-count mono">{waiting}</p>}
      </main>
    </div>
  );
}
