import { Barlow_Condensed, IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";

// Same three faces as src/app/layout.tsx.
const schibsted = Schibsted_Grotesk({ subsets: ["latin"], weight: ["400", "700", "800", "900"], variable: "--font-schibsted", display: "swap" });
const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-display", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const FONT_CLASSES = [schibsted.variable, barlow.variable, plexMono.variable];
