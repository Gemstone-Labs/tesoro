import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui";
import { fmtGemas } from "@/lib/format";
import { practiceHref } from "@/lib/game-params";
import { appHref } from "@/lib/landing/config";
import "@/components/win/win.css";
import { GAME_NAMES } from "@/lib/mock";
import { parseMatchId, winShareText } from "@/lib/win-card";
import { loadWin } from "@/server/win-card";
import { CARD } from "@/server/spot-card";

type Props = { params: Promise<{ match: string }> };

const cardUrl = (id: string) => `/win/${id}/card`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const raw = (await params).match;
  const id = parseMatchId(raw);
  const win = id === null ? null : await loadWin(id);
  if (!win) return {};
  const title = `${win.name} won a ${GAME_NAMES[win.game]} Match on Tesoro`;
  const description = "Play casual games now with yield you haven't earned yet. Try Tesoro in test mode.";
  const alt = winShareText(win);
  const images = [{ url: cardUrl(win.id), width: CARD.width, height: CARD.height, alt }];
  return {
    title,
    description,
    openGraph: { title, description, siteName: "Tesoro", type: "website", images },
    twitter: { card: "summary_large_image", title, description, images },
    alternates: { canonical: `/win/${win.id}` },
    robots: { index: false },
  };
}

export const revalidate = 60;

/** A shared win: the card, and the way into Tesoro. Only a settled Match with a winner has one. */
export default async function WinPage({ params }: Props) {
  const id = parseMatchId((await params).match);
  const win = id === null ? null : await loadWin(id);
  if (!win) notFound();
  const game = GAME_NAMES[win.game];
  return (
    <main className="win-page">
      <h1>{win.gemas > 0 ? `${win.name} won ${fmtGemas(win.gemas)} Gemas playing ${game}` : `${win.name} won a ${game} Match`}</h1>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="win-card" src={cardUrl(win.id)} width={CARD.width} height={CARD.height} alt={winShareText(win)} />
      <p className="win-explain">Gemas are play money that comes from staking yield. You can practice free, no account needed.</p>
      <div className="win-actions">
        <Button variant="money" size="lg" href={appHref(`/play/${win.game}`)}>Play {game}</Button>
        <Button size="lg" href={appHref(practiceHref(win.game))}>Practice free</Button>
        <Button size="lg" href="/welcome">How it works</Button>
      </div>
      <p className="win-note">Test mode: Gemas come from simulated yield and have no real value.</p>
    </main>
  );
}
