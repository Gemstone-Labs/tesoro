import type { Metadata } from "next";
import { Backing } from "@/components/landing/Backing";
import { FinalCta } from "@/components/landing/FinalCta";
import { Footer } from "@/components/landing/Footer";
import { Gemas } from "@/components/landing/Gemas";
import { Games } from "@/components/landing/Games";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LandingMotion } from "@/components/landing/LandingMotion";
import { Multichain } from "@/components/landing/Multichain";
import { Nav } from "@/components/landing/Nav";
import { Principal } from "@/components/landing/Principal";
import { Studios } from "@/components/landing/Studios";

export const metadata: Metadata = {
  title: "Tesoro · Play now with yield you haven't earned yet",
  alternates: { canonical: "/" },
};

export default function Welcome() {
  return (
    <div className="lp">
      <a className="lp-skip" href="#how-it-works">
        Skip to content
      </a>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Gemas />
        <Principal />
        <Games />
        <Backing />
        <Multichain />
        <Studios />
        <FinalCta />
      </main>
      <Footer />
      <LandingMotion />
    </div>
  );
}
