import type { Metadata } from "next";
import Link from "next/link";
import { TesoroLogo } from "@/components/brand";
import { INSET, LINES, clipAbove, clipBelowInset } from "@/components/waitlist/geometry";
import { Divider } from "@/components/waitlist/Divider";
import { VideoWall } from "@/components/waitlist/VideoWall";
import { ProtoLeft } from "@/components/waitlist/proto-left";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { appHref } from "@/lib/landing/config";
import { count } from "@/server/waitlist";

const DESCRIPTION = "Join the Tesoro waitlist for early access.";

export const metadata: Metadata = {
  title: "Tesoro · Join the waitlist",
  description: DESCRIPTION,
  openGraph: { title: "Tesoro · Join the waitlist", description: DESCRIPTION, siteName: "Tesoro", type: "website" },
  twitter: { card: "summary_large_image", title: "Tesoro · Join the waitlist", description: DESCRIPTION },
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
      <ProtoLeft />
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
        <p className="wl-kicker">Early access</p>
        <h1 className="wl-h1">
          Play now with <em className="lp-hl">yield</em> you haven&apos;t earned yet.
        </h1>
        <p className="wl-lede">
          Tesoro opens to a small group of players first. Join the waitlist for early access, and we&apos;ll email you the day it goes live.
        </p>
        <WaitlistForm />
        {waiting !== null && waiting >= SHOW_COUNT_FROM && <p className="wl-count mono">{waiting.toLocaleString("en-US")} players waiting</p>}
        <p className="wl-more">
          <Link href="/welcome">How it works</Link>
          <Link href="/docs">Docs</Link>
        </p>
      </main>
    </div>
  );
}
