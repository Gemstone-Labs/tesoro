import type { Metadata } from "next";
import { Backing } from "@/components/landing/Backing";
import { FinalCta } from "@/components/landing/FinalCta";
import { Footer } from "@/components/landing/Footer";
import { Gemas } from "@/components/landing/Gemas";
import { Games } from "@/components/landing/Games";
import { XStrip } from "@/components/brand";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LandingMotion } from "@/components/landing/LandingMotion";
import { Multichain } from "@/components/landing/Multichain";
import { Nav } from "@/components/landing/Nav";
import { Studios } from "@/components/landing/Studios";

export const metadata: Metadata = {
  title: "Tesoro · Play now with yield you haven't earned yet",
  alternates: { canonical: "/welcome" },
};

export default function Welcome() {
  return (
    <div className="lp">
      <a className="lp-skip" href="#how-it-works">
        Skip to content
      </a>
      <Nav />
      <div className="lp-strip">
        <XStrip />
      </div>
      <main>
        <Hero />
        <HowItWorks />
        <Games />
        <Gemas />
        <Backing />
        <Studios />
        <Multichain />
        <FinalCta />
      </main>
      <Footer />
      <LandingMotion />
    </div>
  );
}
