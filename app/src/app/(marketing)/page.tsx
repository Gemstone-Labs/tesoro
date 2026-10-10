import type { Metadata } from "next";
import Link from "next/link";
import { TesoroLogo } from "@/components/brand";
import { LINES, clipAbove, clipBelow } from "@/components/waitlist/geometry";
import { GemDivider } from "@/components/waitlist/GemDivider";
import { VideoWall } from "@/components/waitlist/VideoWall";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { LAUNCH_STAGE, appHref } from "@/lib/landing/config";
import { count } from "@/server/waitlist";

export const metadata: Metadata = {
  title: "Tesoro · Join the waitlist",
  alternates: { canonical: "/" },
};

/** The count is read at most once a minute. */
export const revalidate = 60;

const SHOW_COUNT_FROM = 50;

export default async function Waitlist() {
  const waiting = await count();
  const frame = {
    "--above-wide": clipAbove(LINES.wide),
    "--above-tall": clipAbove(LINES.tall),
    "--below-wide": clipBelow(LINES.wide),
    "--below-tall": clipBelow(LINES.tall),
  } as React.CSSProperties;
  return (
    <div className="wl" style={frame}>
      <VideoWall />
      <div className="wl-floor" aria-hidden>
        <div className="wl-floor-in" />
      </div>
      <GemDivider />
      <header className="wl-top">
        <Link href="/" className="wl-logo" aria-label="Tesoro">
          <TesoroLogo height={30} tone="dark" />
        </Link>
        <nav className="wl-nav" aria-label="Elsewhere">
          <Link href="/welcome">How it works</Link>
          <Link href="/docs">Docs</Link>
          <a href={appHref()}>Try the app</a>
        </nav>
      </header>
      <main className="wl-main">
        <p className="wl-kicker">Early access</p>
        <h1 className="wl-h1">
          Play now with <em className="lp-hl">yield</em> you haven&apos;t earned yet.
        </h1>
        <p className="wl-lede">
          Lock a staking token and play head-to-head casual games with its yield up front, as Gemas. Your Principal is never played.
        </p>
        <WaitlistForm />
        {waiting !== null && waiting >= SHOW_COUNT_FROM && <p className="wl-count mono">{waiting.toLocaleString("en-US")} players waiting</p>}
        {LAUNCH_STAGE === "testnet" && <p className="wl-stage mono">test mode · no real value</p>}
      </main>
    </div>
  );
}
